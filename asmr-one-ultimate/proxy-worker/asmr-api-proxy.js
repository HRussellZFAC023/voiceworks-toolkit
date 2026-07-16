/**
 * ASMR.one API CORS Proxy — Cloudflare Worker
 *
 * Relays read-only API requests to the asmr.one API mirrors from Cloudflare's
 * edge, so playlist backup/export keeps working when the site (or a mirror)
 * is unreachable or geo-blocked for the user.
 *
 * Usage:
 *   GET https://<worker>.workers.dev/api/playlist/get-playlist-metadata?id=<uuid>
 *   GET https://<worker>.workers.dev/api/playlists?__host=api.asmr-300.com
 *   GET https://<worker>.workers.dev/community-playlists/catalog.json
 *   POST https://<worker>.workers.dev/community-playlists/submissions
 *
 * `__host` selects a specific API mirror (must match ASMR_HOST_PATTERN);
 * default is api.asmr-200.com. Authorization headers are forwarded so a
 * logged-in user's own playlists resolve too. GET/HEAD only.
 */

const ALLOWED_ORIGIN_PATTERN = /^https?:\/\/(localhost(:\d+)?|127\.0\.0\.1(:\d+)?|.*\.workers\.dev|([a-z0-9-]+\.)*asmr[-.a-z0-9]*\.(one|com))$/i;
// api.* mirrors plus the frontend hosts (www.asmr.one), used by the E2E
// harness to reach the site itself from region-blocked networks.
const ASMR_HOST_PATTERN = /^(?:[a-z0-9-]+\.)*asmr(-\d+)?\.(one|com)$/i;
const DEFAULT_HOST = 'api.asmr-200.com';
const COMMUNITY_CATALOG_PATH = '/community-playlists/catalog.json';
const COMMUNITY_SUBMISSION_PATH = '/community-playlists/submissions';
const COMMUNITY_CATALOG_KEY = 'community-playlists/catalog.json';
const COMMUNITY_CATALOG_MAX_BYTES = 2 * 1024 * 1024;
const COMMUNITY_SUBMISSION_MAX_BYTES = 256;
const COMMUNITY_SUBMISSION_LIMIT = 5000;
const COMMUNITY_SUBMISSION_OBJECT_MAX_BYTES = 16 * 1024;
const COMMUNITY_SUBMISSION_INLINE_MAX_BYTES = 7 * 1024;
const COMMUNITY_SUBMISSION_AGGREGATE_MAX_BYTES = 4 * 1024 * 1024;
const COMMUNITY_SUBMISSION_LEGACY_READ_LIMIT = 900;
const COMMUNITY_SUBMISSION_PREFIX = 'community-playlists/submissions/';
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const COMMUNITY_SUBMISSION_KEY_PATTERN = /^community-playlists\/submissions\/([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.json$/;

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        if (request.method === 'OPTIONS') {
            const isCommunityRoute = url.pathname === COMMUNITY_CATALOG_PATH
                || url.pathname === COMMUNITY_SUBMISSION_PATH;
            return new Response(null, {
                status: 204,
                headers: isCommunityRoute || url.pathname.startsWith('/semantic-index/')
                    ? publicDataCorsHeaders(isCommunityRoute)
                    : corsHeaders(request),
            });
        }

        if (url.pathname === COMMUNITY_CATALOG_PATH) {
            if (request.method !== 'GET' && request.method !== 'HEAD') {
                return communityJson({ error: 'Only GET and HEAD are supported' }, 405, { Allow: 'GET, HEAD, OPTIONS' });
            }
            return serveCommunityCatalog(request, env, ctx);
        }

        if (url.pathname === COMMUNITY_SUBMISSION_PATH) {
            if (request.method !== 'POST') {
                return communityJson({ error: 'Only POST is supported' }, 405, { Allow: 'POST, OPTIONS' });
            }
            return submitCommunityPlaylist(request, env, ctx);
        }

        if (request.method !== 'GET' && request.method !== 'HEAD') {
            return json({ error: 'Only GET is supported' }, 405, request);
        }

        if (url.pathname.startsWith('/semantic-index/')) {
            return serveSemanticIndex(request, url, env);
        }

        const query = new URLSearchParams(url.search);
        const hostOverride = query.get('__host');
        if (hostOverride) query.delete('__host');
        const path = url.pathname + (query.toString() ? `?${query.toString()}` : '');

        if (url.pathname === '/__trace') {
            const r = await fetch(`https://${DEFAULT_HOST}/cdn-cgi/trace`);
            return new Response(await r.text(), { status: r.status, headers: corsHeaders(request) });
        }

        if ((path === '/' || path === '') && !hostOverride) {
            return new Response('ASMR.one API proxy. Append an API path to proxy it.', {
                status: 200,
                headers: { 'Content-Type': 'text/plain', ...corsHeaders(request) },
            });
        }

        const targetHost = hostOverride && ASMR_HOST_PATTERN.test(hostOverride)
            ? hostOverride
            : DEFAULT_HOST;

        const headers = {
            'Accept': request.headers.get('Accept') || 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept-Language': normalizeAcceptLanguage(request.headers.get('Accept-Language')),
            'Referer': 'https://www.asmr.one/',
        };
        const auth = request.headers.get('Authorization');
        if (auth) headers['Authorization'] = auth;

        try {
            const resp = await fetch(`https://${targetHost}${path}`, {
                method: request.method,
                headers,
            });
            const body = await resp.arrayBuffer();
            return new Response(body, {
                status: resp.status,
                headers: {
                    'Content-Type': resp.headers.get('Content-Type') || 'application/json',
                    // Authorized responses vary per user; only cache anonymous reads.
                    'Cache-Control': auth ? 'no-store' : 'public, max-age=300',
                    ...corsHeaders(request),
                },
            });
        } catch (e) {
            return json({ error: e.message }, 502, request);
        }
    },
};

