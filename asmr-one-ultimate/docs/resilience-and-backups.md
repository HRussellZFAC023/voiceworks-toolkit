# Resilience and playlist backups

ASMR.one Ultimate keeps the recovery paths explicit: local downloads remain available, split CSV/TXT and Drive exports keep the user's playlists in different files from public/community playlists, and remote backup is optional.

## Emergency backup

Open **Settings → Emergency Backup** and choose:

- **JSON** — canonical restorable snapshot. It contains separate `ownPlaylists` and `publicPlaylists` arrays and is also saved under `asmr-ult:emergency-export` in userscript storage.
- **CSV** — two downloads, one for the user's playlists and one for community/public playlists.
- **TXT** — two human-readable RJ-code lists with the same separation.
- **Google Drive** — two timestamped JSON uploads named `asmr-playlists-own-…` and `asmr-playlists-public-…`.

Individual playlist failures are recorded inside the export instead of aborting the whole backup. Reads are sequential or conservatively batched with pauses; public discovery is capped at 200 playlists per export.

## Download works from a backup

Choose **Download works from backup** and open a canonical JSON backup. The collection dialog supports playlist/work search, tri-state playlist selection, and individual work checkboxes without eagerly rendering every work in a large backup. Before choosing a destination folder, select which audio, video, image, text, and other files to include.

Work folders can use the original title, the translation in the active UI language, `Original [Translation]`, or the RJ code only. Optional Opus conversion offers several bitrates. Its safe additive metadata mode preserves existing tags and cover art and fills missing work fields; overwrite replaces the managed fields and cover for a more consistent collection while retaining unknown custom tags. Conversion completes and writes the playable Opus file before the source audio is removed, so a conversion failure leaves the downloaded source intact.

The downloader stores a per-file byte checkpoint, ETag/Last-Modified validators, job options, and the selected destination handle in IndexedDB. After a refresh, use the displayed resume action and grant the original folder again if prompted. Servers that honor byte ranges continue inside the partial file; otherwise that one file safely restarts, while completed files are never fetched again. Reliable writable-folder handles currently require a Chromium browser with the File System Access API; unsupported browsers show an explicit capability error rather than pretending resumability is available.

## Google Drive OAuth setup

The script requests only `https://www.googleapis.com/auth/drive.file`. It may create and manage files it created, but cannot browse unrelated Drive files.

Release 154 includes the maintained ASMR.one Ultimate Web OAuth client, so normal users can authorize a backup directly. The client ID is public configuration; no client secret is included or required.

To use a separate Google Cloud project instead, override the client ID in **Settings → Emergency Backup → Google Drive OAuth Client ID**:

1. In Google Cloud Console, create or select a project and configure the Google Auth Platform consent screen.
2. Add the Google Drive API and the `drive.file` scope. If the app remains in testing, add the Google accounts that will use it as test users.
3. Create an OAuth client of type **Web application**.
4. Add the origins on which the userscript is used: `https://asmr.one`, `https://www.asmr.one`, `https://asmr-100.com`, `https://asmr-200.com`, and `https://asmr-300.com`.
5. Copy the client ID (not a client secret) into the settings field.

The client ID is public configuration. Never put a Google client secret in the userscript or repository.

## Region-gate recovery and API fallback

When the top-level ASMR.one request is replaced by the `remember, no english` response, the userscript detects the exact title/body signature and confirms that no host `#q-app` exists before normal initialization. It fetches the application shell and same-host JS/CSS directly from ASMR.one with a Chinese-first `Accept-Language` header. It also parses the validated Webpack runtime maps and preloads every declared lazy JS chunk and active CSS chunk before the host runtime starts, preventing later routes from making blocked English-first browser requests. Final URLs, MIME types, file types, JSONP registrations, and per-file/aggregate byte budgets are validated before anything is installed; executable HTML/JS/CSS is never accepted from the proxy. The recovered app must mount before recovery is considered successful, and the original gate DOM is restored if it does not. This keeps the real origin, cookies, local storage, and login. Same-host font/image URLs inside the validated CSS may use the scoped read-only relay. Firefox's global website-language setting is not changed.

Playlist reads use a separate fallback order:

1. the host application's authenticated Axios client;
2. a direct userscript CORS request to the selected API mirror;
3. the configured read-only Cloudflare Worker.

The default Worker uses targeted placement in Japan, permits only ASMR.one/mirror upstream hosts, accepts only GET/HEAD, forwards `Authorization` when present, and sets `no-store` for authorized responses. Configure a private deployment through **Settings → Proxy → ASMR API Proxy URL**. The donation banner appears only after the maintained proxy was actually used.

The Worker accepts only GET/HEAD and is not a general browsing VPN. Normal navigation, interactive requests, and writes remain on the real ASMR.one origin. Executable recovery assets come directly from ASMR.one through privileged userscript requests; only non-executable CSS dependencies and supported API reads may use the scoped relay.

## Testing through the proxy

```bash
npm run build
E2E_PROXY=1 npm run test:e2e
```

Optional variables:

- `E2E_PROXY_URL` — private Worker URL.
- `E2E_SKIP_WEBSERVER=1` — skip the unused local Vite server in restricted runners.
- `E2E_REQUIRE_AUTH=1` plus the documented test credentials — include authenticated scenarios without storing credentials in git.
