/**
 * Recover the ASMR.one frontend when its English-first Accept-Language gate
 * replaces the SPA with the "remember, no english" response.
 *
 * A userscript cannot alter the header of the top-level request that already
 * completed. Tampermonkey can, however, issue privileged requests with a
 * Chinese-first header. We use those requests to retrieve the trusted host
 * document, bootstrap assets, and lazy-route chunks, then install them into
 * the current document so the page keeps its real asmr.one origin, storage,
 * and login.
 */

import { DEFAULT_API_PROXY, TIMING } from './Constants';
import { runPacedBatches } from './PacedBatch';
import { recordProxyUse } from './ProxyUsage';
import { I18n, Logger } from './Utils';
import { gmRequest, parseGmHeaders, type GmResponse } from '../infrastructure/HttpClient';

const REGION_GATE_TITLE = 'remember, no english';
const REGION_GATE_BODY_MARKER = 'i have an idea: how about not using asmr.one?';
const RECOVERY_ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,en-GB;q=0.8,en;q=0.7';
const USER_STYLE_MARKER = '--asmr-accent';
const MAX_DOCUMENT_BYTES = 1_000_000;
const MAX_SINGLE_ASSET_BYTES = 4_000_000;
const MAX_RUNTIME_ASSET_BYTES = 1_000_000;
const MAX_BOOTSTRAP_BYTES = 8_000_000;
const MAX_BOOTSTRAP_ASSETS = 12;
const MAX_RUNTIME_ASSETS = 64;
const RUNTIME_FETCH_CONCURRENCY = 4;
const HOST_BOOT_TIMEOUT_MS = 15_000;
const RECOVERY_PREPARE_TIMEOUT_MS = 45_000;

const trustedFrontendHost = /^(?:www\.)?asmr(?:-\d+)?\.(?:one|com)$/i;

export type RegionGateRecoveryStatus = 'not-needed' | 'recovered' | 'failed';

type RecoveryWindow = Window & typeof globalThis & {
    __ASMR_ULTIMATE_REGION_RECOVERED__?: boolean;
    Vue?: { version?: string; use?: unknown };
    webpackJsonp?: unknown;
};

declare const unsafeWindow: RecoveryWindow | undefined;

interface RecoveryDocument {
    parsed: Document;
    scripts: Map<string, string>;
    styles: Map<string, string>;
    runtimeEntryUrl: string;
    runtimeScripts: Map<string, { code: string; id: number; dataHref: string }>;
    runtimeStyles: Map<string, { css: string; dataHref: string }>;
}

type RuntimeAssetRequest =
    | { kind: 'script'; id: number; url: string; dataHref: string }
    | { kind: 'style'; id: number; url: string; dataHref: string };

type PreparedRuntimeAsset =
    | { kind: 'script'; id: number; url: string; dataHref: string; body: string }
    | { kind: 'style'; id: number; url: string; dataHref: string; body: string };

export type RegionGateResourceKind = 'document' | 'script' | 'style';

function normalized(value: string | null | undefined): string {
    return String(value || '').trim().toLowerCase();
}

export function isTrustedAsmrFrontendHost(hostname: string): boolean {
    return trustedFrontendHost.test(hostname);
}

export function isRegionGateDocument(doc: Document = document): boolean {
    // Require the complete current gate signature. A work title, review, or
    // other user-controlled SPA content may quote the marker text and must
    // never trigger whole-document replacement.
    if (doc.querySelector('#q-app')) return false;
    return normalized(doc.title) === REGION_GATE_TITLE
        && normalized(doc.body?.textContent) === REGION_GATE_BODY_MARKER;
}

/**
 * At userscript document-start, resolve as soon as the exact hostile gate is
 * parsed, otherwise wait for the normal DOMContentLoaded boundary. Mutation
 * observers run before the next paint, allowing the recovery status to replace
 * the hostile sentence without waiting for the entire document lifecycle.
 */
