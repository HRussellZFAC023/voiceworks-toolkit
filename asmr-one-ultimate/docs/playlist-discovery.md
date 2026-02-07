# Playlist Discovery

Discover public playlists on ASMR.one via Google Search indexing.

## Overview

The PlaylistDiscovery feature automatically finds publicly indexed playlists by searching Google for URLs matching `site:asmr.one/playlist`. This enables users to discover and browse public playlists created by other users, even though the ASMR.one backend doesn't expose a public playlists API endpoint.

## How It Works

1. **Google Search Discovery**: The feature sends requests to Google Search using `GM_xmlhttpRequest` (Tampermonkey's cross-origin request API) with the query `site:asmr.one/playlist`.

2. **Multi-Page Pagination**: It automatically fetches all available search result pages, extracting playlist UUIDs from the indexed URLs.

3. **Caching**: Search results are cached for 1 hour to reduce load on Google and improve responsiveness.

4. **Metadata Fetching**: For each discovered playlist ID, the feature fetches playlist metadata from the ASMR.one API to display playlist names, owners, and work counts.

5. **Filtering**: The current user's own playlists are automatically filtered out from the discovery results.

## Features

- **Automatic Discovery**: Runs a Google search on page load (respecting cache TTL)
- **Manual Refresh**: Users can click "Refresh" to force a new search
- **Manual Addition**: Users can paste playlist URLs or UUIDs to add specific playlists
- **Pagination**: Browse through discovered playlists with paginated display (24 per page)
- **Source Badges**: Playlists show badges indicating their discovery source (Google, Manual, etc.)

## User Interface

The feature adds a "Discover Public Playlists" section below the user's personal playlists on the `/playlists` page. This section includes:

- Count of discovered public playlists
- Refresh button to trigger a new Google search
- Input field for manually adding playlist URLs
- Grid of playlist cards matching the site's native styling
- Pagination controls

## Technical Details

### Search Query
```
site:asmr.one/playlist
```

### URL Patterns Matched
- `asmr.one/playlist?id=<UUID>`
- `asmr.one/playlist/<UUID>`
- URL-encoded variants

### Storage Keys
- `asmr_ultimate_discovered_playlists` - Persisted list of all discovered playlist IDs
- `asmr_ultimate_google_search_cache` - Cached search results with timestamp

### Rate Limiting
- 500ms delay between search result pages to avoid rate limiting
- 1-hour cache TTL for search results
- Maximum 20 pages searched per session (safety limit)

## Limitations

- **Google Rate Limiting**: Heavy usage may trigger Google's bot detection, temporarily blocking requests
- **Index Freshness**: Only playlists that Google has indexed will appear; newly created public playlists may take time to be indexed
- **Metadata Fetching**: If a playlist was deleted or made private since indexing, fetching its metadata will fail (shown with placeholder data)
