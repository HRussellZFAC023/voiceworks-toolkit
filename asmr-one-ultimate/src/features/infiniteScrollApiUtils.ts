export type InfiniteScrollQueryValue =
    | string
    | number
    | boolean
    | null
    | undefined
    | Array<string | number | boolean | null | undefined>;

export type InfiniteScrollQuery = Record<string, InfiniteScrollQueryValue>;

export interface BuildInfiniteScrollApiUrlInput {
    path: string;
    query?: InfiniteScrollQuery | null;
    page: number;
    pageSize: number;
}

function normalizeQueryToken(value: string | number | boolean | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    const token = String(value).trim();
    return token.length > 0 ? token : null;
}

export function pickFirstQueryValue(value: InfiniteScrollQueryValue): string | null {
    if (Array.isArray(value)) {
        for (const token of value) {
            const normalized = normalizeQueryToken(token);
            if (normalized !== null) return normalized;
        }
        return null;
    }
    return normalizeQueryToken(value);
}

function setQueryParamIfPresent(params: URLSearchParams, key: string, value: InfiniteScrollQueryValue): void {
    const normalized = pickFirstQueryValue(value);
    if (normalized !== null) {
        params.set(key, normalized);
    }
}

function getPathEntityId(path: string, prefix: 'circle' | 'tag' | 'va'): string | null {
    if (!path.startsWith(`/${prefix}/`)) return null;
    const segments = path.split('/').filter(Boolean);
    if (segments.length < 2) return null;
    const id = segments[1]?.trim();
    return id ? id : null;
}

function isWorksListingPath(path: string): boolean {
    return path === '/' || path === '/works' || path.startsWith('/works/');
}

export function buildInfiniteScrollApiUrl(input: BuildInfiniteScrollApiUrlInput): string | null {
    const path = input.path || '';
    const query = input.query || {};
    const page = input.page;

    if (isWorksListingPath(path)) {
        const keyword = pickFirstQueryValue(query.keyword);

        const params = new URLSearchParams();
        params.set('page', String(page));
        params.set('pageSize', String(input.pageSize));
        params.set('order', pickFirstQueryValue(query.order) || 'release');
        params.set('sort', pickFirstQueryValue(query.sort) || 'desc');
        params.set('subtitle', pickFirstQueryValue(query.subtitle) || '0');
        setQueryParamIfPresent(params, 'seed', query.seed);

        // Forward remaining query params (includeTranslationWorks, withPlaylistStatus[], etc.)
        Object.entries(query).forEach(([key, value]) => {
            if (params.has(key) || key === 'keyword') return;
            if (Array.isArray(value)) {
                for (const item of value) {
                    const normalized = normalizeQueryToken(item);
                    if (normalized !== null) params.append(key, normalized);
                }
            } else {
                setQueryParamIfPresent(params, key, value);
            }
        });

        // When a keyword is present, the API uses /api/search/<keyword>
        // instead of /api/works (keyword becomes a path segment, not a query param)
        if (keyword) {
            return `/api/search/${encodeURIComponent(keyword)}?${params.toString()}`;
        }
        return `/api/works?${params.toString()}`;
    }

    if (path === '/search' || path.startsWith('/search/')) {
        // The site encodes the search term as a path segment:
        //   /search/ $va:伊ヶ崎綾香$  →  /api/search/%20%24va%3A...
        const searchTerm = path.startsWith('/search/')
            ? path.slice('/search/'.length)
            : '';

        const params = new URLSearchParams();
        params.set('page', String(page));
        params.set('pageSize', String(input.pageSize));

        Object.entries(query).forEach(([key, value]) => {
            if (key === 'page' || key === 'pageSize') return;
            // Preserve all values for array params (e.g. withPlaylistStatus[])
            if (Array.isArray(value)) {
                for (const item of value) {
                    const normalized = normalizeQueryToken(item);
                    if (normalized !== null) params.append(key, normalized);
                }
            } else {
                setQueryParamIfPresent(params, key, value);
            }
        });

        const encodedTerm = searchTerm
            ? `/${encodeURIComponent(searchTerm)}`
            : '';
        return `/api/search${encodedTerm}?${params.toString()}`;
    }

    const circleId = getPathEntityId(path, 'circle');
    if (circleId) {
        return `/api/circles/${circleId}/works?page=${page}`;
    }

    const tagId = getPathEntityId(path, 'tag');
    if (tagId) {
        return `/api/tags/${tagId}/works?page=${page}`;
    }

    const vaId = getPathEntityId(path, 'va');
    if (vaId) {
        return `/api/vas/${vaId}/works?page=${page}`;
    }

    if (path === '/playlist') {
        const playlistId = pickFirstQueryValue(query.id);
        if (!playlistId) return null;

        const params = new URLSearchParams();
        params.set('id', playlistId);
        params.set('page', String(page));
        params.set('pageSize', String(input.pageSize));
        return `/api/playlist/get-playlist-works?${params.toString()}`;
    }

    // Review pages: /review?filter=listened, /review?filter=postponed, etc.
    if (path === '/review') {
        const params = new URLSearchParams();
        params.set('page', String(page));
        setQueryParamIfPresent(params, 'order', query.order);
        setQueryParamIfPresent(params, 'sort', query.sort);
        setQueryParamIfPresent(params, 'filter', query.filter);
        setQueryParamIfPresent(params, 'seed', query.seed);
        return `/api/review?${params.toString()}`;
    }

    return null;
}
