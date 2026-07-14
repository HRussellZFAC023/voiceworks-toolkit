# asmr-api-proxy — Cloudflare Worker

Read-only relay for the asmr.one API, used by asmr-one-ultimate as a **last-resort fallback** when direct API requests fail (mirror outage, DNS trouble, or region blocking). Also powers the Emergency Playlist Backup so exports keep working while the site is shaky.

The key trick is **targeted placement**: the worker is pinned to `azure:japaneast`, so its subrequests reach the asmr API from a Tokyo (NRT) Cloudflare colo with `loc=JP` — which passes the API's region gate that otherwise 403s western countries ("remember, no english").

## Deploy your own

```bash
cd proxy-worker
npx wrangler deploy
```

Then paste the printed `https://asmr-api-proxy.<you>.workers.dev` URL into **Settings → Proxy → ASMR API Proxy URL** in the userscript. Leave the setting blank to use the maintainer's default worker.

## Endpoints

- `GET /<api-path>` — proxied to `https://api.asmr-200.com/<api-path>` (override the mirror with `?__host=api.asmr-300.com`; only `api.asmr*.one|com` hosts are allowed)
- `GET /__trace` — diagnostic: shows the colo/country the asmr API sees (should print `loc=JP`)
- `GET|HEAD /semantic-index/manifest.json` — the revalidated semantic-search baseline manifest from the `SEMANTIC_INDEX` R2 binding
- `GET|HEAD /semantic-index/objects/<sha256>.bin.gz` — immutable, content-addressed gzip binary baseline shards (served without `Content-Encoding`)

Semantic-index routes are exact and public. They never forward authorization headers or map arbitrary paths to R2 keys. Publish every referenced shard first, verify its SHA-256 and byte length, and update `semantic-index/manifest.json` last. This avoids a manifest pointing at missing objects and protects clients from cached partial releases.

`Authorization` headers are forwarded, so logged-in endpoints (your own playlists) work through the proxy. Only GET/HEAD are relayed; authorized responses are never cached.
The caller's validated `Accept-Language` preference is forwarded so Chinese clients receive the same API locale through the fallback; absent or malformed values fall back to Japanese. Other request headers are not forwarded.

## E2E from a blocked network

```bash
cd ..
npm run build
E2E_PROXY=1 npm run test:e2e
```

`E2E_PROXY_URL` selects a private worker. The fixture passes `__host` for frontend assets as well as API calls. `E2E_SKIP_WEBSERVER=1` avoids starting Vite on runners where local port binding is unavailable.

The production script does not turn the worker into a general browsing VPN: it is an automatic last-resort fallback for supported GET API reads. The support banner is shown only after this maintained worker actually served a request.
