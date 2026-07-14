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

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: url.pathname.startsWith('/semantic-index/') ? semanticCorsHeaders() : corsHeaders(request),
            });
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
        ...semanticCorsHeaders(),
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
        headers: { 'Content-Type': 'application/json', ...semanticCorsHeaders() },
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

function semanticCorsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
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
