import { DEFAULT_API_PROXY } from '../../core/Constants';

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_WORKS = 10_000;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export interface CommunityPlaylistWork {
    rjCode: string;
    title: string;
    sizeBytes?: number;
    durationSeconds?: number;
}

export interface CommunityPlaylistDetails {
    version: 1;
    fetchedAt: string;
    works: CommunityPlaylistWork[];
}

const requests = new Map<string, Promise<CommunityPlaylistDetails>>();

function positiveNumber(value: unknown, integer = false): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
    return integer && !Number.isSafeInteger(value) ? undefined : value;
}

function parseDetails(value: unknown): CommunityPlaylistDetails {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid playlist cache');
    const record = value as Record<string, unknown>;
    if (record.version !== 1 || typeof record.fetchedAt !== 'string'
        || !Number.isFinite(Date.parse(record.fetchedAt)) || !Array.isArray(record.works)
        || record.works.length > MAX_WORKS) throw new Error('Invalid playlist cache');
    const works = record.works.map(candidate => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('Invalid cached work');
        const work = candidate as Record<string, unknown>;
        if (typeof work.rjCode !== 'string' || !/^[A-Z]{2}\d+$/.test(work.rjCode)
            || typeof work.title !== 'string' || work.title.length > 1024) throw new Error('Invalid cached work');
        return {
            rjCode: work.rjCode,
            title: work.title,
            sizeBytes: positiveNumber(work.sizeBytes, true),
            durationSeconds: positiveNumber(work.durationSeconds),
        };
    });
    return { version: 1, fetchedAt: record.fetchedAt, works };
}

async function readBoundedJson(response: Response): Promise<unknown> {
    const declared = response.headers.get('content-length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) throw new Error('Playlist cache is too large');
    if (!response.body) throw new Error('Playlist cache body is missing');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('Playlist cache is too large'); }
        chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}

/** Fast, shared public-playlist expansion; callers may fall back to the live authenticated API. */
export function fetchCachedCommunityPlaylist(id: string): Promise<CommunityPlaylistDetails> {
    const normalized = id.trim().toLowerCase();
    if (!UUID_PATTERN.test(normalized)) return Promise.reject(new Error('Invalid playlist id'));
    const existing = requests.get(normalized);
    if (existing) return existing;
    const request = fetch(`${DEFAULT_API_PROXY}/community-playlists/${normalized}.json`, {
        headers: { Accept: 'application/json' }, credentials: 'omit',
    }).then(async response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        return parseDetails(await readBoundedJson(response));
    }).catch(error => { requests.delete(normalized); throw error; });
    requests.set(normalized, request);
    return request;
}
