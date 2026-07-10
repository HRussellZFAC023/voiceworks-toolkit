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

`Authorization` headers are forwarded, so logged-in endpoints (your own playlists) work through the proxy. Only GET/HEAD are relayed; authorized responses are never cached.
