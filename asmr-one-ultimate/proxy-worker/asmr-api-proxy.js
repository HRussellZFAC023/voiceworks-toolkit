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
    async fetch(request) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders(request) });
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            return json({ error: 'Only GET is supported' }, 405, request);
        }

        const url = new URL(request.url);
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
            'Accept-Language': 'ja',
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

function json(obj, status, request) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
    });
}

function corsHeaders(request) {
    const origin = request.headers.get('Origin') || '*';
    return {
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN_PATTERN.test(origin) ? origin : '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
        'Access-Control-Max-Age': '86400',
    };
}