const SEMANTIC_MANIFEST_PATH = '/semantic-index/manifest.json';
const SEMANTIC_OBJECT_PATTERN = /^\/semantic-index\/objects\/([a-f0-9]{64})\.bin\.gz$/;

async function serveCommunityCatalog(request, env, ctx) {
    if (!env?.SEMANTIC_INDEX) {
        return communityJson({ error: 'Community playlist catalog is unavailable' }, 503);
    }

    const cached = await matchCommunityCatalogEdgeCache(request);
    if (cached) return cached;

    let submittedObjects;
    try {
        submittedObjects = await listCommunitySubmissionObjects(env.SEMANTIC_INDEX);
    } catch (error) {
        console.error(JSON.stringify({
            message: 'community submission listing failed',
            error: error instanceof Error ? error.message : String(error),
        }));
        return communityJson({ error: 'Community playlist catalog is unavailable' }, 503);
    }

    const needsMerge = submittedObjects.length > 0;
    let object;
    try {
        object = request.method === 'HEAD' && !needsMerge
            ? await env.SEMANTIC_INDEX.head(COMMUNITY_CATALOG_KEY)
            : await env.SEMANTIC_INDEX.get(COMMUNITY_CATALOG_KEY);
    } catch (error) {
        console.error(JSON.stringify({
            message: 'community catalog read failed',
            error: error instanceof Error ? error.message : String(error),
        }));
        return communityJson({ error: 'Community playlist catalog is unavailable' }, 503);
    }
    if (!object) return communityJson({ error: 'Community playlist catalog not found' }, 404);
    if (object.size > COMMUNITY_CATALOG_MAX_BYTES
        || (request.method === 'GET' && !object.body)) {
        return communityJson({ error: 'Community playlist catalog exceeds its size limit' }, 503);
    }

    const baseEtag = object.httpEtag || (object.etag ? `"${object.etag}"` : undefined);
    if (!needsMerge) {
        const headers = communityCatalogHeaders(object.size, baseEtag);
        if (baseEtag && etagMatches(request.headers.get('If-None-Match'), baseEtag)) {
            return new Response(null, { status: 304, headers });
        }
        const response = new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers });
        await putCommunityCatalogEdgeCache(request, response, ctx);
        return response;
    }

    if (!object.body) {
        return communityJson({ error: 'Community playlist catalog exceeds its size limit' }, 503);
    }
    let base;
    try {
        base = JSON.parse(await readBoundedText(object.body, COMMUNITY_CATALOG_MAX_BYTES));
    } catch {
        return communityJson({ error: 'Community playlist catalog is invalid' }, 503);
    }
    if (!isCatalogDocument(base)) {
        return communityJson({ error: 'Community playlist catalog is invalid' }, 503);
    }

    const submittedRecords = await readCommunitySubmissionObjects(env.SEMANTIC_INDEX, submittedObjects);
    const playlists = new Map(base.playlists.map((playlist) => [playlist.id, playlist]));
    let generatedAt = base.generatedAt;
    let generatedAtMs = Date.parse(base.generatedAt);
    for (const record of submittedRecords) {
        // Maintainer-published data wins if an older anonymous submission later
        // becomes part of the curated base catalog.
        if (!playlists.has(record.playlist.id)) playlists.set(record.playlist.id, record.playlist);
        const verifiedAtMs = Date.parse(record.verifiedAt);
        if (verifiedAtMs > generatedAtMs) {
            generatedAt = record.verifiedAt;
            generatedAtMs = verifiedAtMs;
        }
    }
    const merged = JSON.stringify({ version: 1, generatedAt, playlists: Array.from(playlists.values()) });
    const mergedBytes = new TextEncoder().encode(merged);
    if (mergedBytes.byteLength > COMMUNITY_CATALOG_MAX_BYTES) {
        return communityJson({ error: 'Community playlist catalog exceeds its size limit' }, 503);
    }
    const etag = `"${await sha256Hex(mergedBytes)}"`;
    const headers = communityCatalogHeaders(mergedBytes.byteLength, etag);
    if (etagMatches(request.headers.get('If-None-Match'), etag)) {
        return new Response(null, { status: 304, headers });
    }
    const response = new Response(request.method === 'HEAD' ? null : mergedBytes, { status: 200, headers });
    await putCommunityCatalogEdgeCache(request, response, ctx);
    return response;
}

