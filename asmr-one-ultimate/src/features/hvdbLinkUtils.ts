import {
    extractPrimaryRjCode,
    extractRjCodeFromText,
    toRjNumericId,
} from './rjCodeUtils';

type WorkLike = {
    source_id?: string | number | null;
    sourceId?: string | number | null;
} | null | undefined;

type RouteLike = {
    path?: string | null;
    fullPath?: string | null;
    params?: Record<string, string | undefined> | null;
} | null | undefined;

const HVDB_FALLBACK_SELECTORS = [
    '#asmr-work-metadata-root',
    '.col-12.col-md-8.q-pa-sm.q-pt-md-md > .q-px-sm.q-py-none',
    '.work-info .q-px-sm.q-py-none',
    '.q-page .q-px-sm.q-py-none',
    'h1.text-h6',
] as const;

const HVDB_DLSITE_SCOPE_SELECTORS = [
    '#asmr-work-metadata-root',
    '.col-12.col-md-8.q-pa-sm.q-pt-md-md',
    '.work-info',
    '.q-page',
] as const;

export function extractRjCode(work: WorkLike, workId: string | number | null | undefined): string {
    return extractPrimaryRjCode({
        sourceId: work?.source_id ?? work?.sourceId,
        workId,
    }) ?? '';
}

function getWorkIdFromRoute(route: RouteLike): string {
    const routeParam = route?.params?.id;
    if (routeParam) return routeParam;

    const routePath = route?.path || route?.fullPath || '';
    const match = routePath.match(/\/work\/([^/?#]+)/i);
    return match?.[1] || '';
}

export function resolveHvdbRjCode(params: {
    work: WorkLike;
    workId?: string | number | null | undefined;
    route?: RouteLike;
}): string {
    const workId = params.workId || getWorkIdFromRoute(params.route);
    return extractRjCode(params.work, workId);
}

export function buildHvdbUrl(rjCode: string): string {
    const hvdbId = toRjNumericId(rjCode);
    if (!hvdbId) return '';
    return `https://hvdb.me/Dashboard/Add?id=${hvdbId}`;
}

export function buildChobitUrl(rjCode: string): string {
    const code = extractRjCodeFromText(rjCode);
    if (!code) return '';
    return `https://chobit.cc/s/?f_category=all&q_keyword=${code}`;
}

function hrefContainsToken(href: string | null, token: string): boolean {
    if (!href || !token) return false;
    return href.toLowerCase().includes(token.toLowerCase());
}

function isDlsiteHref(href: string | null): boolean {
    if (!href) return false;
    const value = href.toLowerCase();
    return value.includes('dlsite.com')
        || value.includes('dlsite.jp')
        || value.includes('/product_id/');
}

function findAnchorRow(anchor: HTMLAnchorElement): HTMLElement | null {
    const explicitRow = anchor.closest<HTMLElement>('.row.items-center.q-gutter-xs');
    if (explicitRow) return explicitRow;
    const genericRow = anchor.closest<HTMLElement>('.row');
    if (genericRow) return genericRow;
    return anchor.parentElement instanceof HTMLElement ? anchor.parentElement : null;
}

function collectDlsiteAnchors(root: ParentNode): HTMLAnchorElement[] {
    return Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]'))
        .filter((anchor) => isDlsiteHref(anchor.getAttribute('href')));
}

function collectScopedDlsiteAnchors(root: ParentNode): HTMLAnchorElement[] {
    const scopes = HVDB_DLSITE_SCOPE_SELECTORS
        .map((selector) => querySelectorFromRoot(root, selector))
        .filter((scope): scope is HTMLElement => !!scope);
    if (scopes.length === 0) return [];

    const anchors = scopes.flatMap((scope) => collectDlsiteAnchors(scope));
    return Array.from(new Set(anchors));
}

function hasMetadataScope(root: ParentNode): boolean {
    return HVDB_DLSITE_SCOPE_SELECTORS.some((selector) => !!querySelectorFromRoot(root, selector));
}

function pickDlsiteAnchor(
    anchors: HTMLAnchorElement[],
    code: string,
    numericCode: string,
    allowFirstFallback = true,
): HTMLAnchorElement | null {
    if (anchors.length === 0) return null;

    const exactMatch = anchors.find((anchor) => hrefContainsToken(anchor.getAttribute('href'), code));
    if (exactMatch) return exactMatch;

    const numericMatch = anchors.find((anchor) => hrefContainsToken(anchor.getAttribute('href'), numericCode));
    if (numericMatch) return numericMatch;

    return allowFirstFallback ? anchors[0] : null;
}

export function findDlsiteMetaRow(root: ParentNode, rjCode: string): HTMLElement | null {
    const code = extractRjCodeFromText(rjCode);
    if (!code) return null;

    const numericCode = toRjNumericId(code);
    if (!numericCode) return null;

    const scopedAnchors = collectScopedDlsiteAnchors(root);
    const allAnchors = collectDlsiteAnchors(root);
    const allowGlobalFallback = !hasMetadataScope(root);
    const candidate = pickDlsiteAnchor(scopedAnchors, code, numericCode)
        || pickDlsiteAnchor(allAnchors, code, numericCode, allowGlobalFallback);
    if (!candidate) return null;

    return findAnchorRow(candidate);
}

function querySelectorFromRoot(root: ParentNode, selector: string): HTMLElement | null {
    if ('querySelector' in root && typeof root.querySelector === 'function') {
        return root.querySelector<HTMLElement>(selector);
    }
    return null;
}

export function findRatingRow(root: ParentNode): HTMLElement | null {
    const rating = root.querySelector('.q-rating');
    if (!rating) return null;
    return rating.closest<HTMLElement>('.row.items-center.q-gutter-xs') ?? null;
}

export function findHvdbInjectionPoint(root: ParentNode, rjCode: string): HTMLElement | null {
    const code = extractRjCodeFromText(rjCode);
    if (!code) return null;

    const dlsiteRow = findDlsiteMetaRow(root, code);
    if (dlsiteRow) return dlsiteRow;

    const ratingRow = findRatingRow(root);
    if (ratingRow) return ratingRow;

    for (const selector of HVDB_FALLBACK_SELECTORS) {
        const found = querySelectorFromRoot(root, selector);
        if (found) return found;
    }

    return null;
}
