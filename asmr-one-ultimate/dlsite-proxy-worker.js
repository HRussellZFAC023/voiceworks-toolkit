/**
 * DLsite CORS Proxy — Cloudflare Worker
 *
 * Deploy this worker in the Tokyo (NRT) region to bypass DLsite geo-restrictions.
 *
 * Setup:
 *   1. Go to https://dash.cloudflare.com → Workers & Pages → Create
 *   2. Click "Create Worker", name it (e.g. "dlsite-proxy")
 *   3. Paste this code and click "Save and Deploy"
 *   4. (Optional) Under Settings → General → Placement, enable Smart Placement
 *      or pin to Asia Pacific for lowest latency to DLsite
 *   5. Copy the worker URL (e.g. https://dlsite-proxy.yourname.workers.dev)
 *   6. Paste it into the "DLsite Proxy" setting in asmr-one-ultimate
 *
 * Usage:
 *   GET https://dlsite-proxy.yourname.workers.dev/maniax/api/review?product_id=RJ01196624
 *   → Proxies to https://www.dlsite.com/maniax/api/review?product_id=RJ01196624
 */

const ALLOWED_ORIGIN_PATTERN = /^https?:\/\/(localhost(:\d+)?|.*\.workers\.dev|.*asmr.*)$/;

export default {
    async fetch(request) {
        // Handle CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders(request) });
        }

        const url = new URL(request.url);
        const path = url.pathname + url.search;

        if (path === '/' || path === '') {
            return new Response('DLsite CORS Proxy. Append a DLsite path to proxy it.', {
                status: 200,
                headers: { 'Content-Type': 'text/plain', ...corsHeaders(request) },
            });
        }

        // Build target DLsite URL
        const target = `https://www.dlsite.com${path}`;

        try {
            const resp = await fetch(target, {
                method: request.method,
                headers: {
                    'Accept': request.headers.get('Accept') || 'application/json',
                    'Accept-Language': 'ja',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': 'https://www.dlsite.com/',
                    'Cookie': 'adultchecked=1; locale=ja-jp',
                },
            });

            const body = await resp.arrayBuffer();

            return new Response(body, {
                status: resp.status,
                headers: {
                    'Content-Type': resp.headers.get('Content-Type') || 'application/json',
                    'Cache-Control': 'public, max-age=3600',
                    ...corsHeaders(request),
                },
            });
        } catch (e) {
            return new Response(JSON.stringify({ error: e.message }), {
                status: 502,
                headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
            });
        }
    },
};

function corsHeaders(request) {
    const origin = request.headers.get('Origin') || '*';
    return {
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN_PATTERN.test(origin) ? origin : '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept',
        'Access-Control-Max-Age': '86400',
    };
}
