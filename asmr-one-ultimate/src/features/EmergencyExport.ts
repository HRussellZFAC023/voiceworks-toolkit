/**
 * EmergencyExport — one-click offline backup of playlist metadata.
 *
 * Motivation: asmr.one has had multi-day outages; users need their playlists
 * (name, description, privacy, RJ codes, titles) preserved somewhere the site
 * can't take down. This gathers:
 *
 *   • ownPlaylists    — the logged-in user's playlists with every work
 *   • publicPlaylists — community/global playlists surfaced by Playlist
 *                       Discovery (known seed list + discovered/manual IDs)
 *
 * The two groups are kept in separate top-level sections (and separate files
 * for CSV/TXT) so a user restoring their own data can't confuse community
 * playlists with theirs. The latest JSON snapshot is also persisted to script
 * storage under its own key, independent of the StoreBackup feature.
 *
 * Downloads: JSON (canonical, restorable), CSV (spreadsheets), TXT (plain
 * RJ-code lists grouped per playlist).
 */

import { Logger } from '../core/Utils';
import { GM_setValue } from '$';
import { apiRequest } from './playlist/PlaylistService';
import { PlaylistDiscoveryService } from './playlist/PlaylistDiscoveryService';
import type { PlaylistEntry, PlaylistMetadata, PlaylistWorkItem, PlaylistWorksResponse } from '../api/Playlist';

export const EMERGENCY_EXPORT_STORAGE_KEY = 'asmr-ult:emergency-export';
const WORKS_PAGE_SIZE = 100;
/** Soft cap so a huge discovery cache can't turn an export into an API hammer. */
const MAX_PUBLIC_PLAYLISTS = 200;
/** Pause between community-playlist fetches — an export must never look like a request storm. */
const PUBLIC_FETCH_PACING_MS = 50;

// ---------------------------------------------------------------------------
// Export document shape
// ---------------------------------------------------------------------------

export interface ExportedWork {
    rjCode: string;
    title: string;
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

export interface ExportProgress {
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
    return {
        rjCode: toRjCode(record.source_id ?? record.sourceId ?? record.id),
        title: typeof record.title === 'string' ? record.title : '',
    };
}

async function fetchAllWorks(playlistId: string): Promise<ExportedWork[]> {
    const works: ExportedWork[] = [];
    let page = 1;
    for (;;) {
        const res = await apiRequest<PlaylistWorksResponse>('/api/playlist/get-playlist-works', {
            id: playlistId,
            page,
            pageSize: WORKS_PAGE_SIZE,
        });
        const items = Array.isArray(res?.works) ? res.works : [];
        works.push(...items.map(workItemToExported));
        const total = res?.pagination?.totalCount ?? works.length;
        if (!items.length || works.length >= total) break;
        page += 1;
    }
    return works;
}

async function fetchPlaylistAsExported(id: string): Promise<ExportedPlaylist> {
    const meta = await apiRequest<PlaylistMetadata>('/api/playlist/get-playlist-metadata', { id });
    const base: ExportedPlaylist = {
        id,
        name: meta?.name || 'Unknown Playlist',
        description: meta?.description || '',
        privacy: meta?.privacy,
        userName: meta?.user_name,
        worksCount: meta?.works_count ?? (Array.isArray(meta?.works) ? meta.works.length : 0),
        works: [],
    };
    try {
        base.works = await fetchAllWorks(id);
        if (!base.works.length && Array.isArray(meta?.works)) {
            // Fallback: metadata sometimes embeds the work list directly.
            base.works = meta.works.map((w) => typeof w === 'string'
                ? { rjCode: toRjCode(w), title: '' }
                : workItemToExported(w));
        }
        base.worksCount = base.works.length || base.worksCount;
    } catch (error) {
        base.error = (error as Error)?.message || String(error);
    }
    return base;
}

interface PlaylistListLike {
    playlists?: PlaylistEntry[];
    pagination?: { currentPage: number; pageSize: number; totalCount: number };
}

/** Fetch the logged-in user's playlists, tolerating both API response shapes. */
async function fetchOwnPlaylistEntries(): Promise<PlaylistEntry[]> {
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
        const msg = `Could not list own playlists (not logged in?): ${(error as Error)?.message || error}`;
        Logger.warn(`[EmergencyExport] ${msg}`);
        doc.errors.push(msg);
    }
    for (let i = 0; i < ownEntries.length; i++) {
        const entry = ownEntries[i];
        onProgress?.({ stage: 'own', done: i, total: ownEntries.length, label: entry.name || entry.id });
        try {
            const exported = await fetchPlaylistAsExported(entry.id);
            // Prefer the authoritative listing's name/privacy for own playlists.
            exported.name = entry.name || exported.name;
            if (typeof entry.privacy === 'number') exported.privacy = entry.privacy;
            doc.ownPlaylists.push(exported);
        } catch (error) {
            doc.ownPlaylists.push({
                id: entry.id,
                name: entry.name || 'Unknown Playlist',
                description: entry.description || '',
                privacy: entry.privacy,
                worksCount: entry.works_count ?? entry.worksCount ?? 0,
                works: [],
                error: (error as Error)?.message || String(error),
            });
        }
    }

    // --- Public/community playlists from discovery --------------------------
    const discovery = PlaylistDiscoveryService.getInstance();
    const allPublicIds = discovery.getDiscoveredIds()
        .filter((id) => !doc.ownPlaylists.some((p) => p.id.toLowerCase() === id));
    const publicIds = allPublicIds.slice(0, MAX_PUBLIC_PLAYLISTS);
    if (allPublicIds.length > publicIds.length) {
        doc.errors.push(`Public playlist export capped at ${MAX_PUBLIC_PLAYLISTS} of ${allPublicIds.length} discovered playlists.`);
    }
    for (let i = 0; i < publicIds.length; i++) {
        if (i) await new Promise((r) => setTimeout(r, PUBLIC_FETCH_PACING_MS));
        const id = publicIds[i];
        onProgress?.({ stage: 'public', done: i, total: publicIds.length, label: id });
        try {
            doc.publicPlaylists.push(await fetchPlaylistAsExported(id));
        } catch (error) {
            const cached = discovery.getCachedMetadata(id);
            doc.publicPlaylists.push({
                id,
                name: cached?.name || 'Unknown Playlist',
                description: '',
                userName: cached?.user_name,
                worksCount: cached?.worksCount ?? 0,
                works: [],
                error: (error as Error)?.message || String(error),
            });
        }
    }

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

export function exportToCsv(playlists: ExportedPlaylist[]): string {
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

export function exportToTxt(playlists: ExportedPlaylist[]): string {
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

export function downloadTextFile(filename: string, content: string, mime: string): void {
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