async function submitCommunityPlaylist(request, env, ctx) {
    if (!env?.SEMANTIC_INDEX || !env?.COMMUNITY_SUBMISSION_RATE_LIMITER) {
        return communityJson({ error: 'Community playlist submissions are unavailable' }, 503);
    }
    if (!isJsonContentType(request.headers.get('Content-Type'))) {
        return communityJson({ error: 'Content-Type must be application/json' }, 415);
    }

    let rateLimit;
    try {
        const rateKey = await communityRateLimitKey(request);
        rateLimit = await env.COMMUNITY_SUBMISSION_RATE_LIMITER.limit({ key: rateKey });
    } catch (error) {
        console.error(JSON.stringify({
            message: 'community submission rate limiter failed',
            error: error instanceof Error ? error.message : String(error),
        }));
        return communityJson({ error: 'Community playlist submissions are unavailable' }, 503);
    }
    if (!rateLimit?.success) {
        return communityJson({ error: 'Too many submissions; try again later' }, 429, { 'Retry-After': '60' });
    }

    let body;
    try {
        body = JSON.parse(await readBoundedRequestText(request, COMMUNITY_SUBMISSION_MAX_BYTES));
    } catch (error) {
        const tooLarge = error instanceof BoundedBodyError && error.tooLarge;
        return communityJson({ error: tooLarge ? 'Request body is too large' : 'Invalid JSON body' }, tooLarge ? 413 : 400);
    }
    if (!isExactSubmissionBody(body)) {
        return communityJson({ error: 'Body must contain exactly one lowercase UUID field named id' }, 400);
    }

    const id = body.id;
    const submissionKey = `${COMMUNITY_SUBMISSION_PREFIX}${id}.json`;
    let existing;
    try {
        existing = await env.SEMANTIC_INDEX.head(submissionKey);
    } catch (error) {
        console.error(JSON.stringify({
            message: 'community submission duplicate check failed',
            error: error instanceof Error ? error.message : String(error),
        }));
        return communityJson({ error: 'Community playlist submissions are unavailable' }, 503);
    }
    if (existing) return communityJson({ status: 'already-listed', id }, 200);

    let alreadyInBaseCatalog;
    try {
        alreadyInBaseCatalog = await baseCommunityCatalogContains(env.SEMANTIC_INDEX, id);
    } catch (error) {
        console.error(JSON.stringify({
            message: 'community base catalog duplicate check failed',
            error: error instanceof Error ? error.message : String(error),
        }));
        return communityJson({ error: 'Community playlist submissions are unavailable' }, 503);
    }
    if (alreadyInBaseCatalog) return communityJson({ status: 'already-listed', id }, 200);

    let summary;
    try {
        summary = await fetchVerifiedPublicPlaylist(id);
    } catch (error) {
        if (error instanceof UpstreamPlaylistError) {
            return communityJson({ error: error.message }, error.status);
        }
        return communityJson({ error: 'Playlist verification is temporarily unavailable' }, 503);
    }

    try {
        const prepared = prepareCommunitySubmissionRecord(summary, new Date().toISOString());
        summary = prepared.record.playlist;
        const stored = await env.SEMANTIC_INDEX.put(submissionKey, prepared.json, {
            // Use the standardized wildcard header for an unambiguous atomic
            // create-only write. R2 returns null when this precondition fails.
            onlyIf: new Headers({ 'If-None-Match': '*' }),
            httpMetadata: { contentType: 'application/json' },
            // Listing this bounded record avoids one R2 get() per submission.
            customMetadata: { communityRecord: prepared.json },
        });
        if (!stored) return communityJson({ status: 'already-listed', id }, 200);
        await deleteCommunityCatalogEdgeCache(request, ctx);
        return communityJson({ status: 'added', playlist: summary }, 201);
    } catch (error) {
        console.error(JSON.stringify({
            message: 'community playlist R2 write failed',
            error: error instanceof Error ? error.message : String(error),
        }));
        return communityJson({ error: 'Community playlist submissions are unavailable' }, 503);
    }
}

