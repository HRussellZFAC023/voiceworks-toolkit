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
- `GET|HEAD /community-playlists/catalog.json` — the public, revalidated community-playlist summary catalog from R2
- `POST /community-playlists/submissions` — anonymously propose one public playlist with the exact JSON body `{ "id": "<lowercase-uuid>" }`

Semantic-index routes are exact and public. They never forward authorization headers or map arbitrary paths to R2 keys. Publish every referenced shard first, verify its SHA-256 and byte length, and update `semantic-index/manifest.json` last. This avoids a manifest pointing at missing objects and protects clients from cached partial releases.

Community-playlist routes are also exact and public. `GET` merges the maintained base catalog with verified submission records and supports `HEAD`, strong ETags, and conditional requests. Submission records carry a bounded inline R2 metadata copy so paginated listing does not need one object read per playlist; legacy records have a separate 900-read ceiling. A 60-second Cache API entry avoids repeating the merge at every request, and a successful local submission invalidates that entry immediately.

Anonymous submission is intentionally narrow: it accepts only a canonical lowercase UUIDv4 playlist ID, verifies live metadata against the Japan-placed ASMR API, and stores it only when upstream reports `privacy === 2`. IDs already present in either the base catalog or submission prefix return `already-listed` without another upstream fetch. The stored summary includes public playlist metadata such as its displayed owner name, but no comments, free text, submitter account identity, IP address, or user agent. A transient SHA-256 of the route and Cloudflare-supplied client IP feeds the 20-per-minute rate limiter; caller-controlled headers cannot create extra buckets. R2's conditional create-only `community-playlists/submissions/<uuid>.json` key makes duplicate writes idempotent under races.

## Publish the community playlist catalog

The maintained seed list lives at `proxy-worker/data/community-playlist-seeds.json`, outside the userscript source. The guarded publisher hydrates summaries through the maintained proxy with bounded concurrency and an interruption-safe local cache. It writes the content-addressed object first, reads it back and verifies its SHA-256/length, then replaces `community-playlists/catalog.json` last and verifies that too.

From the repository root:

```bash
# Hydrate, validate, and write only the local artifact/cache.
npm run community:publish -- --build-only

# Exercise the same build without writing anything to R2.
npm run community:publish -- --dry-run

# Publish to the configured asmr-semantic-index R2 bucket.
npm run community:publish
```

Successful hydration is checkpointed after each playlist in the ignored `proxy-worker/.wrangler/community-playlists/build-cache.json`; rerunning resumes failed or interrupted builds and reuses fresh results for seven days. Definitive missing, private, or invalid playlists are reported and cached as explicit exclusions; malformed responses, network errors, rate limits, and upstream 5xx failures stop publication while preserving completed progress. The conservative defaults hydrate two at a time with 250 ms between request starts and honor bounded `Retry-After` delays. The default publication floor is the larger of 450 playlists or 80% of the seed list, preventing an accidentally truncated seed file from silently replacing the canonical catalog. Intentional shrinkage requires an explicit `--min-playlists`; `--cache-ttl-hours 0` forces a refresh. Other guarded options include `--concurrency 1..8`, `--start-interval-ms`, `--proxy`, and `--bucket`.

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
