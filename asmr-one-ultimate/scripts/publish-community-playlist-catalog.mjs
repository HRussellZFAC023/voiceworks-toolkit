import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DEFAULT_PROXY = 'https://asmr-api-proxy.henry-robert-christopher-russell.workers.dev';
const DEFAULT_BUCKET = 'asmr-semantic-index';
const CATALOG_KEY = 'community-playlists/catalog.json';
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_PLAYLISTS = 5000;
const MAX_TAGS = 128;
const DEFAULT_MINIMUM_COVERAGE = 0.8;
const DEFAULT_ABSOLUTE_MINIMUM = 450;
const WRANGLER_VERSION = '4.111.0';

class HttpStatusError extends Error {
    constructor(status, message, retryAfterMs = 0) {
        super(message);
        this.status = status;
        this.retryAfterMs = retryAfterMs;
    }
}

class PlaylistExclusionError extends Error {
    constructor(reason, message) {
        super(message);
        this.reason = reason;
    }
}

function hash(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

function compactString(value, maximumLength) {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, maximumLength) : '';
}

function compactUrl(value) {
    if (typeof value !== 'string' || value.length > 2048) return '';
    try {
        const url = new URL(value);
        return url.protocol === 'https:' ? url.href : '';
    } catch { return ''; }
}

function nonNegativeInteger(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function readCoverUrl(value) {
    if (!value || typeof value !== 'object') return '';
    for (const key of ['coverUrl', 'cover', 'main_cover_url', 'mainCoverUrl', 'thumbnailCoverUrl', 'samCoverUrl']) {
        if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
    }
    return '';
}

function normalizeWorkId(value) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (/^[A-Za-z]{2}\d+$/.test(trimmed)) return trimmed.toUpperCase();
    if (/^\d+$/.test(trimmed)) return Number(trimmed);
    return undefined;
}

function collectTagNames(value) {
    const tags = new Map();
    const visit = (candidate) => {
        if (tags.size >= MAX_TAGS || candidate === null || candidate === undefined) return;
        if (typeof candidate === 'string') {
            const tag = compactString(candidate, 128);
            if (tag && !tags.has(tag.toLowerCase())) tags.set(tag.toLowerCase(), tag);
            return;
        }
        if (Array.isArray(candidate)) {
            for (const item of candidate) visit(item);
            return;
        }
        if (typeof candidate !== 'object') return;
        for (const key of ['name', 'title', 'ja', 'en', 'name_ja', 'name_en']) visit(candidate[key]);
        for (const key of ['tags', 'genres', 'tags_replaced', 'genres_replaced']) visit(candidate[key]);
    };
    visit(value);
    return Array.from(tags.values());
}

export function normalizeSeedList(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PLAYLISTS) {
        throw new Error('Seed document must be a non-empty array within the playlist limit');
    }
    const ids = [];
    const seen = new Set();
    for (const seed of value) {
        const id = typeof seed === 'string' ? seed : seed?.id;
        if (typeof id !== 'string' || !UUID.test(id)) throw new Error(`Invalid community playlist UUID: ${String(id)}`);
        if (typeof seed === 'object' && seed !== null
            && (Array.isArray(seed) || !Object.keys(seed).every((key) => key === 'id'))) {
            throw new Error(`Unexpected community playlist seed field: ${id}`);
        }
        if (!seen.has(id)) {
            seen.add(id);
            ids.push(id);
        }
    }
    return ids;
}

function isSummary(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || !UUID.test(value.id) || typeof value.name !== 'string' || !value.name || value.name.length > 512
        || typeof value.userName !== 'string' || value.userName.length > 256
        || !Number.isSafeInteger(value.worksCount) || value.worksCount < 0
        || typeof value.coverUrl !== 'string' || value.coverUrl.length > 2048
        || !Array.isArray(value.tags) || value.tags.length > MAX_TAGS
        || value.tags.some((tag) => typeof tag !== 'string' || !tag || tag.length > 128)) return false;
    if (value.latestWorkId !== undefined
        && !(typeof value.latestWorkId === 'string' && /^[A-Z]{2}\d+$/.test(value.latestWorkId))
        && !(Number.isSafeInteger(value.latestWorkId) && value.latestWorkId > 0)) return false;
    const allowed = new Set(['id', 'name', 'userName', 'worksCount', 'coverUrl', 'tags', 'latestWorkId']);
    return Object.keys(value).every((key) => allowed.has(key));
}