function prepareCommunitySubmissionRecord(summary, verifiedAt) {
    const playlist = { ...summary, tags: [...summary.tags] };
    const record = { version: 1, verifiedAt, playlist };
    const encoder = new TextEncoder();
    let json = JSON.stringify(record);
    while (encoder.encode(json).byteLength > COMMUNITY_SUBMISSION_INLINE_MAX_BYTES
        && playlist.tags.length > 0) {
        playlist.tags.pop();
        json = JSON.stringify(record);
    }
    if (encoder.encode(json).byteLength > COMMUNITY_SUBMISSION_INLINE_MAX_BYTES) {
        throw new Error('Verified playlist summary exceeds its storage limit');
    }
    return { record, json };
}

async function baseCommunityCatalogContains(bucket, id) {
    const object = await bucket.get(COMMUNITY_CATALOG_KEY);
    if (!object?.body || object.size > COMMUNITY_CATALOG_MAX_BYTES) {
        throw new Error('Base community catalog is missing or exceeds its size limit');
    }
    const catalog = JSON.parse(await readBoundedText(object.body, COMMUNITY_CATALOG_MAX_BYTES));
    if (!isCatalogDocument(catalog)) throw new Error('Base community catalog is invalid');
    return catalog.playlists.some((playlist) => playlist.id === id);
}

function communityCatalogCacheRequest(request) {
    const url = new URL(request.url);
    url.pathname = COMMUNITY_CATALOG_PATH;
    url.search = '';
    url.hash = '';
    const headers = new Headers();
    const ifNoneMatch = request.headers.get('If-None-Match');
    if (ifNoneMatch) headers.set('If-None-Match', ifNoneMatch);
    return new Request(url.href, { method: 'GET', headers });
}

function communityCatalogCache() {
    return typeof caches !== 'undefined' ? caches.default : undefined;
}

