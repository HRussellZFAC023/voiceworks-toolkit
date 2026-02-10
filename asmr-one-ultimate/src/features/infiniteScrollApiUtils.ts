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
        const params = new URLSearchParams();
        params.set('page', String(page));
        params.set('order', pickFirstQueryValue(query.order) || 'release');
        params.set('sort', pickFirstQueryValue(query.sort) || 'desc');
        params.set('subtitle', pickFirstQueryValue(query.subtitle) || '0');
        setQueryParamIfPresent(params, 'keyword', query.keyword);
        setQueryParamIfPresent(params, 'seed', query.seed);

        Object.entries(query).forEach(([key, value]) => {
            if (params.has(key)) return;
            setQueryParamIfPresent(params, key, value);
        });

        return `/api/works?${params.toString()}`;
    }

    if (path === '/search') {
        const params = new URLSearchParams();
        params.set('page', String(page));
        Object.entries(query).forEach(([key, value]) => {
            if (key === 'page') return;
            setQueryParamIfPresent(params, key, value);
        });
        return `/api/search?${params.toString()}`;
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

    return null;
}