export function validateCatalog(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || value.version !== 1 || typeof value.generatedAt !== 'string'
        || !Number.isFinite(Date.parse(value.generatedAt))
        || !Array.isArray(value.playlists) || value.playlists.length === 0
        || value.playlists.length > MAX_PLAYLISTS) throw new Error('Invalid community playlist catalog');
    const seen = new Set();
    for (const playlist of value.playlists) {
        if (!isSummary(playlist) || seen.has(playlist.id)) throw new Error('Invalid or duplicate community playlist summary');
        seen.add(playlist.id);
    }
    if (!Object.keys(value).every((key) => ['version', 'generatedAt', 'playlists'].includes(key))) {
        throw new Error('Unexpected community playlist catalog field');
    }
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > MAX_CATALOG_BYTES) throw new Error('Community playlist catalog exceeds its size limit');
    return value;
}

async function readBoundedResponseJson(response, maximumBytes = MAX_RESPONSE_BYTES) {
    const declared = response.headers.get('content-length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) throw new Error('Response exceeds size limit');
    if (!response.body) throw new Error('Response body is missing');
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maximumBytes) {
                await reader.cancel();
                throw new Error('Response exceeds size limit');
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

async function fetchJsonWithRetry(url, options) {
    const attempts = options.attempts ?? 5;
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
        try {
            const response = await options.fetchImpl(url, {
                headers: { Accept: 'application/json', 'Accept-Language': 'ja' },
                signal: controller.signal,
            });
            if (!response.ok) {
                const retryAfter = response.headers.get('Retry-After');
                const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter)
                    ? Math.min(60_000, Number(retryAfter) * 1000)
                    : 0;
                throw new HttpStatusError(response.status, `HTTP ${response.status}: ${url}`, retryAfterMs);
            }
            return await readBoundedResponseJson(response);
        } catch (error) {
            lastError = error;
            const status = error instanceof HttpStatusError ? error.status : 0;
            if ((status > 0 && status < 500 && status !== 429) || attempt + 1 >= attempts) throw error;
            const backoff = Math.min(8000, 500 * (2 ** attempt));
            await options.delay(error instanceof HttpStatusError && error.retryAfterMs
                ? Math.max(backoff, error.retryAfterMs)
                : backoff);
        } finally {
            clearTimeout(timer);
        }
    }
    throw lastError;
}

async function hydrateVerifiedPlaylistSummary(id, options = {}) {
    if (!UUID.test(id)) throw new Error(`Invalid community playlist UUID: ${id}`);
    const fetchImpl = options.fetchImpl || fetch;
    const delay = options.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const proxy = (options.proxyBase || DEFAULT_PROXY).replace(/\/$/, '');
    let metadata;
    try {
        metadata = await fetchJsonWithRetry(`${proxy}/api/playlist/get-playlist-metadata?id=${encodeURIComponent(id)}`, {
            fetchImpl, delay, attempts: options.attempts, timeoutMs: options.timeoutMs,
        });
    } catch (error) {
        if (error instanceof HttpStatusError && [404, 410].includes(error.status)) {
            throw new PlaylistExclusionError('not-found', `Playlist no longer exists: ${id}`);
        }
        if (error instanceof HttpStatusError && [400, 422].includes(error.status)) {
            throw new PlaylistExclusionError('invalid', `Playlist metadata request is invalid: ${id}`);
        }
        throw error;
    }
    if (!metadata || typeof metadata !== 'object' || String(metadata.id || '').toLowerCase() !== id
        || typeof metadata.name !== 'string' || !metadata.name.trim() || metadata.name === 'Unknown Playlist') {
        throw new Error(`Playlist returned malformed metadata: ${id}`);
    }
    if (metadata.privacy !== 2) {
        if (metadata.privacy === 0 || metadata.privacy === 1) {
            throw new PlaylistExclusionError('private', `Playlist is not public: ${id}`);
        }
        throw new Error(`Playlist returned malformed privacy metadata: ${id}`);
    }

    let firstWork = Array.isArray(metadata.works) ? metadata.works[0] : undefined;
    const worksCount = nonNegativeInteger(metadata.works_count ?? metadata.worksCount);
    const metadataCover = readCoverUrl(metadata);
    if (!firstWork && !metadataCover && worksCount > 0) {
        try {
            const payload = await fetchJsonWithRetry(
                `${proxy}/api/playlist/get-playlist-works?id=${encodeURIComponent(id)}&page=1&pageSize=1`,
                { fetchImpl, delay, attempts: options.attempts, timeoutMs: options.timeoutMs },
            );
            firstWork = Array.isArray(payload?.works) ? payload.works[0] : undefined;
        } catch {
            // Names and counts are still valid when optional cover/tag hydration fails.
        }
    }
    const source = firstWork && typeof firstWork === 'object' ? firstWork : undefined;
    const summary = {
        id,
        name: compactString(metadata.name, 512),
        userName: compactString(metadata.user_name, 256),
        worksCount,
        coverUrl: compactUrl(metadataCover || readCoverUrl(source)),
        tags: collectTagNames([metadata.tags, metadata.genres, source?.tags, source?.genres]),
    };
    const latestWorkId = normalizeWorkId(source?.source_id ?? source?.id);
    if (latestWorkId !== undefined) summary.latestWorkId = latestWorkId;
    if (!isSummary(summary)) throw new Error(`Hydrated invalid playlist summary: ${id}`);
    return summary;
}

