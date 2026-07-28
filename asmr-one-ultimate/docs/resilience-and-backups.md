# Resilience and playlist backups

ASMR.one Ultimate keeps the recovery paths explicit: local downloads remain available, split CSV/TXT and Drive exports keep the user's playlists in different files from public/community playlists, and remote backup is optional.

## Emergency backup

Open **Settings → Emergency Backup** and choose:

- **JSON** — canonical machine-readable snapshot. It contains separate `ownPlaylists` and `publicPlaylists` arrays and is also saved under `asmr-ult:emergency-export` in userscript storage.
- **CSV** — two downloads, one for the user's playlists and one for community/public playlists.
- **TXT** — two human-readable RJ-code lists with the same separation.
- **Google Drive** — two timestamped JSON uploads named `asmr-playlists-own-…` and `asmr-playlists-public-…`.

Individual playlist failures are recorded inside the export instead of aborting the whole backup. Reads use bounded rolling batches, reuse complete work lists already returned by the signed-in playlist listing, and cover every discovered community playlist without silently truncating the export.

## Download works

Choose **Download works** in the top toolbar. The panel opens synchronously on **Site**, where multilingual semantic search is combined with the live work catalog and results include covers plus asynchronously calculated download sizes. **Yours** is shown only for signed-in users; **Community** reads one cached summary catalog instead of fetching hundreds of playlists. Covers, owners, work counts, and genre/tag filters are available from those summaries, while each playlist's works are fetched only when that playlist is expanded, selected, or downloaded. You can select all currently filtered rows, clear the entire selection, or choose individual works.

Before choosing a destination folder, select which audio, video, image, text, and other files to include. Audio, images, and text use safe defaults; video and miscellaneous files are opt-in to reduce storage use. File concurrency defaults to one and can be raised to three when more throughput is useful; Opus conversion remains serial to bound browser memory.

Work folders can use the original title, the translation in the active UI language, `Original [Translation]`, or the RJ code only. Optional Opus conversion offers several bitrates. Its safe additive metadata mode preserves existing tags and cover art and fills missing work fields; overwrite replaces the managed fields and cover for a more consistent collection while retaining unknown custom tags. Conversion completes and writes the playable Opus file before the source audio is removed, so a conversion failure leaves the downloaded source intact.

The downloader stores playlist discovery checkpoints, a per-file byte checkpoint, ETag/Last-Modified validators, and job options in IndexedDB. Progress and resume actions remain in the toolbar panel. Chromium writes to the selected folder through the File System Access API. Firefox stages completed work folders in private browser storage and uses the userscript manager's confirmed download API to deliver each as a ZIP; staged bytes and the resumable job remain available until delivery is confirmed. After a refresh, reopen the panel and resume the saved job. Servers that honor byte ranges continue inside the partial file; otherwise that one file safely restarts, while completed files are never fetched again.

## Google Drive OAuth setup

The script requests only `https://www.googleapis.com/auth/drive.file`. It may create and manage files it created, but cannot browse unrelated Drive files.

The maintained ASMR.one Ultimate Web OAuth client is configured inside the script, so **Settings → Emergency Backup → Google Drive** authorizes a backup directly with no setup. There is no client-ID field in the settings panel and none is needed; the client ID is public configuration and no client secret is included or required.

Maintainers who need to rotate or replace that client edit the `googleDriveClientId` default in `src/store/AppStore.ts`. The replacement must be an OAuth client of type **Web application** whose authorized JavaScript origins cover `https://asmr.one`, `https://www.asmr.one`, `https://asmr-100.com`, `https://asmr-200.com`, and `https://asmr-300.com`, with the Google Drive API and the `drive.file` scope enabled.

Never put a Google client secret in the userscript or repository.

## Region-gate recovery and API fallback

When the top-level ASMR.one request is replaced by the `remember, no english` response, the userscript detects the exact title/body signature and confirms that no host `#q-app` exists before normal initialization. It fetches the application shell and same-host JS/CSS directly from ASMR.one with a Chinese-first `Accept-Language` header. It also parses the validated Webpack runtime maps and preloads every declared lazy JS chunk and active CSS chunk before the host runtime starts, preventing later routes from making blocked English-first browser requests. Final URLs, MIME types, file types, JSONP registrations, and per-file/aggregate byte budgets are validated before anything is installed; executable HTML/JS/CSS is never accepted from the proxy. The recovered app must mount before recovery is considered successful, and the original gate DOM is restored if it does not. This keeps the real origin, cookies, local storage, and login. Same-host font/image URLs inside the validated CSS may use the scoped read-only relay. Firefox's global website-language setting is not changed.

Playlist reads use a separate fallback order:

1. the host application's authenticated Axios client;
2. a direct userscript CORS request to the selected API mirror;
3. the configured read-only Cloudflare Worker.

The default Worker uses targeted placement in Japan, permits only ASMR.one/mirror upstream hosts, relays only GET/HEAD, forwards `Authorization` when present, and sets `no-store` for authorized responses. Configure a private deployment through **Settings → Proxy → ASMR API Proxy URL**. The donation banner appears only after the maintained proxy was actually used.

The Worker is not a general browsing VPN. Normal navigation, interactive requests, and writes remain on the real ASMR.one origin. Executable recovery assets come directly from ASMR.one through privileged userscript requests; only non-executable CSS dependencies and supported API reads may use the scoped relay. A separate exact community-catalog endpoint accepts only `{ "id": "<lowercase-uuid-v4>" }`, verifies the playlist live, and publishes it only when the host reports it as public. The submission path is rate-limited and idempotent. Its summary retains public playlist metadata such as the displayed owner name, but no comments, submitter account identity, IP address, or user agent.

## Testing through the proxy

```bash
npm run build
npm run test:e2e
```

Optional variables:

- `E2E_PROXY_URL` — private Worker URL.
- `E2E_PROXY=0` — explicitly bypass the maintained Japan relay and exercise direct host networking.
- `E2E_SKIP_WEBSERVER=1` — skip the unused local Vite server in restricted runners.
- `E2E_REQUIRE_AUTH=1` plus the documented test credentials — include authenticated scenarios without storing credentials in git.
