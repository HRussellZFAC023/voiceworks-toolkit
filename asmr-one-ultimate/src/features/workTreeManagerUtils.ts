import type { VueRoute } from '../types/store';

type QueryMap = Record<string, string | string[] | undefined>;

export interface RouteLike {
    path?: string;
    fullPath?: string;
    params?: { id?: string };
    query?: QueryMap;
}

export function arraysEqual(a: string[], b: string[]): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

export function getWorkIdFromRoute(route?: RouteLike | null): string | null {
    if (!route) return null;
    const paramId = route.params?.id;
    if (paramId) return String(paramId);
    const path = route.path || '';
    const match = path.match(/\/work\/([^/?#]+)/i);
    return match?.[1] || null;
}

export function getSegmentsFromRoute(route?: Pick<VueRoute, 'query'> | null): string[] {
    const raw = route?.query?.path;
    if (!raw) return [];
    if (Array.isArray(raw)) {
        return raw.map((segment) => String(segment));
    }
    if (typeof raw !== 'string') return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map((segment) => String(segment)) : [];
    } catch {
        return [];
    }
}

export function normalizeQuery(value: unknown): string {
    if (!value || typeof value !== 'object') return value ? String(value) : '';
    const entries = Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, (value as Record<string, unknown>)[key]]);
    try {
        return JSON.stringify(entries);
    } catch {
        return String(value);
    }
}

export function getRouteKey(route?: RouteLike | null): string {
    if (!route) return '';
    const fullPath = route.fullPath || route.path || '';
    if (fullPath) return fullPath.split('#')[0];
    const path = route.path || '';
    const queryKey = normalizeQuery(route.query);
    return queryKey ? `${path}?${queryKey}` : path;
}

export function hasExplicitPath(route?: Pick<RouteLike, 'query'> | null): boolean {
    const query = route?.query;
    if (!query || typeof query !== 'object') return false;
    return Object.prototype.hasOwnProperty.call(query, 'path');
}