async function matchCommunityCatalogEdgeCache(request) {
    const cache = communityCatalogCache();
    if (!cache) return undefined;
    try {
        const cached = await cache.match(communityCatalogCacheRequest(request));
        if (!cached) return undefined;
        const etag = cached.headers.get('ETag');
        if (cached.status !== 304 && etag && etagMatches(request.headers.get('If-None-Match'), etag)) {
            return new Response(null, { status: 304, headers: cached.headers });
        }
        return request.method === 'HEAD' && cached.status !== 304
            ? new Response(null, { status: cached.status, statusText: cached.statusText, headers: cached.headers })
            : cached;
    } catch (error) {
        console.error(JSON.stringify({
            message: 'community catalog edge cache read failed',
            error: error instanceof Error ? error.message : String(error),
        }));
        return undefined;
    }
}

async function putCommunityCatalogEdgeCache(request, response, ctx) {
    if (request.method !== 'GET' || response.status !== 200) return;
    const cache = communityCatalogCache();
    if (!cache) return;
    const operation = cache.put(communityCatalogCacheRequest(request), response.clone()).catch((error) => {
        console.error(JSON.stringify({
            message: 'community catalog edge cache write failed',
            error: error instanceof Error ? error.message : String(error),
        }));
    });
    if (ctx?.waitUntil) ctx.waitUntil(operation);
    else await operation;
}

async function deleteCommunityCatalogEdgeCache(request, ctx) {
    const cache = communityCatalogCache();
    if (!cache) return;
    const operation = cache.delete(communityCatalogCacheRequest(request)).catch((error) => {
        console.error(JSON.stringify({
            message: 'community catalog edge cache invalidation failed',
            error: error instanceof Error ? error.message : String(error),
        }));
    });
    if (ctx?.waitUntil) ctx.waitUntil(operation);
    else await operation;
}

async function listCommunitySubmissionObjects(bucket) {
    const objects = [];
    let aggregateSize = 0;
    let legacyReads = 0;
    let cursor;
    do {
        const page = await bucket.list({
            prefix: COMMUNITY_SUBMISSION_PREFIX,
            limit: 1000,
            include: ['customMetadata'],
            ...(cursor ? { cursor } : {}),
        });
        for (const object of page.objects || []) {
            if (COMMUNITY_SUBMISSION_KEY_PATTERN.test(object.key)) {
                objects.push(object);
                aggregateSize += object.size;
                if (typeof object.customMetadata?.communityRecord !== 'string') legacyReads += 1;
            }
            if (objects.length > COMMUNITY_SUBMISSION_LIMIT) {
                throw new Error('Community submission limit exceeded');
            }
            if (!Number.isSafeInteger(aggregateSize) || aggregateSize > COMMUNITY_SUBMISSION_AGGREGATE_MAX_BYTES) {
                throw new Error('Community submission aggregate size limit exceeded');
            }
            if (legacyReads > COMMUNITY_SUBMISSION_LEGACY_READ_LIMIT) {
                throw new Error('Community legacy submission read limit exceeded');
            }
        }
        cursor = page.truncated ? page.cursor : undefined;
        if (page.truncated && !cursor) throw new Error('R2 returned a truncated list without a cursor');
    } while (cursor);
    return objects.sort((left, right) => left.key.localeCompare(right.key));
}

async function readCommunitySubmissionObjects(bucket, objects) {
    const records = new Array(objects.length);
    let nextIndex = 0;
    const runners = Array.from({ length: Math.min(8, objects.length) }, async () => {
        for (;;) {
            const index = nextIndex++;
            if (index >= objects.length) return;
            const descriptor = objects[index];
            if (descriptor.size > COMMUNITY_SUBMISSION_OBJECT_MAX_BYTES) continue;
            try {
                const inline = descriptor.customMetadata?.communityRecord;
                let record;
                if (typeof inline === 'string') {
                    if (new TextEncoder().encode(inline).byteLength > COMMUNITY_SUBMISSION_INLINE_MAX_BYTES) continue;
                    record = JSON.parse(inline);
                } else {
                    const object = await bucket.get(descriptor.key);
                    if (!object?.body || object.size > COMMUNITY_SUBMISSION_OBJECT_MAX_BYTES) continue;
                    record = JSON.parse(await readBoundedText(object.body, COMMUNITY_SUBMISSION_OBJECT_MAX_BYTES));
                }
                const keyMatch = COMMUNITY_SUBMISSION_KEY_PATTERN.exec(descriptor.key);
                if (keyMatch && isCommunitySubmissionRecord(record) && record.playlist.id === keyMatch[1]) {
                    records[index] = record;
                }
            } catch (error) {
                console.error(JSON.stringify({
                    message: 'community submission object read failed',
                    key: descriptor.key,
                    error: error instanceof Error ? error.message : String(error),
                }));
            }
        }
    });
    await Promise.all(runners);
    return records.filter(Boolean);
}