export async function hydratePlaylistSummary(id, options = {}) {
    try {
        return await hydrateVerifiedPlaylistSummary(id, options);
    } catch (error) {
        if (error instanceof PlaylistExclusionError) return null;
        throw error;
    }
}

async function atomicWrite(path, bytes) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
    try {
        await writeFile(temporary, bytes);
        await rename(temporary, path);
    } finally {
        await rm(temporary, { force: true });
    }
}

async function readCache(path) {
    try {
        const value = JSON.parse(await readFile(path, 'utf8'));
        if (value?.version !== 1 || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) {
            return { version: 1, entries: {} };
        }
        const entries = {};
        for (const [id, entry] of Object.entries(value.entries)) {
            if (!UUID.test(id) || !entry || typeof entry !== 'object' || !Number.isFinite(entry.fetchedAt)) continue;
            if (entry.status === 'ok' && isSummary(entry.summary) && entry.summary.id === id) entries[id] = entry;
            else if (entry.status === 'excluded' && ['not-found', 'private', 'invalid'].includes(entry.reason)) entries[id] = entry;
            else if (entry.status === 'missing') {
                entries[id] = { status: 'excluded', reason: 'not-found', fetchedAt: entry.fetchedAt };
            }
        }
        return { version: 1, entries };
    } catch { return { version: 1, entries: {} }; }
}

async function runBounded(items, worker, options) {
    const results = new Array(items.length);
    let nextIndex = 0;
    let nextStartAt = 0;
    const delay = options.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const runners = Array.from({ length: Math.min(options.concurrency, items.length) }, async () => {
        for (;;) {
            const index = nextIndex++;
            if (index >= items.length) return;
            const now = Date.now();
            const scheduledAt = Math.max(now, nextStartAt);
            nextStartAt = scheduledAt + options.startIntervalMs;
            if (scheduledAt > now) await delay(scheduledAt - now);
            try {
                results[index] = { ok: true, value: await worker(items[index], index) };
            } catch (error) {
                results[index] = { ok: false, error };
            }
        }
    });
    await Promise.all(runners);
    return results;
}