export function waitForRegionGateOrDomReady(doc: Document = document): Promise<'gate' | 'ready'> {
    if (isRegionGateDocument(doc)) return Promise.resolve('gate');
    if (doc.readyState !== 'loading') return Promise.resolve('ready');

    return new Promise((resolve) => {
        let settled = false;
        const finish = (result: 'gate' | 'ready') => {
            if (settled) return;
            settled = true;
            observer.disconnect();
            doc.removeEventListener('DOMContentLoaded', onReady);
            resolve(result);
        };
        const onReady = () => finish(isRegionGateDocument(doc) ? 'gate' : 'ready');
        const observer = new MutationObserver(() => {
            if (isRegionGateDocument(doc)) finish('gate');
        });
        // Observe the Document itself: at the earliest document-start boundary
        // Firefox may not have created documentElement yet.
        observer.observe(doc, { childList: true, subtree: true, characterData: true });
        doc.addEventListener('DOMContentLoaded', onReady, { once: true });
    });
}

export function buildRegionGateProxyUrl(
    rawUrl: string,
    proxyBaseUrl = DEFAULT_API_PROXY,
    baseUrl = globalThis.location?.href,
): string {
    const source = new URL(rawUrl, baseUrl);
    if (!isTrustedAsmrFrontendHost(source.hostname)) {
        throw new Error('Region recovery refused an untrusted frontend host');
    }

    const proxy = new URL(proxyBaseUrl);
    const basePath = proxy.pathname.replace(/\/$/, '');
    proxy.pathname = `${basePath}${source.pathname.startsWith('/') ? source.pathname : `/${source.pathname}`}`;
    proxy.search = source.search;
    proxy.searchParams.set('__host', source.hostname);
    proxy.hash = '';
    return proxy.toString();
}