async function fetchVerifiedPublicPlaylist(id) {
    const metadataResponse = await fetch(`https://${DEFAULT_HOST}/api/playlist/get-playlist-metadata?id=${encodeURIComponent(id)}`, {
        headers: upstreamHeaders(),
        signal: AbortSignal.timeout(10_000),
    });
    if (metadataResponse.status === 404) throw new UpstreamPlaylistError(404, 'Playlist not found');
    if (metadataResponse.status === 429 || metadataResponse.status >= 500) {
        throw new UpstreamPlaylistError(503, 'Playlist verification is temporarily unavailable');
    }
    if (!metadataResponse.ok) {
        throw new UpstreamPlaylistError(503, 'Playlist verification is temporarily unavailable');
    }

    let metadata;
    try {
        metadata = JSON.parse(await readBoundedResponseText(metadataResponse, 512 * 1024));
    } catch {
        throw new UpstreamPlaylistError(503, 'Playlist verification is temporarily unavailable');
    }
    if (!metadata || typeof metadata !== 'object'
        || String(metadata.id || '').toLowerCase() !== id
        || typeof metadata.name !== 'string' || !metadata.name.trim()
        || metadata.name === 'Unknown Playlist') {
        throw new UpstreamPlaylistError(503, 'Playlist verification is temporarily unavailable');
    }
    if (metadata.privacy !== 2) {
        if (metadata.privacy === 0 || metadata.privacy === 1) {
            throw new UpstreamPlaylistError(403, 'Only explicitly public playlists can be shared');
        }
        throw new UpstreamPlaylistError(503, 'Playlist verification is temporarily unavailable');
    }

    let firstWork = Array.isArray(metadata.works) ? metadata.works[0] : undefined;
    const metadataCover = readCoverUrl(metadata);
    if (!firstWork && !metadataCover && normalizeNonNegativeInteger(metadata.works_count) > 0) {
        try {
            const worksResponse = await fetch(
                `https://${DEFAULT_HOST}/api/playlist/get-playlist-works?id=${encodeURIComponent(id)}&page=1&pageSize=1`,
                { headers: upstreamHeaders(), signal: AbortSignal.timeout(10_000) },
            );
            if (worksResponse.ok) {
                const worksPayload = JSON.parse(await readBoundedResponseText(worksResponse, 512 * 1024));
                firstWork = Array.isArray(worksPayload?.works) ? worksPayload.works[0] : undefined;
            }
        } catch {
            // The verified metadata remains useful even when optional artwork lookup fails.
        }
    }
    return summaryFromMetadata(id, metadata, firstWork);
}

function summaryFromMetadata(id, metadata, firstWork) {
    const source = firstWork && typeof firstWork === 'object' ? firstWork : undefined;
    const latestWorkId = normalizeWorkId(source?.source_id ?? source?.id);
    const tags = collectTagNames([metadata.tags, metadata.genres, source?.tags, source?.genres]);
    const summary = {
        id,
        name: compactString(metadata.name, 512) || id,
        userName: compactString(metadata.user_name, 256),
        worksCount: normalizeNonNegativeInteger(metadata.works_count ?? metadata.worksCount),
        coverUrl: compactUrl(readCoverUrl(metadata) || readCoverUrl(source)),
        tags,
    };
    if (latestWorkId !== undefined) summary.latestWorkId = latestWorkId;
    return summary;
}

