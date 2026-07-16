/**
 * EmergencyExport — one-click offline backup of playlist metadata.
 *
 * Motivation: asmr.one has had multi-day outages; users need their playlists
 * (name, description, privacy, RJ codes, titles) preserved somewhere the site
 * can't take down. This gathers:
 *
 *   • ownPlaylists    — the logged-in user's playlists with every work
 *   • publicPlaylists — community/global playlists surfaced by Playlist
 *                       Discovery (maintained server catalog + manual IDs)
 *
 * The two groups are kept in separate top-level sections (and separate files
 * for CSV/TXT) so a user restoring their own data can't confuse community
 * playlists with theirs. The latest JSON snapshot is also persisted to script
 * storage under its own key, independent of the StoreBackup feature.
 *
 * Downloads: JSON (canonical, restorable), CSV (spreadsheets), TXT (plain
 * RJ-code lists grouped per playlist).
 */

import { I18n, Logger } from '../core/Utils';
import { GM_setValue } from '$';
import { apiRequest } from './playlist/PlaylistService';
import { PlaylistDiscoveryService } from './playlist/PlaylistDiscoveryService';
import { runRollingPool } from '../core/PacedBatch';
import type { PlaylistEntry, PlaylistMetadata, PlaylistWorkItem, PlaylistWorksResponse } from '../api/Playlist';

const EMERGENCY_EXPORT_STORAGE_KEY = 'asmr-ult:emergency-export';
const WORKS_PAGE_SIZE = 100;
const COMPAT_WORKS_PAGE_SIZE = 20;
/** Small bounded batches reduce wall time without turning export into a request storm. */
const OWN_FETCH_BATCH_SIZE = 3;
const PUBLIC_FETCH_BATCH_SIZE = 3;
const OWN_FETCH_START_INTERVAL_MS = 25;
const PUBLIC_FETCH_START_INTERVAL_MS = 75;

// ---------------------------------------------------------------------------
// Export document shape
// ---------------------------------------------------------------------------

export interface ExportedWork {
    rjCode: string;
    title: string;
    sizeBytes?: number;
    durationSeconds?: number;
}

export interface ExportedPlaylist {
    id: string;
    name: string;
    description: string;
    privacy?: number;
    userName?: string;
    worksCount: number;
    works: ExportedWork[];
    error?: string; // present when this playlist could not be fully fetched
}

export interface EmergencyExportDocument {
    format: 'asmr-one-ultimate-playlist-backup';
    version: 1;
    exportedAt: string;
    source: string;
    /** The logged-in user's playlists. */
    ownPlaylists: ExportedPlaylist[];
    /** Community/global playlists from Playlist Discovery — NOT the user's own. */
    publicPlaylists: ExportedPlaylist[];
    errors: string[];
}

interface ExportProgress {
    stage: 'own' | 'public' | 'done';
    done: number;
    total: number;
    label: string;
}

type ProgressCallback = (p: ExportProgress) => void;

// ---------------------------------------------------------------------------
// Data gathering
// ---------------------------------------------------------------------------

function toRjCode(raw: unknown): string {
    if (typeof raw === 'string' && /^[A-Za-z]{2}\d+$/.test(raw.trim())) return raw.trim().toUpperCase();
    if (typeof raw === 'number' && Number.isFinite(raw)) return `RJ${String(raw).padStart(6, '0')}`;
    if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) return `RJ${raw.trim().padStart(6, '0')}`;
    return typeof raw === 'string' ? raw.trim() : '';
}

function workItemToExported(item: PlaylistWorkItem | Record<string, unknown>): ExportedWork {
    const record = item as Record<string, unknown>;
    const result: ExportedWork = {
        rjCode: toRjCode(record.source_id ?? record.sourceId ?? record.id),
        title: typeof record.title === 'string' ? record.title : '',
    };
    const size = [record.sizeBytes, record.size, record.file_size, record.filesize, record.total_size]
        .map(Number).find(value => Number.isSafeInteger(value) && value > 0);
    const duration = [record.durationSeconds, record.duration]
        .map(Number).find(value => Number.isFinite(value) && value > 0);
    if (size !== undefined) result.sizeBytes = size;
    if (duration !== undefined) result.durationSeconds = duration;
    return result;
}

async function fetchAllWorks(
    playlistId: string,
    firstPage?: PlaylistWorksResponse,
    pageSize = WORKS_PAGE_SIZE,
): Promise<ExportedWork[]> {
    const works: ExportedWork[] = [];
    let page = 1;
    for (;;) {
        const res = page === 1 && firstPage
            ? firstPage
            : await apiRequest<PlaylistWorksResponse>('/api/playlist/get-playlist-works', {
                id: playlistId,
                page,
                pageSize,
            });
        const items = Array.isArray(res?.works) ? res.works : [];
        works.push(...items.map(workItemToExported));
        const total = res?.pagination?.totalCount;
        if (!items.length) break;
        if (typeof total === 'number' ? works.length >= total : items.length < pageSize) break;
        page += 1;
    }
    return works;
}