export async function buildCommunityPlaylistCatalog(options = {}) {
    const seedsPath = resolve(options.seedsPath || 'proxy-worker/data/community-playlist-seeds.json');
    const outputPath = resolve(options.outputPath || 'proxy-worker/.wrangler/community-playlists/catalog.json');
    const cachePath = resolve(options.cachePath || 'proxy-worker/.wrangler/community-playlists/build-cache.json');
    const ids = normalizeSeedList(JSON.parse(await readFile(seedsPath, 'utf8')));
    const cache = await readCache(cachePath);
    const now = options.now || Date.now;
    const nowMs = now();
    const cacheTtlMs = options.cacheTtlMs ?? 7 * 24 * 60 * 60 * 1000;
    const toHydrate = ids.filter((id) => {
        const entry = cache.entries[id];
        return !entry || !Number.isFinite(entry.fetchedAt) || nowMs - entry.fetchedAt >= cacheTtlMs;
    });
    let persistQueue = Promise.resolve();
    const persistCache = () => {
        persistQueue = persistQueue.then(() => atomicWrite(cachePath, `${JSON.stringify(cache, null, 2)}\n`));
        return persistQueue;
    };

    const results = await runBounded(toHydrate, async (id) => {
        try {
            const summary = await hydrateVerifiedPlaylistSummary(id, options);
            cache.entries[id] = { status: 'ok', fetchedAt: nowMs, summary };
            await persistCache();
            options.log?.(`[community-catalog] hydrated ${id}`);
            return id;
        } catch (error) {
            if (error instanceof PlaylistExclusionError) {
                cache.entries[id] = { status: 'excluded', reason: error.reason, fetchedAt: nowMs };
                await persistCache();
                options.log?.(`[community-catalog] excluded ${id} (${error.reason})`);
                return id;
            }
            options.log?.(`[community-catalog] transient failure ${id}: ${error instanceof Error ? error.message : error}`);
            throw error;
        }
    }, {
        concurrency: Math.max(1, Math.min(8, options.concurrency ?? 2)),
        startIntervalMs: Math.max(0, options.startIntervalMs ?? 250),
        delay: options.delay,
    });
    await persistQueue;
    const failures = results.filter((result) => !result.ok);
    if (failures.length) {
        const examples = results.flatMap((result, index) => result.ok ? [] : [
            `${toHydrate[index]}: ${result.error instanceof Error ? result.error.message : result.error}`,
        ]).slice(0, 5);
        throw new Error(`Could not hydrate ${failures.length} transient community playlist failure(s); successful progress is cached. ${examples.join('; ')}`);
    }

    const playlists = ids.flatMap((id) => cache.entries[id]?.status === 'ok' ? [cache.entries[id].summary] : []);
    const exclusions = ids.flatMap((id) => cache.entries[id]?.status === 'excluded'
        ? [{ id, reason: cache.entries[id].reason }]
        : []);
    const minimumCatalogSize = options.minimumCatalogSize
        ?? Math.max(DEFAULT_ABSOLUTE_MINIMUM, Math.ceil(ids.length * DEFAULT_MINIMUM_COVERAGE));
    if (!Number.isSafeInteger(minimumCatalogSize) || minimumCatalogSize < 1 || minimumCatalogSize > MAX_PLAYLISTS) {
        throw new Error(`Minimum playlist count must be an integer from 1 to ${MAX_PLAYLISTS}`);
    }
    if (playlists.length < minimumCatalogSize) {
        throw new Error(`Refusing to build a catalog with ${playlists.length}/${ids.length} playlists; minimum is ${minimumCatalogSize}`);
    }
    const exclusionReasons = exclusions.reduce((counts, exclusion) => {
        counts[exclusion.reason] = (counts[exclusion.reason] || 0) + 1;
        return counts;
    }, {});
    const catalog = validateCatalog({ version: 1, generatedAt: new Date(nowMs).toISOString(), playlists });
    const bytes = Buffer.from(`${JSON.stringify(catalog)}\n`);
    await atomicWrite(outputPath, bytes);
    const summary = {
        seedCount: ids.length,
        catalogCount: playlists.length,
        excludedCount: exclusions.length,
        exclusionReasons,
        minimumCatalogSize,
    };
    options.log?.(`[community-catalog] summary ${JSON.stringify(summary)}`);
    return { catalog, bytes, outputPath, cachePath, seedCount: ids.length, omittedCount: exclusions.length, exclusions, summary };
}

export async function publishCommunityPlaylistCatalog(options = {}) {
    const built = await buildCommunityPlaylistCatalog(options);
    const sha256 = hash(built.bytes);
    options.log?.(`[community-catalog] validated ${built.catalog.playlists.length}/${built.seedCount} playlists (${sha256})`);
    if (options.buildOnly) return { status: 'built', sha256, ...built };
    if (options.dryRun) return { status: 'dry-run', sha256, ...built };
    if (!options.putObject || !options.getObject) throw new Error('Publisher requires remote put/get operations');

    const immutableKey = `community-playlists/objects/${sha256}.json`;
    const immutable = {
        key: immutableKey, path: built.outputPath, bytes: built.bytes.byteLength, sha256,
        contentType: 'application/json', cacheControl: 'public, max-age=31536000, immutable',
    };
    await options.putObject(immutable);
    await verifyRemote(options.getObject, immutable);
    const canonical = {
        ...immutable, key: CATALOG_KEY, cacheControl: 'public, max-age=300, must-revalidate',
    };
    await options.putObject(canonical);
    await verifyRemote(options.getObject, canonical);
    options.log?.(`[community-catalog] published ${CATALOG_KEY} last and verified`);
    return { status: 'published', sha256, immutableKey, ...built };
}