function isCatalogDocument(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || value.version !== 1 || typeof value.generatedAt !== 'string'
        || !Number.isFinite(Date.parse(value.generatedAt))
        || !Array.isArray(value.playlists) || value.playlists.length > COMMUNITY_SUBMISSION_LIMIT
        || !Object.keys(value).every((key) => ['version', 'generatedAt', 'playlists'].includes(key))) return false;
    const ids = new Set();
    return value.playlists.every((playlist) => {
        if (!isPlaylistSummary(playlist) || ids.has(playlist.id)) return false;
        ids.add(playlist.id);
        return true;
    });
}

function isPlaylistSummary(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || !UUID_PATTERN.test(value.id)
        || typeof value.name !== 'string' || !value.name || value.name.length > 512
        || typeof value.userName !== 'string' || value.userName.length > 256
        || !Number.isSafeInteger(value.worksCount) || value.worksCount < 0
        || typeof value.coverUrl !== 'string' || value.coverUrl.length > 2048
        || !Array.isArray(value.tags) || value.tags.length > 128
        || value.tags.some((tag) => typeof tag !== 'string' || !tag || tag.length > 128)) return false;
    if (value.latestWorkId !== undefined
        && !(typeof value.latestWorkId === 'string' && /^[A-Z]{2}\d+$/.test(value.latestWorkId))
        && !(Number.isSafeInteger(value.latestWorkId) && value.latestWorkId > 0)) return false;
    return Object.keys(value).every((key) => [
        'id', 'name', 'userName', 'worksCount', 'coverUrl', 'tags', 'latestWorkId',
    ].includes(key));
}

function isCommunitySubmissionRecord(value) {
    return value && typeof value === 'object' && value.version === 1
        && typeof value.verifiedAt === 'string' && Number.isFinite(Date.parse(value.verifiedAt))
        && isCatalogDocument({ version: 1, generatedAt: value.verifiedAt, playlists: [value.playlist] });
}

function communityCatalogHeaders(size, etag) {
    return {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(size),
        'Cache-Control': 'public, max-age=60, must-revalidate',
        ...(etag ? { ETag: etag } : {}),
        ...publicDataCorsHeaders(true),
    };
}

function communityJson(value, status, extraHeaders = {}) {
    return new Response(JSON.stringify(value), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            ...publicDataCorsHeaders(true),
            ...extraHeaders,
        },
    });
}