async function fetchFirstWorks(id: string): Promise<{ response: PlaylistWorksResponse; pageSize: number }> {
    try {
        return {
            response: await apiRequest<PlaylistWorksResponse>('/api/playlist/get-playlist-works', {
                id, page: 1, pageSize: WORKS_PAGE_SIZE,
            }),
            pageSize: WORKS_PAGE_SIZE,
        };
    } catch (error) {
        if (!isWorksPageSizeCompatibilityError(error)) throw error;
        Logger.warn('[EmergencyExport] Works page size 100 failed; retrying compatibility size 20', id, error);
        return {
            response: await apiRequest<PlaylistWorksResponse>('/api/playlist/get-playlist-works', {
                id, page: 1, pageSize: COMPAT_WORKS_PAGE_SIZE,
            }),
            pageSize: COMPAT_WORKS_PAGE_SIZE,
        };
    }
}

function readHttpStatus(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const candidate = error as { status?: unknown; response?: { status?: unknown }; message?: unknown };
    if (typeof candidate.status === 'number') return candidate.status;
    if (typeof candidate.response?.status === 'number') return candidate.response.status;
    if (typeof candidate.message === 'string') {
        const match = candidate.message.match(/\bHTTP\s+(\d{3})\b/i);
        if (match) return Number(match[1]);
    }
    return undefined;
}

function isWorksPageSizeCompatibilityError(error: unknown): boolean {
    const status = readHttpStatus(error);
    return status === 400 || status === 404 || status === 422;
}

export async function fetchPlaylistAsExported(id: string, seed?: PlaylistEntry): Promise<ExportedPlaylist> {
    // Metadata and page one are independent. Starting them together removes a
    // full network round-trip from every playlist in Drive/local exports.
    // Keep fetching authoritative metadata: listing/discovery seeds can be
    // stale or omit description/privacy, and a backup must not silently lose
    // those fields. The seed remains a fallback when that request fails.
    const seedWorks = Array.isArray(seed?.works) ? seed.works : [];
    const seedWorkCount = seed?.works_count ?? seed?.worksCount;
    // The authenticated playlist listing often already contains the complete
    // work-ID array. Trust it only when its declared count agrees; this removes
    // one request per personal playlist without risking a truncated backup.
    const listingLooksComplete = typeof seedWorkCount === 'number'
        && seedWorkCount >= 0
        && seedWorks.length >= seedWorkCount;
    const worksRequest = listingLooksComplete
        ? Promise.resolve({ value: undefined, error: null as unknown })
        : fetchFirstWorks(id).then(value => ({ value, error: null as unknown }))
            .catch(error => ({ value: undefined, error }));
    const metadataRequest = apiRequest<PlaylistMetadata>('/api/playlist/get-playlist-metadata', { id })
        .then(value => ({ value, error: null as unknown }))
        .catch(error => ({ value: undefined, error }));
    const [metadata, firstWorks] = await Promise.all([
        metadataRequest,
        worksRequest,
    ]);
    const meta = metadata.value;
    // The listing can be stale (notably works_count=0 while metadata says the
    // playlist has works). Skip the paged endpoint only after comparing the
    // embedded array with the authoritative count.
    const authoritativeWorkCount = meta?.works_count ?? seedWorkCount;
    const expectedWorkCount = typeof authoritativeWorkCount === 'number'
        && Number.isSafeInteger(authoritativeWorkCount)
        && authoritativeWorkCount >= 0
        ? authoritativeWorkCount
        : undefined;
    const completeSeedWorks = Boolean(seed) && typeof authoritativeWorkCount === 'number'
        && authoritativeWorkCount >= 0
        && seedWorks.length >= authoritativeWorkCount;
    const base: ExportedPlaylist = {
        id,
        name: meta?.name || seed?.name || I18n.t('emergencyUnknownPlaylist'),
        description: meta?.description || seed?.description || '',
        privacy: meta?.privacy ?? seed?.privacy,
        userName: meta?.user_name || seed?.user_name,
        worksCount: meta?.works_count ?? seed?.works_count ?? seed?.worksCount
            ?? (Array.isArray(meta?.works) ? meta.works.length : 0),
        works: [],
    };
    try {
        if (completeSeedWorks) {
            base.works = seedWorks.map((work) => typeof work === 'string'
                ? { rjCode: toRjCode(work), title: '' }
                : workItemToExported(work));
        } else {
            const firstPage = listingLooksComplete
                ? await fetchFirstWorks(id)
                : firstWorks.value;
            if (!firstPage) throw firstWorks.error || new Error('Playlist works could not be loaded');
            base.works = await fetchAllWorks(id, firstPage.response, firstPage.pageSize);
        }
        if (!base.works.length && (Array.isArray(meta?.works) || Array.isArray(seed?.works))) {
            // Fallback: metadata sometimes embeds the work list directly.
            const embeddedWorks = meta?.works?.length ? meta.works : (seed?.works || []);
            base.works = embeddedWorks.map((w) => typeof w === 'string'
                ? { rjCode: toRjCode(w), title: '' }
                : workItemToExported(w));
        }
        base.worksCount = Math.max(base.works.length, base.worksCount);
        if (expectedWorkCount !== undefined && base.works.length < expectedWorkCount) {
            base.error = I18n.format('emergencyIncompleteWorks', {
                loaded: base.works.length,
                expected: expectedWorkCount,
            });
        }
    } catch (error) {
        const embeddedWorks = meta?.works?.length ? meta.works : (seed?.works || []);
        base.works = embeddedWorks.map((w) => typeof w === 'string'
            ? { rjCode: toRjCode(w), title: '' }
            : workItemToExported(w));
        base.worksCount = Math.max(base.works.length, base.worksCount);
        const hasEmbeddedFallback = Array.isArray(meta?.works) || Array.isArray(seed?.works);
        const fallbackIsComplete = expectedWorkCount !== undefined
            && base.works.length >= expectedWorkCount
            && (expectedWorkCount > 0 || hasEmbeddedFallback);
        if (!fallbackIsComplete) base.error = (error as Error)?.message || String(error);
    }
    if (metadata.error && !seed && !base.error) {
        base.error = (metadata.error as Error)?.message || String(metadata.error);
    }
    return base;
}