async function verifyRemote(getObject, object) {
    const remote = await getObject(object.key);
    if (remote.byteLength !== object.bytes || hash(remote) !== object.sha256) {
        throw new Error(`Remote verification failed: ${object.key}`);
    }
}

export function createWranglerR2Operations(bucket) {
    const run = (args) => execFileAsync('npx', ['--yes', `wrangler@${WRANGLER_VERSION}`, ...args], { maxBuffer: 2 * 1024 * 1024 });
    return {
        async putObject(object) {
            await run([
                'r2', 'object', 'put', `${bucket}/${object.key}`, '--file', object.path, '--remote', '--force',
                '--content-type', object.contentType, '--cache-control', object.cacheControl,
            ]);
        },
        async getObject(key) {
            const directory = await mkdtemp(join(tmpdir(), 'community-catalog-r2-'));
            const path = join(directory, 'object');
            try {
                await run(['r2', 'object', 'get', `${bucket}/${key}`, '--file', path, '--remote']);
                return await readFile(path);
            } finally {
                await rm(directory, { recursive: true, force: true });
            }
        },
    };
}

function readValue(args, index, name) {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    return value;
}

export function parseCommunityPublisherArgs(args) {
    const options = {
        seedsPath: 'proxy-worker/data/community-playlist-seeds.json',
        outputPath: 'proxy-worker/.wrangler/community-playlists/catalog.json',
        cachePath: 'proxy-worker/.wrangler/community-playlists/build-cache.json',
        proxyBase: DEFAULT_PROXY,
        bucket: DEFAULT_BUCKET,
        concurrency: 2,
        startIntervalMs: 250,
        cacheTtlMs: 7 * 24 * 60 * 60 * 1000,
        minimumCatalogSize: undefined,
        dryRun: false,
        buildOnly: false,
    };
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === '--dry-run') options.dryRun = true;
        else if (argument === '--build-only') options.buildOnly = true;
        else if (['--seeds', '--output', '--cache', '--proxy', '--bucket', '--concurrency', '--start-interval-ms', '--cache-ttl-hours', '--min-playlists'].includes(argument)) {
            const value = readValue(args, index, argument);
            index += 1;
            if (argument === '--seeds') options.seedsPath = value;
            else if (argument === '--output') options.outputPath = value;
            else if (argument === '--cache') options.cachePath = value;
            else if (argument === '--proxy') options.proxyBase = value;
            else if (argument === '--bucket') options.bucket = value;
            else if (argument === '--concurrency') options.concurrency = Number(value);
            else if (argument === '--start-interval-ms') options.startIntervalMs = Number(value);
            else if (argument === '--cache-ttl-hours') options.cacheTtlMs = Number(value) * 60 * 60 * 1000;
            else options.minimumCatalogSize = Number(value);
        } else throw new Error(`Unknown option: ${argument}`);
    }
    if (options.dryRun && options.buildOnly) throw new Error('--dry-run and --build-only are mutually exclusive');
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8) throw new Error('--concurrency must be an integer from 1 to 8');
    if (!Number.isFinite(options.startIntervalMs) || options.startIntervalMs < 0 || options.startIntervalMs > 10_000) throw new Error('--start-interval-ms is out of range');
    if (!Number.isFinite(options.cacheTtlMs) || options.cacheTtlMs < 0) throw new Error('--cache-ttl-hours must be non-negative');
    if (options.minimumCatalogSize !== undefined
        && (!Number.isSafeInteger(options.minimumCatalogSize) || options.minimumCatalogSize < 1 || options.minimumCatalogSize > MAX_PLAYLISTS)) {
        throw new Error('--min-playlists must be an integer from 1 to 5000');
    }
    if (!/^https:\/\//.test(options.proxyBase)) throw new Error('--proxy must be HTTPS');
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(options.bucket)) throw new Error('Invalid R2 bucket name');
    return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const options = parseCommunityPublisherArgs(process.argv.slice(2));
    const operations = options.dryRun || options.buildOnly ? {} : createWranglerR2Operations(options.bucket);
    const result = await publishCommunityPlaylistCatalog({ ...options, ...operations, log: console.log });
    console.log(`[community-catalog] ${result.status}: ${result.catalog.playlists.length} playlists`);
}