function upstreamHeaders() {
    return {
        Accept: 'application/json',
        'Accept-Language': 'ja',
        Referer: 'https://www.asmr.one/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    };
}

function isJsonContentType(contentType) {
    return typeof contentType === 'string' && /^application\/json(?:\s*;|$)/i.test(contentType);
}

function isExactSubmissionBody(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === 1 && UUID_PATTERN.test(value.id);
}

class BoundedBodyError extends Error {
    constructor(message, tooLarge = false) {
        super(message);
        this.tooLarge = tooLarge;
    }
}

class UpstreamPlaylistError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

async function readBoundedRequestText(request, maximumBytes) {
    const declared = request.headers.get('Content-Length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
        throw new BoundedBodyError('Request body is too large', true);
    }
    if (!request.body) throw new BoundedBodyError('Request body is missing');
    return readBoundedText(request.body, maximumBytes);
}

async function readBoundedResponseText(response, maximumBytes) {
    const declared = response.headers.get('Content-Length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
        throw new BoundedBodyError('Response body is too large', true);
    }
    if (!response.body) throw new BoundedBodyError('Response body is missing');
    return readBoundedText(response.body, maximumBytes);
}

async function readBoundedText(stream, maximumBytes) {
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maximumBytes) {
                await reader.cancel();
                throw new BoundedBodyError('Body is too large', true);
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
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function communityRateLimitKey(request) {
    // Cloudflare supplies CF-Connecting-IP at the edge. Do not include
    // caller-controlled headers such as User-Agent: varying them would create
    // unlimited independent limiter buckets for one source address.
    const ip = (request.headers.get('CF-Connecting-IP') || 'unknown').trim().slice(0, 128);
    return sha256Hex(new TextEncoder().encode(`${COMMUNITY_SUBMISSION_PATH}\n${ip}`));
}

async function sha256Hex(bytes) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function etagMatches(header, etag) {
    if (!header) return false;
    return header.split(',').some((candidate) => {
        const normalized = candidate.trim();
        return normalized === '*' || normalized === etag || normalized === `W/${etag}`;
    });
}

function normalizeNonNegativeInteger(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function normalizeWorkId(value) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return /^[A-Za-z]{2}\d+$/.test(trimmed) ? trimmed.toUpperCase()
        : (/^\d+$/.test(trimmed) ? Number(trimmed) : undefined);
}

function compactString(value, maximumLength) {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, maximumLength) : '';
}

function compactUrl(value) {
    if (typeof value !== 'string' || value.length > 2048) return '';
    try {
        const parsed = new URL(value);
        return parsed.protocol === 'https:' ? parsed.href : '';
    } catch { return ''; }
}

function readCoverUrl(value) {
    if (!value || typeof value !== 'object') return '';
    for (const key of ['coverUrl', 'cover', 'main_cover_url', 'mainCoverUrl', 'thumbnailCoverUrl', 'samCoverUrl']) {
        if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
    }
    return '';
}

function collectTagNames(value) {
    const tags = new Map();
    const visit = (candidate) => {
        if (tags.size >= 128 || candidate === null || candidate === undefined) return;
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

async function serveSemanticIndex(request, url, env) {
    if (!env?.SEMANTIC_INDEX) {
        return semanticJson({ error: 'Semantic index is unavailable' }, 503);
    }
    let key;
    let immutable = false;
    if (url.pathname === SEMANTIC_MANIFEST_PATH) {
        key = 'semantic-index/manifest.json';
    } else {
        const match = SEMANTIC_OBJECT_PATTERN.exec(url.pathname);
        if (!match) return semanticJson({ error: 'Semantic index object not found' }, 404);
        key = `semantic-index/objects/${match[1]}.bin.gz`;
        immutable = true;
    }

    const object = request.method === 'HEAD'
        ? await env.SEMANTIC_INDEX.head(key)
        : await env.SEMANTIC_INDEX.get(key);
    if (!object) return semanticJson({ error: 'Semantic index object not found' }, 404);

    const etag = object.httpEtag || (object.etag ? `"${object.etag}"` : undefined);
    const headers = {
        'Content-Type': immutable ? 'application/octet-stream' : (object.httpMetadata?.contentType || 'application/json'),
        'Content-Length': String(object.size),
        'Cache-Control': immutable
            ? 'public, max-age=31536000, immutable'
            : 'public, max-age=300, must-revalidate',
        ...(etag ? { ETag: etag } : {}),
        ...publicDataCorsHeaders(),
    };
    if (etag && request.headers.get('If-None-Match') === etag) {
        return new Response(null, { status: 304, headers });
    }
    return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers });
}

function json(obj, status, request) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
    });
}

function semanticJson(obj, status) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json', ...publicDataCorsHeaders() },
    });
}

function corsHeaders(request) {
    const origin = request.headers.get('Origin') || '*';
    return {
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN_PATTERN.test(origin) ? origin : '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept, Accept-Language, Authorization, If-None-Match',
        'Access-Control-Expose-Headers': 'ETag, Content-Length',
        'Access-Control-Max-Age': '86400',
    };
}

function publicDataCorsHeaders(allowPost = false) {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': allowPost ? 'GET, HEAD, POST, OPTIONS' : 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept, If-None-Match',
        'Access-Control-Expose-Headers': 'ETag, Content-Length',
        'Access-Control-Max-Age': '86400',
    };
}

function normalizeAcceptLanguage(value) {
    if (!value || value.length > 256) return 'ja';
    const ranges = value.split(',').slice(0, 10).map((part) => part.trim()).filter(Boolean);
    const valid = ranges.filter((range) => /^(?:\*|[a-z]{1,8}(?:-[a-z0-9]{1,8})*)(?:\s*;\s*q=(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?$/i.test(range));
    return valid.length ? valid.join(', ') : 'ja';
}