interface PlaylistListLike {
    playlists?: PlaylistEntry[];
    pagination?: { currentPage: number; pageSize: number; totalCount: number };
}

/** Fetch the logged-in user's playlists, tolerating both API response shapes. */
export async function fetchOwnPlaylistEntries(): Promise<PlaylistEntry[]> {
    const entries: PlaylistEntry[] = [];
    let page = 1;
    for (;;) {
        const res = await apiRequest<PlaylistListLike | PlaylistEntry[]>('/api/playlist/get-playlists', {
            page,
            pageSize: WORKS_PAGE_SIZE,
            filterBy: 'all',
        });
        const list = Array.isArray(res) ? res : (Array.isArray(res?.playlists) ? res.playlists : []);
        entries.push(...list);
        const paged = Array.isArray(res) ? undefined : res?.pagination;
        const total = paged?.totalCount ?? entries.length;
        if (!list.length || entries.length >= total) break;
        page += 1;
    }
    return entries;
}

/**
 * Build the full export document. Failures on individual playlists are
 * recorded, never fatal — a partial backup beats no backup in an emergency.
 */
export async function buildEmergencyExport(onProgress?: ProgressCallback): Promise<EmergencyExportDocument> {
    const doc: EmergencyExportDocument = {
        format: 'asmr-one-ultimate-playlist-backup',
        version: 1,
        exportedAt: new Date().toISOString(),
        source: location.origin,
        ownPlaylists: [],
        publicPlaylists: [],
        errors: [],
    };

    // --- Own playlists (requires login; skipped gracefully otherwise) ------
    let ownEntries: PlaylistEntry[] = [];
    try {
        ownEntries = await fetchOwnPlaylistEntries();
    } catch (error) {
        const detail = error instanceof Error ? error.message : 'Unknown request error';
        Logger.warn('[EmergencyExport] Could not list own playlists', detail);
        doc.errors.push(I18n.t('emergencyOwnListUnavailable'));
    }
    let ownCompleted = 0;
    const ownResults = await runRollingPool(
        ownEntries,
        async (entry) => {
            try {
                return await fetchPlaylistAsExported(entry.id, entry);
            } finally {
                ownCompleted += 1;
                onProgress?.({ stage: 'own', done: ownCompleted, total: ownEntries.length, label: entry.name || entry.id });
            }
        },
        { concurrency: OWN_FETCH_BATCH_SIZE, minStartIntervalMs: OWN_FETCH_START_INTERVAL_MS },
    );
    ownResults.forEach((result, i) => {
        const entry = ownEntries[i];
        if (result.status === 'fulfilled') {
            const exported = result.value;
            // Prefer the authoritative listing's name/privacy for own playlists.
            exported.name = entry.name || exported.name;
            if (typeof entry.privacy === 'number') exported.privacy = entry.privacy;
            doc.ownPlaylists.push(exported);
        } else {
            doc.ownPlaylists.push({
                id: entry.id,
                name: entry.name || I18n.t('emergencyUnknownPlaylist'),
                description: entry.description || '',
                privacy: entry.privacy,
                worksCount: entry.works_count ?? entry.worksCount ?? 0,
                works: [],
                error: result.reason instanceof Error ? result.reason.message : String(result.reason),
            });
        }
    });

    // --- Public/community playlists from discovery --------------------------
    const discovery = PlaylistDiscoveryService.getInstance();
    const allPublicIds = (await discovery.getDiscoveredIdsAsync())
        .filter((id) => !doc.ownPlaylists.some((p) => p.id.toLowerCase() === id.toLowerCase()));
    // The rolling pool bounds request pressure while allowing every discovered
    // playlist to be represented; large collections must not be silently cut.
    const publicIds = allPublicIds;
    let publicCompleted = 0;
    const publicResults = await runRollingPool(
        publicIds,
        async (id) => {
            try {
                return await fetchPlaylistAsExported(id);
            } finally {
                publicCompleted += 1;
                onProgress?.({ stage: 'public', done: publicCompleted, total: publicIds.length, label: id });
            }
        },
        { concurrency: PUBLIC_FETCH_BATCH_SIZE, minStartIntervalMs: PUBLIC_FETCH_START_INTERVAL_MS },
    );
    publicResults.forEach((result, i) => {
        const id = publicIds[i];
        if (result.status === 'fulfilled') {
            doc.publicPlaylists.push(result.value);
        } else {
            const cached = discovery.getCachedMetadata(id);
            doc.publicPlaylists.push({
                id,
                name: cached?.name || I18n.t('emergencyUnknownPlaylist'),
                description: '',
                userName: cached?.user_name,
                worksCount: cached?.worksCount ?? 0,
                works: [],
                error: result.reason instanceof Error ? result.reason.message : String(result.reason),
            });
        }
    });

    onProgress?.({ stage: 'done', done: 1, total: 1, label: '' });

    // Keep an on-device copy under its own key (separate from StoreBackup).
    try {
        GM_setValue(EMERGENCY_EXPORT_STORAGE_KEY, JSON.stringify(doc));
    } catch (error) {
        Logger.debug('[EmergencyExport] Could not persist snapshot to script storage', error);
    }

    return doc;
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

function csvEscape(value: string): string {
    return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function exportToCsv(playlists: ExportedPlaylist[]): string {
    const rows = ['playlist_id,playlist_name,rj_code,title'];
    for (const p of playlists) {
        if (!p.works.length) {
            rows.push([p.id, csvEscape(p.name), '', ''].join(','));
            continue;
        }
        for (const w of p.works) {
            rows.push([p.id, csvEscape(p.name), w.rjCode, csvEscape(w.title)].join(','));
        }
    }
    return rows.join('\n');
}

function exportToTxt(playlists: ExportedPlaylist[]): string {
    return playlists.map((p) => {
        const header = `# ${p.name} (${p.works.length} works)${p.userName ? ` — by ${p.userName}` : ''}`;
        return [header, ...p.works.map((w) => w.title ? `${w.rjCode}\t${w.title}` : w.rjCode)].join('\n');
    }).join('\n\n');
}

// ---------------------------------------------------------------------------
// Download plumbing
// ---------------------------------------------------------------------------

function timestampSlug(iso: string): string {
    return iso.replace(/[:T]/g, '-').slice(0, 19);
}

function downloadTextFile(filename: string, content: string, mime: string): void {
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export type ExportFormat = 'json' | 'csv' | 'txt';

/**
 * Build the export and trigger downloads in the requested format.
 * JSON is one combined file; CSV/TXT download own and public playlists as
 * separate files so the groups cannot be mixed up.
 */
export async function runEmergencyExport(format: ExportFormat, onProgress?: ProgressCallback): Promise<EmergencyExportDocument> {
    const doc = await buildEmergencyExport(onProgress);
    const stamp = timestampSlug(doc.exportedAt);

    if (format === 'json') {
        downloadTextFile(`asmr-playlists-backup-${stamp}.json`, JSON.stringify(doc, null, 2), 'application/json');
    } else if (format === 'csv') {
        if (doc.ownPlaylists.length) downloadTextFile(`asmr-playlists-own-${stamp}.csv`, exportToCsv(doc.ownPlaylists), 'text/csv');
        if (doc.publicPlaylists.length) downloadTextFile(`asmr-playlists-public-${stamp}.csv`, exportToCsv(doc.publicPlaylists), 'text/csv');
    } else {
        if (doc.ownPlaylists.length) downloadTextFile(`asmr-playlists-own-${stamp}.txt`, exportToTxt(doc.ownPlaylists), 'text/plain');
        if (doc.publicPlaylists.length) downloadTextFile(`asmr-playlists-public-${stamp}.txt`, exportToTxt(doc.publicPlaylists), 'text/plain');
    }

    Logger.info(`[EmergencyExport] Exported ${doc.ownPlaylists.length} own + ${doc.publicPlaylists.length} public playlists as ${format}`);
    return doc;
}