function cssString(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function rewriteRegionGateCssUrls(
    css: string,
    stylesheetUrl: string,
    proxyBaseUrl = DEFAULT_API_PROXY,
): string {
    return css.replace(
        /url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
        (match, _quote: string, rawValue: string) => {
            const value = rawValue.trim();
            if (!value || /^(?:data:|blob:|#)/i.test(value)) return match;
            try {
                const absolute = new URL(value, stylesheetUrl);
                if (!isTrustedAsmrFrontendHost(absolute.hostname)) return match;
                return `url("${cssString(buildRegionGateProxyUrl(absolute.toString(), proxyBaseUrl))}")`;
            } catch {
                return match;
            }
        },
    );
}

export interface WebpackRuntimeAssetPlan {
    scripts: Array<{ id: number; url: string; dataHref: string }>;
    styles: Array<{ id: number; url: string; dataHref: string }>;
}

function parseHashedChunkMap(literal: string): Map<number, string> {
    const entries = new Map<number, string>();
    for (const match of literal.matchAll(/(\d+):"([a-f0-9]+)"/gi)) {
        const id = Number(match[1]);
        const hash = match[2];
        if (!Number.isSafeInteger(id) || id < 0 || !/^[a-f0-9]{8,64}$/i.test(hash)) {
            throw new Error('Region recovery received an invalid Webpack chunk map');
        }
        if (entries.has(id)) throw new Error('Region recovery received duplicate Webpack chunk IDs');
        entries.set(id, hash);
    }
    const residue = literal
        .replace(/(\d+):"([a-f0-9]+)"/gi, '')
        .replace(/[{},\s]/g, '');
    if (entries.size === 0 || residue) {
        throw new Error('Region recovery could not safely parse the Webpack chunk map');
    }
    return entries;
}

function parseActiveCssChunkIds(literal: string): number[] {
    const ids: number[] = [];
    for (const match of literal.matchAll(/(\d+):1/g)) ids.push(Number(match[1]));
    const residue = literal.replace(/(\d+):1/g, '').replace(/[{},\s]/g, '');
    if (ids.length === 0 || residue || ids.some((id) => !Number.isSafeInteger(id) || id < 0)) {
        throw new Error('Region recovery could not safely parse active Webpack CSS chunks');
    }
    if (new Set(ids).size !== ids.length) {
        throw new Error('Region recovery received duplicate active Webpack CSS chunks');
    }
    return ids;
}

export function validateWebpackJsonpChunk(code: string, expectedId: number): void {
    const registration = code.match(
        /^\s*\(window\["webpackJsonp"\]=window\["webpackJsonp"\]\|\|\[\]\)\.push\(\[\[([\d,]+)\],\{/,
    );
    if (!registration) throw new Error('Region recovery refused an invalid Webpack JSONP chunk');
    const ids = registration[1].split(',').map(Number);
    if (ids.length !== 1 || ids[0] !== expectedId
        || ids.some((id) => !Number.isSafeInteger(id) || id < 0)) {
        throw new Error('Region recovery refused a mismatched Webpack JSONP chunk');
    }
    if (!/\]\);?\s*(?:\/\/# sourceMappingURL=.*)?\s*$/.test(code)) {
        throw new Error('Region recovery refused an incomplete Webpack JSONP chunk');
    }
}

/** Extract the current Webpack 4 lazy JS/CSS filenames without evaluating code. */
export function discoverWebpackRuntimeAssets(
    appCode: string,
    pageUrl: string,
): WebpackRuntimeAssetPlan | null {
    if (!appCode.includes('webpackJsonp') || !appCode.includes('.e=function')) return null;

    const jsMatch = appCode.match(
        /"js\/"\+\(\{0:"chunk-common"\}\[[$\w]+\]\|\|[$\w]+\)\+"\."\+(\{[^}]+\})\[[$\w]+\]\+"\.js"/,
    );
    const cssMatch = appCode.match(
        /"css\/"\+\(\{0:"chunk-common"\}\[[$\w]+\]\|\|[$\w]+\)\+"\."\+(\{[^}]+\})\[[$\w]+\]\+"\.css"/,
    );
    const activeCssMatch = appCode.match(
        /\.e=function\([$\w]+\)\{var\s+[$\w]+=\[\],[$\w]+=(\{[^}]+\})[;,]/,
    );
    if (!jsMatch || !cssMatch || !activeCssMatch) {
        throw new Error('Region recovery could not verify the Webpack runtime asset shape');
    }

    const jsChunks = parseHashedChunkMap(jsMatch[1]);
    const cssChunks = parseHashedChunkMap(cssMatch[1]);
    const activeCssIds = parseActiveCssChunkIds(activeCssMatch[1]);
    if (jsChunks.size + activeCssIds.length > MAX_RUNTIME_ASSETS) {
        throw new Error('Region recovery received too many Webpack runtime assets');
    }

    const filename = (id: number, hash: string, extension: 'js' | 'css') =>
        `${id === 0 ? 'chunk-common' : id}.${hash}.${extension}`;
    const scripts = Array.from(jsChunks.entries())
        .sort(([left], [right]) => left - right)
        .map(([id, hash]) => {
            const dataHref = `js/${filename(id, hash, 'js')}`;
            return { id, dataHref, url: new URL(`/${dataHref}`, pageUrl).toString() };
        });
    const styles = activeCssIds
        .sort((left, right) => left - right)
        .map((id) => {
            const hash = cssChunks.get(id);
            if (!hash) throw new Error('Region recovery found an unmapped Webpack CSS chunk');
            const dataHref = `css/${filename(id, hash, 'css')}`;
            return { id, dataHref, url: new URL(`/${dataHref}`, pageUrl).toString() };
        });
    return { scripts, styles };
}

function responseText(response: Awaited<ReturnType<typeof gmRequest>>): string {
    if (response.responseText) return response.responseText;
    return typeof response.response === 'string' ? response.response : '';
}

function acceptedMimeTypes(kind: RegionGateResourceKind): string[] {
    if (kind === 'document') return ['text/html', 'application/xhtml+xml'];
    if (kind === 'style') return ['text/css'];
    return ['javascript', 'ecmascript'];
}

function acceptHeader(kind: RegionGateResourceKind): string {
    if (kind === 'document') return 'text/html,application/xhtml+xml,*/*;q=0.8';
    if (kind === 'style') return 'text/css,*/*;q=0.8';
    return 'application/javascript,text/javascript,*/*;q=0.8';
}

function responseByteLength(text: string): number {
    return new Blob([text]).size;
}

/** Validate the redirect boundary, MIME type, and body size before use. */
export function validateRegionGateResponse(
    requestUrl: string,
    response: GmResponse,
    kind: RegionGateResourceKind,
    maxBytes: number,
): string {
    if (!response.finalUrl) {
        throw new Error('Region recovery could not verify the final response URL');
    }
    const expected = new URL(requestUrl);
    const actual = new URL(response.finalUrl);
    expected.hash = '';
    actual.hash = '';
    if (expected.toString() !== actual.toString()) {
        throw new Error('Region recovery refused a redirected response');
    }

    const contentType = (parseGmHeaders(response.responseHeaders)['content-type'] || '').toLowerCase();
    if (!contentType || !acceptedMimeTypes(kind).some((mime) => contentType.includes(mime))) {
        throw new Error(`Region recovery refused an unexpected ${kind} content type`);
    }

    const text = responseText(response);
    if (!text) throw new Error('Region recovery received an empty response');
    if (responseByteLength(text) > maxBytes) {
        throw new Error('Region recovery response exceeded the safety limit');
    }
    return text;
}

/**
 * Fetch executable/bootstrap content only from the real HTTPS host. The
 * maintained proxy remains available for non-executable CSS dependencies and
 * API fallback, but is never trusted as a source of origin-executed code.
 */
export async function requestRegionGateResource(
    url: string,
    kind: RegionGateResourceKind,
    maxBytes: number,
    externalSignal?: AbortSignal,
): Promise<string> {
    const target = new URL(url);
    if (target.protocol !== 'https:' || !isTrustedAsmrFrontendHost(target.hostname)) {
        throw new Error('Region recovery refused an untrusted resource request');
    }

    const controller = new AbortController();
    let exceededLimit = false;
    const forwardAbort = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    externalSignal?.addEventListener('abort', forwardAbort, { once: true });
    try {
        const response = await gmRequest({
            method: 'GET',
            url: target.toString(),
            headers: {
                Accept: acceptHeader(kind),
                'Accept-Language': RECOVERY_ACCEPT_LANGUAGE,
            },
            responseType: 'text',
            timeout: TIMING.HTTP_TIMEOUT_MS,
            signal: controller.signal,
            onprogress: ({ loaded, total, lengthComputable }) => {
                if (loaded > maxBytes || (lengthComputable && total > maxBytes)) {
                    exceededLimit = true;
                    controller.abort();
                }
            },
        });
        return validateRegionGateResponse(target.toString(), response, kind, maxBytes);
    } catch (error) {
        if (exceededLimit) throw new Error('Region recovery response exceeded the safety limit');
        throw error;
    } finally {
        externalSignal?.removeEventListener('abort', forwardAbort);
    }
}

function parseTrustedHostDocument(html: string, expectedHost: string): Document {
    if (responseByteLength(html) > MAX_DOCUMENT_BYTES) {
        throw new Error('Region recovery document exceeded the safety limit');
    }
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    if (!parsed.querySelector('#q-app') || isRegionGateDocument(parsed)) {
        throw new Error('Region recovery did not receive the ASMR.one application shell');
    }

    if (parsed.querySelector('meta[http-equiv="refresh" i]')) {
        throw new Error('Region recovery refused a refreshing application shell');
    }
    const bases = Array.from(parsed.querySelectorAll<HTMLBaseElement>('base[href]'));
    if (bases.length > 1) throw new Error('Region recovery received multiple base URLs');
    if (bases.length === 1) {
        const base = new URL(bases[0].getAttribute('href') || '', `https://${expectedHost}/`);
        if (base.protocol !== 'https:' || base.hostname !== expectedHost) {
            throw new Error('Region recovery refused an untrusted base URL');
        }
    }

    const externalAssets = parsed.querySelectorAll('script[src], link[rel="stylesheet"][href]');
    if (externalAssets.length === 0 || externalAssets.length > MAX_BOOTSTRAP_ASSETS) {
        throw new Error('Region recovery received an unexpected bootstrap asset set');
    }
    for (const element of externalAssets) {
        const reference = element.getAttribute('src') || element.getAttribute('href') || '';
        const resolved = new URL(reference, `https://${expectedHost}/`);
        if (resolved.protocol !== 'https:' || resolved.hostname !== expectedHost) {
            throw new Error('Region recovery refused a cross-origin bootstrap asset');
        }
        if (element.hasAttribute('integrity')) {
            throw new Error('Region recovery cannot safely inline an integrity-protected asset');
        }
        if (element.tagName.toLowerCase() === 'script' && !/\.m?js$/i.test(resolved.pathname)) {
            throw new Error('Region recovery refused a non-JavaScript bootstrap asset');
        }
        if (element.tagName.toLowerCase() === 'link' && !/\.css$/i.test(resolved.pathname)) {
            throw new Error('Region recovery refused a non-CSS stylesheet asset');
        }
    }
    return parsed;
}

async function fetchHostDocument(
    url: string,
    expectedHost: string,
    signal: AbortSignal,
): Promise<Document> {
    const direct = await requestRegionGateResource(url, 'document', MAX_DOCUMENT_BYTES, signal);
    return parseTrustedHostDocument(direct, expectedHost);
}

function resolveBootstrapAsset(reference: string, pageUrl: string, expectedHost: string): string {
    const resolved = new URL(reference, pageUrl);
    if (resolved.protocol !== 'https:' || resolved.hostname !== expectedHost) {
        throw new Error('Region recovery refused an untrusted bootstrap asset');
    }
    return resolved.toString();
}

async function prepareRecoveryDocument(pageUrl: string, expectedHost: string): Promise<RecoveryDocument> {
    const deadline = new AbortController();
    const deadlineTimer = window.setTimeout(() => deadline.abort(), RECOVERY_PREPARE_TIMEOUT_MS);
    try {
        const parsed = await fetchHostDocument(pageUrl, expectedHost, deadline.signal);
        const scriptElements = Array.from(parsed.querySelectorAll<HTMLScriptElement>('script[src]'));
        const styleElements = Array.from(parsed.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]'));

        const scripts = new Map<string, string>();
        const styles = new Map<string, string>();
        const runtimeScripts = new Map<string, { code: string; id: number; dataHref: string }>();
        const runtimeStyles = new Map<string, { css: string; dataHref: string }>();
        let runtimeEntryUrl = '';
        let runtimePlan: WebpackRuntimeAssetPlan | null = null;
        let totalAssetBytes = 0;
        const remainingLimit = () => {
            const remaining = MAX_BOOTSTRAP_BYTES - totalAssetBytes;
            if (remaining <= 0) {
                throw new Error('Region recovery bootstrap exceeded the aggregate safety limit');
            }
            return Math.min(MAX_SINGLE_ASSET_BYTES, remaining);
        };

        for (const element of scriptElements) {
            const reference = element.getAttribute('src') || '';
            const url = resolveBootstrapAsset(reference, pageUrl, expectedHost);
            const code = await requestRegionGateResource(url, 'script', remainingLimit(), deadline.signal);
            totalAssetBytes += responseByteLength(code);
            scripts.set(url, code);

            const discovered = discoverWebpackRuntimeAssets(code, pageUrl);
            if (discovered) {
                if (runtimePlan) throw new Error('Region recovery found multiple Webpack runtimes');
                runtimePlan = discovered;
                runtimeEntryUrl = url;
            }
        }
        for (const element of styleElements) {
            const reference = element.getAttribute('href') || '';
            const url = resolveBootstrapAsset(reference, pageUrl, expectedHost);
            const css = await requestRegionGateResource(url, 'style', remainingLimit(), deadline.signal);
            totalAssetBytes += responseByteLength(css);
            styles.set(url, rewriteRegionGateCssUrls(css, url));
        }

        if (!runtimePlan || !runtimeEntryUrl) {
            throw new Error('Region recovery could not find the host Webpack runtime');
        }
        const runtimeRequests: RuntimeAssetRequest[] = [
            ...runtimePlan.scripts.map((asset) => ({ ...asset, kind: 'script' as const })),
            ...runtimePlan.styles.map((asset) => ({ ...asset, kind: 'style' as const })),
        ];
        const preparedRuntimeAssets = await runPacedBatches<RuntimeAssetRequest, PreparedRuntimeAsset>(
            runtimeRequests,
            async (asset) => {
                if (asset.kind === 'script' && scripts.has(asset.url)) {
                    throw new Error('Region recovery received duplicate runtime script URLs');
                }
                if (asset.kind === 'style' && styles.has(asset.url)) {
                    throw new Error('Region recovery received duplicate runtime style URLs');
                }
                const body = await requestRegionGateResource(
                    asset.url,
                    asset.kind,
                    Math.min(MAX_RUNTIME_ASSET_BYTES, remainingLimit()),
                    deadline.signal,
                );
                if (asset.kind === 'script') validateWebpackJsonpChunk(body, asset.id);
                const bodyBytes = responseByteLength(body);
                if (totalAssetBytes + bodyBytes > MAX_BOOTSTRAP_BYTES) {
                    throw new Error('Region recovery bootstrap exceeded the aggregate safety limit');
                }
                // JavaScript executes callbacks atomically between awaits, so
                // this shared budget cannot be interleaved between the check
                // and increment even while a batch has four requests in flight.
                totalAssetBytes += bodyBytes;
                return { ...asset, body };
            },
            { batchSize: RUNTIME_FETCH_CONCURRENCY, delayMs: 0 },
        );
        const failedRuntimeAsset = preparedRuntimeAssets.find(
            (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        if (failedRuntimeAsset) throw failedRuntimeAsset.reason;
        for (const result of preparedRuntimeAssets) {
            if (result.status !== 'fulfilled') continue;
            const asset = result.value;
            if (asset.kind === 'script') {
                if (runtimeScripts.has(asset.url)) {
                    throw new Error('Region recovery received duplicate runtime script URLs');
                }
                runtimeScripts.set(asset.url, {
                    code: asset.body,
                    id: asset.id,
                    dataHref: asset.dataHref,
                });
            } else {
                if (runtimeStyles.has(asset.url)) {
                    throw new Error('Region recovery received duplicate runtime style URLs');
                }
                runtimeStyles.set(asset.url, {
                    css: rewriteRegionGateCssUrls(asset.body, asset.url),
                    dataHref: asset.dataHref,
                });
            }
        }
        return {
            parsed,
            scripts,
            styles,
            runtimeEntryUrl,
            runtimeScripts,
            runtimeStyles,
        };
    } finally {
        clearTimeout(deadlineTimer);
    }
}

function copyAttributes(source: Element, target: Element, omitted: Set<string> = new Set()): void {
    for (const attribute of Array.from(source.attributes)) {
        if (!omitted.has(attribute.name.toLowerCase())) {
            target.setAttribute(attribute.name, attribute.value);
        }
    }
}

interface DocumentSnapshot {
    htmlAttributes: Array<[string, string]>;
    bodyAttributes: Array<[string, string]>;
    headNodes: Node[];
    bodyNodes: Node[];
}

function showRecoveryStatus(): void {
    const status = document.createElement('main');
    status.id = 'asmr-region-recovery-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.style.cssText = [
        'min-height:100vh',
        'display:grid',
        'place-items:center',
        'padding:24px',
        'box-sizing:border-box',
        'background:#121212',
        'color:#fff',
        'font:500 16px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        'text-align:center',
    ].join(';');

    const content = document.createElement('div');
    const spinner = document.createElement('div');
    spinner.setAttribute('aria-hidden', 'true');
    spinner.style.cssText = [
        'width:32px',
        'height:32px',
        'margin:0 auto 16px',
        'border:3px solid rgba(255,255,255,.25)',
        'border-top-color:#7c4dff',
        'border-radius:50%',
        'animation:asmr-region-recovery-spin .8s linear infinite',
    ].join(';');
    const label = document.createElement('div');
    label.textContent = I18n.t('regionGateRecovering');
    const style = document.createElement('style');
    style.textContent = '@keyframes asmr-region-recovery-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){#asmr-region-recovery-status div[aria-hidden="true"]{animation:none}}';

    content.append(spinner, label);
    status.append(content);
    document.body.replaceChildren(status);
    document.head.append(style);
}

function attributeSnapshot(element: Element): Array<[string, string]> {
    return Array.from(element.attributes).map((attribute) => [attribute.name, attribute.value]);
}

function captureDocumentSnapshot(): DocumentSnapshot {
    return {
        htmlAttributes: attributeSnapshot(document.documentElement),
        bodyAttributes: attributeSnapshot(document.body),
        headNodes: Array.from(document.head.childNodes).map((node) => node.cloneNode(true)),
        bodyNodes: Array.from(document.body.childNodes).map((node) => node.cloneNode(true)),
    };
}

function restoreAttributes(element: Element, attributes: Array<[string, string]>): void {
    for (const attribute of Array.from(element.attributes)) element.removeAttribute(attribute.name);
    for (const [name, value] of attributes) element.setAttribute(name, value);
}

function restoreDocumentSnapshot(snapshot: DocumentSnapshot): void {
    restoreAttributes(document.documentElement, snapshot.htmlAttributes);
    restoreAttributes(document.body, snapshot.bodyAttributes);
    document.head.replaceChildren(...snapshot.headNodes.map((node) => node.cloneNode(true)));
    document.body.replaceChildren(...snapshot.bodyNodes.map((node) => node.cloneNode(true)));
}

function preparePageGlobalForHost(): () => void {
    // vite-plugin-monkey keeps the userscript's Vue 3 dependency in its
    // sandbox. Lightweight E2E injectors and some managers may expose it on
    // the page global instead, where it would shadow the host's bundled Vue 2
    // while the recovered app boots. The imported userscript binding remains
    // intact, so only remove that incompatible page-global copy.
    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window as RecoveryWindow;
    const exposedVue = pageWindow.Vue;
    const shouldRemove = exposedVue?.version?.startsWith('3.') && typeof exposedVue.use !== 'function';
    const hadWebpackJsonp = Object.prototype.hasOwnProperty.call(pageWindow, 'webpackJsonp');
    const previousWebpackJsonp = pageWindow.webpackJsonp;
    if (shouldRemove) {
        try {
            delete pageWindow.Vue;
        } catch {
            pageWindow.Vue = undefined;
        }
    }
    return () => {
        if (shouldRemove) pageWindow.Vue = exposedVue;
        if (hadWebpackJsonp) {
            pageWindow.webpackJsonp = previousWebpackJsonp;
        } else {
            try {
                delete pageWindow.webpackJsonp;
            } catch {
                pageWindow.webpackJsonp = undefined;
            }
        }
    };
}

function hostAppBooted(): boolean {
    const qApp = document.querySelector('#q-app');
    return !!qApp && qApp.childElementCount > 0;
}

function waitForHostAppBoot(timeoutMs = HOST_BOOT_TIMEOUT_MS): Promise<boolean> {
    if (hostAppBooted()) return Promise.resolve(true);
    return new Promise((resolve) => {
        let settled = false;
        const finish = (booted: boolean) => {
            if (settled) return;
            settled = true;
            observer.disconnect();
            clearTimeout(timer);
            resolve(booted);
        };
        const observer = new MutationObserver(() => {
            if (hostAppBooted()) finish(true);
        });
        observer.observe(document.body, { childList: true, subtree: true });
        const timer = window.setTimeout(() => finish(hostAppBooted()), timeoutMs);
    });
}

function installRecoveryDocument(recovery: RecoveryDocument, pageUrl: string, expectedHost: string): void {
    const preservedStyles = Array.from(document.head.querySelectorAll('style'))
        .filter((style) => style.textContent?.includes(USER_STYLE_MARKER))
        .map((style) => style.cloneNode(true));
    const nativeCreate = Document.prototype.createElement.bind(document);
    let runtimeAssetsInstalled = false;

    const installRuntimeAssets = (scriptParent: ParentNode): void => {
        if (runtimeAssetsInstalled) return;
        runtimeAssetsInstalled = true;
        for (const [url, asset] of recovery.runtimeStyles) {
            const style = nativeCreate('style');
            style.dataset.asmrRegionSource = url;
            // Webpack's CSS loader checks this exact relative value before it
            // attempts a network request for the lazy chunk.
            style.setAttribute('data-href', asset.dataHref);
            style.textContent = asset.css;
            document.head.append(style);
        }
        for (const [url, asset] of recovery.runtimeScripts) {
            const script = nativeCreate('script');
            script.dataset.asmrRegionSource = url;
            script.setAttribute('data-href', asset.dataHref);
            script.textContent = `${asset.code}\n//# sourceURL=${url}`;
            scriptParent.append(script);
        }
    };

    const appendNode = (parent: ParentNode, source: Node): void => {
        if (source.nodeType !== Node.ELEMENT_NODE) {
            parent.append(document.importNode(source, true));
            return;
        }

        const sourceElement = source as Element;
        const tag = sourceElement.tagName.toLowerCase();
        if (tag === 'script') {
            const sourceScript = sourceElement as HTMLScriptElement;
            const script = nativeCreate('script');
            copyAttributes(sourceScript, script, new Set(['src', 'crossorigin']));
            if (sourceScript.hasAttribute('src')) {
                const url = resolveBootstrapAsset(sourceScript.getAttribute('src') || '', pageUrl, expectedHost);
                const code = recovery.scripts.get(url);
                if (code == null) throw new Error('Region recovery lost a prepared script asset');
                if (url === recovery.runtimeEntryUrl) installRuntimeAssets(parent);
                script.dataset.asmrRegionSource = url;
                script.textContent = `${code}\n//# sourceURL=${url}`;
            } else {
                script.textContent = sourceScript.textContent || '';
            }
            parent.append(script);
            return;
        }

        if (tag === 'link' && normalized(sourceElement.getAttribute('rel')) === 'stylesheet') {
            const sourceLink = sourceElement as HTMLLinkElement;
            const url = resolveBootstrapAsset(sourceLink.getAttribute('href') || '', pageUrl, expectedHost);
            const css = recovery.styles.get(url);
            if (css == null) throw new Error('Region recovery lost a prepared stylesheet asset');
            const style = nativeCreate('style');
            if (sourceLink.media) style.media = sourceLink.media;
            style.dataset.asmrRegionSource = url;
            style.textContent = css;
            parent.append(style);
            return;
        }

        parent.append(document.importNode(source, true));
    };

    for (const attribute of Array.from(document.documentElement.attributes)) {
        document.documentElement.removeAttribute(attribute.name);
    }
    copyAttributes(recovery.parsed.documentElement, document.documentElement);

    document.head.replaceChildren();
    for (const node of Array.from(recovery.parsed.head.childNodes)) appendNode(document.head, node);
    for (const style of preservedStyles) document.head.append(style);

    for (const attribute of Array.from(document.body.attributes)) {
        document.body.removeAttribute(attribute.name);
    }
    copyAttributes(recovery.parsed.body, document.body);
    document.body.replaceChildren();
    for (const node of Array.from(recovery.parsed.body.childNodes)) appendNode(document.body, node);
}

/**
 * Restore the host SPA only when the exact language-gate document is present.
 * Failure is non-destructive: the original gate page remains visible.
 */
export async function recoverRegionGateIfNeeded(): Promise<RegionGateRecoveryStatus> {
    if (!isRegionGateDocument()) return 'not-needed';

    const recoveryWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window as RecoveryWindow;
    if (recoveryWindow.__ASMR_ULTIMATE_REGION_RECOVERED__) return 'recovered';
    if (!isTrustedAsmrFrontendHost(window.location.hostname)) return 'failed';

    let snapshot: DocumentSnapshot | null = null;
    let restorePageGlobal: (() => void) | null = null;
    try {
        const pageUrl = window.location.href;
        const expectedHost = window.location.hostname;
        snapshot = captureDocumentSnapshot();
        showRecoveryStatus();
        const recovery = await prepareRecoveryDocument(pageUrl, expectedHost);
        restorePageGlobal = preparePageGlobalForHost();
        installRecoveryDocument(recovery, pageUrl, expectedHost);
        if (!await waitForHostAppBoot()) {
            throw new Error('Recovered ASMR.one application shell did not boot');
        }
        recoveryWindow.__ASMR_ULTIMATE_REGION_RECOVERED__ = true;
        // The recovered shell rewrites same-host CSS dependencies through the
        // maintained relay. Record this before normal feature initialization;
        // late banner subscribers are notified immediately.
        recordProxyUse();
        Logger.info('[RegionGate] Restored the ASMR.one frontend with Chinese-first privileged requests');
        return 'recovered';
    } catch (error) {
        if (snapshot) restoreDocumentSnapshot(snapshot);
        restorePageGlobal?.();
        const message = error instanceof Error ? error.message : 'Unknown recovery error';
        Logger.error(`[RegionGate] Automatic frontend recovery failed: ${message}`);
        return 'failed';
    }
}
