/**
 * HttpClient - Centralized HTTP abstraction with caching, retry, and rate limiting
 *
 * Exports:
 * - HttpClient          — singleton for all HTTP operations
 * - retryWithBackoff()  — generic retry utility any module can use
 * - gmRequest()         — promisified GM_xmlhttpRequest
 * - KikoeruApiClient    — wraps the host app's axios instance
 * - ExternalApiClient   — client for third-party services with rate limiting
 */

import { monkeyWindow } from '$';
import { SharedCache } from '../core/Cache';
import { Logger } from '../core/Utils';
import { TIMING, RETRY } from '../core/Constants';

/**
 * Get GM_xmlhttpRequest at runtime (not at module load time).
 * vite-plugin-monkey's IIFE pattern captures the value too early in dev mode.
 */
function getMonkeyWindow(): Window & typeof globalThis {
    const origin = globalThis.location?.origin;
    const key = origin ? `__monkeyWindow-${origin}` : undefined;
    const bridged = key ? (globalThis.document as unknown as Record<string, unknown>)?.[key] : undefined;
    return (bridged ?? monkeyWindow ?? globalThis) as Window & typeof globalThis;
}

function getGM_xmlhttpRequest() {
    const win = getMonkeyWindow() as unknown as Record<string, unknown>;
    const gm = win?.GM_xmlhttpRequest ?? (globalThis as unknown as Record<string, unknown>).GM_xmlhttpRequest;
    if (!gm) {
        // Only log once to avoid spam
        const g = globalThis as unknown as Record<string, unknown>;
        if (!g.__gm_logged) {
            Logger.debug('[HttpClient] GM_xmlhttpRequest not found in window or globalThis');
            g.__gm_logged = true;
        }
    }
    return gm;
}

// =============================================================================
// Types
// =============================================================================

export interface RetryConfig {
    /** Total number of attempts (1 = no retry). Default: 2 */
    attempts?: number;
    /** Initial backoff delay in ms. Default: 500 */
    backoffMs?: number;
    /** Exponential multiplier per attempt. Default: 2 */
    multiplier?: number;
    /** Optional predicate — return false to abort retries early */
    shouldRetry?: (error: unknown) => boolean;
}

export interface HttpRequestConfig {
    params?: Record<string, string | number | boolean | undefined>;
    headers?: Record<string, string>;
    timeout?: number;
    cache?: { key: string; ttlMs: number };
    retry?: RetryConfig;
    useCorsProxy?: boolean;
}

export interface HttpResponse<T> {
    data: T;
    status: number;
    headers: Record<string, string>;
    cached: boolean;
}

export interface GmRequestConfig {
    method?: string;
    url: string;
    headers?: Record<string, string>;
    data?: string;
    responseType?: 'blob' | 'json' | 'text' | 'arraybuffer';
    timeout?: number;
    onprogress?: (event: { loaded: number; total: number; lengthComputable: boolean }) => void;
}

export interface GmResponse {
    status: number;
    statusText: string;
    responseText: string;
    response: unknown;
    responseHeaders: string;
}

/** Alias for fetch RequestCredentials — mirrors the built-in type for clarity */
type RequestCredentialsType = RequestCredentials;

// =============================================================================
// Shared utilities
// =============================================================================

const DEFAULT_RETRY: Required<Pick<RetryConfig, 'attempts' | 'backoffMs' | 'multiplier'>> = {
    attempts: 2,
    backoffMs: 500,
    multiplier: 2,
};

/**
 * Custom error class for HTTP errors that preserves the status code.
 */
export class HttpError extends Error {
    constructor(public readonly status: number, message: string) {
        super(message);
        this.name = 'HttpError';
    }

    get retryable(): boolean {
        return this.status === 429 || this.status >= 500;
    }
}

/**
 * Retry an async operation with exponential backoff.
 *
 * ```ts
 * const data = await retryWithBackoff(() => fetchSomething(), { attempts: 3 });
 * ```
 */
export async function retryWithBackoff<T>(
    fn: () => Promise<T>,
    config?: RetryConfig,
): Promise<T> {
    const attempts = config?.attempts ?? DEFAULT_RETRY.attempts;
    const backoffMs = config?.backoffMs ?? DEFAULT_RETRY.backoffMs;
    const multiplier = config?.multiplier ?? DEFAULT_RETRY.multiplier;
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            // Allow caller to abort retries early
            if (config?.shouldRetry && !config.shouldRetry(error)) break;

            // Don't retry non-retryable HTTP errors (4xx except 429)
            if (error instanceof HttpError && !error.retryable) break;

            if (attempt < attempts - 1) {
                const delay = backoffMs * Math.pow(multiplier, attempt);
                Logger.warn(
                    `[retry] Attempt ${attempt + 1}/${attempts} failed, retrying in ${delay}ms`,
                    error instanceof Error ? error.message : error,
                );
                await sleep(delay);
            }
        }
    }

    throw lastError ?? new Error('All retry attempts failed');
}

/**
 * Promisified GM_xmlhttpRequest. Rejects on network error, timeout, or HTTP >= 400.
 *
 * ```ts
 * const res = await gmRequest({ url: 'https://api.example.com/data' });
 * const json = JSON.parse(res.responseText);
 * ```
 */
export function gmRequest(config: GmRequestConfig): Promise<GmResponse> {
    return new Promise((resolve, reject) => {
        const gmXhr = getGM_xmlhttpRequest();
        if (typeof gmXhr !== 'function') {
            reject(new Error('GM_xmlhttpRequest not available'));
            return;
        }

        gmXhr({
            method: config.method || 'GET',
            url: config.url,
            headers: config.headers,
            data: config.data,
            responseType: config.responseType,
            timeout: config.timeout ?? TIMING.HTTP_TIMEOUT_MS,
            onprogress: config.onprogress ? (event: { loaded: number; total: number; lengthComputable: boolean }) => {
                config.onprogress!(event);
            } : undefined,
            onload: (res: GmResponse) => {
                if (res.status >= 400) {
                    reject(new HttpError(res.status, `HTTP ${res.status}: ${res.statusText || 'Error'}`));
                } else {
                    resolve(res);
                }
            },
            onerror: (err: unknown) => reject(err || new Error('Network error')),
            ontimeout: () => reject(new Error('Request timeout')),
        });
    });
}

/**
 * Parse raw GM_xmlhttpRequest response headers into a Record.
 */
export function parseGmHeaders(raw?: string): Record<string, string> {
    const headers: Record<string, string> = {};
    if (!raw) return headers;
    for (const line of raw.split('\r\n')) {
        const [key, ...values] = line.split(':');
        if (key && values.length) {
            headers[key.toLowerCase().trim()] = values.join(':').trim();
        }
    }
    return headers;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSameOrigin(url: string): boolean {
    try {
        return new URL(url, window.location.href).origin === window.location.origin;
    } catch {
        return false;
    }
}

function buildUrl(baseUrl: string, params?: Record<string, string | number | boolean | undefined>): string {
    if (!params) return baseUrl;
    const url = new URL(baseUrl, window.location.origin);
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') {
            url.searchParams.set(key, String(value));
        }
    }
    return url.toString();
}

// =============================================================================
// HttpClient
// =============================================================================

class HttpClientImpl {
    private inFlight = new Map<string, Promise<unknown>>();
    private rateLimitUntil: Record<string, number> = {};

    // ----- Public API --------------------------------------------------------

    async get<T = unknown>(url: string, config?: HttpRequestConfig): Promise<HttpResponse<T>> {
        const fullUrl = buildUrl(url, config?.params);
        return this.dedupedRequest<T>(fullUrl, config, () =>
            retryWithBackoff(
                () => this.doFetch<T>('GET', fullUrl, undefined, config),
                config?.retry,
            ),
        );
    }

    async post<T = unknown>(url: string, data?: unknown, config?: HttpRequestConfig): Promise<HttpResponse<T>> {
        Logger.debug(`[HttpClient] POST ${url}`, data);
        return retryWithBackoff(
            () => this.doFetch<T>('POST', url, data, config),
            config?.retry,
        );
    }

    /**
     * Fetch JSON using GM_xmlhttpRequest to bypass CORS, with fetch fallback.
     */
    async getJsonViaCors<T = unknown>(url: string, config?: HttpRequestConfig): Promise<HttpResponse<T>> {
        const fullUrl = buildUrl(url, config?.params);
        return this.dedupedRequest<T>(fullUrl, config, () =>
            retryWithBackoff(
                () => this.corsJsonFetch<T>(fullUrl, config),
                config?.retry,
            ),
        );
    }

    async getBlob(url: string, config?: HttpRequestConfig): Promise<Blob | null> {
        const same = isSameOrigin(url);
        Logger.debug(`[HttpClient] getBlob: ${url}`, { isSameOrigin: same });

        const fetchBlob = same
            ? () => this.fetchBlobViaFetch(url, 'include')
            : typeof getGM_xmlhttpRequest() === 'function'
                ? () => this.fetchBlobViaGM(url)
                : () => this.fetchBlobViaFetch(url, 'omit');

        return retryWithBackoff(fetchBlob, config?.retry ?? RETRY.BLOB);
    }

    // ----- Rate limit helpers ------------------------------------------------

    isRateLimited(domain: string): boolean {
        const until = this.rateLimitUntil[domain];
        return until ? Date.now() < until : false;
    }

    getRateLimitRemaining(domain: string): number {
        const until = this.rateLimitUntil[domain];
        return until ? Math.max(0, until - Date.now()) : 0;
    }

    setRateLimit(domain: string, durationMs: number): void {
        this.rateLimitUntil[domain] = Date.now() + durationMs;
        Logger.warn(`[HttpClient] Rate limited for ${domain}: ${durationMs}ms`);
    }

    clearRateLimit(domain: string): void {
        delete this.rateLimitUntil[domain];
    }

    // ----- Private -----------------------------------------------------------

    /**
     * Shared deduplication + caching wrapper used by `get()` and `getJsonViaCors()`.
     */
    private async dedupedRequest<T>(
        fullUrl: string,
        config: HttpRequestConfig | undefined,
        execute: () => Promise<HttpResponse<T>>,
    ): Promise<HttpResponse<T>> {
        const cacheKey = config?.cache?.key || fullUrl;

        // Cache check
        if (config?.cache) {
            const cached = SharedCache.get<T>(cacheKey);
            if (cached !== null) {
                Logger.debug(`[HttpClient] Cache hit: ${cacheKey}`);
                return { data: cached, status: 200, headers: {}, cached: true };
            }
        }

        // In-flight deduplication
        if (this.inFlight.has(fullUrl)) {
            Logger.debug(`[HttpClient] Dedup: ${fullUrl}`);
            const result = await this.inFlight.get(fullUrl) as T;
            return { data: result, status: 200, headers: {}, cached: false };
        }

        const request = execute();
        const promise = request.then((r) => r.data);
        // Prevent unhandled rejection if the request fails and no parallel call awaits this promise
        promise.catch(err => {
            Logger.debug(`[HttpClient] Deduped request failed (handled by caller): ${fullUrl}`, err);
        });
        this.inFlight.set(fullUrl, promise);

        try {
            const response = await request;

            if (config?.cache && response.status >= 200 && response.status < 300) {
                SharedCache.set(cacheKey, response.data, config.cache.ttlMs);
            }

            return { ...response, cached: false };
        } finally {
            this.inFlight.delete(fullUrl);
        }
    }

    /**
     * Single CORS JSON fetch attempt: tries GM_xmlhttpRequest first, falls back to fetch.
     */
    private async corsJsonFetch<T>(url: string, config?: HttpRequestConfig): Promise<HttpResponse<T>> {
        if (typeof getGM_xmlhttpRequest() === 'function') {
            try {
                return await this.fetchJsonViaGM<T>(url, config);
            } catch (gmError) {
                // Don't fall back to fetch for HTTP errors — the server responded,
                // and fetch will likely fail due to CORS anyway.
                if (gmError instanceof HttpError) throw gmError;
                Logger.warn('[HttpClient] GM_xmlhttpRequest failed, falling back to fetch:', gmError);
            }
        } else {
            Logger.warn('[HttpClient] GM_xmlhttpRequest not available, falling back to fetch (CORS likely to fail)');
        }
        return this.doFetch<T>('GET', url, undefined, config);
    }

    private async doFetch<T>(
        method: string,
        url: string,
        data?: unknown,
        config?: HttpRequestConfig,
    ): Promise<HttpResponse<T>> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...config?.headers,
        };

        const fetchConfig: RequestInit = {
            method,
            headers,
            credentials: 'include' as RequestCredentialsType,
        };
        if (data && method !== 'GET') {
            fetchConfig.body = JSON.stringify(data);
        }

        const response = await fetch(url, fetchConfig);

        if (!response.ok) {
            throw new HttpError(
                response.status,
                `HTTP ${response.status}: ${response.statusText}`,
            );
        }

        const text = await response.text();
        let responseData: T;
        try {
            responseData = JSON.parse(text) as T;
        } catch {
            throw new Error(`Invalid JSON response from ${url}: ${text.slice(0, 100)}…`);
        }

        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => { responseHeaders[key] = value; });

        return { data: responseData, status: response.status, headers: responseHeaders, cached: false };
    }

    private async fetchJsonViaGM<T>(url: string, config?: HttpRequestConfig): Promise<HttpResponse<T>> {
        const res = await gmRequest({
            url,
            headers: { Accept: 'application/json', ...config?.headers },
            responseType: 'json',
            timeout: config?.timeout ?? TIMING.HTTP_TIMEOUT_MS,
        });

        return {
            data: res.response as T,
            status: res.status,
            headers: parseGmHeaders(res.responseHeaders),
            cached: false,
        };
    }

    private async fetchBlobViaFetch(url: string, credentials: RequestCredentialsType): Promise<Blob | null> {
        const response = await fetch(url, { credentials });
        if (!response.ok) throw new HttpError(response.status, `Blob fetch failed: ${response.status}`);
        return response.blob();
    }

    private async fetchBlobViaGM(url: string): Promise<Blob | null> {
        const res = await gmRequest({ url, responseType: 'blob' });
        return (res.response as Blob) ?? null;
    }
}

export const HttpClient = new HttpClientImpl();

// =============================================================================
// Specialized API Clients
// =============================================================================

/**
 * Kikoeru API Client — wraps the host app's axios instance with deduplication.
 */
export class KikoeruApiClient {
    private axios: { get: <T>(url: string, config?: { params?: Record<string, unknown> }) => Promise<{ data: T }> };
    private inFlight = new Map<string, Promise<unknown>>();

    constructor(axios: { get: <T>(url: string, config?: { params?: Record<string, unknown> }) => Promise<{ data: T }> }) {
        this.axios = axios;
    }

    async getWorks<T = unknown>(params?: Record<string, unknown>): Promise<T> {
        return this.get<T>('/api/works', params);
    }

    async getWork<T = unknown>(id: string | number): Promise<T> {
        return this.get<T>(`/api/work/${id}`);
    }

    async getTags<T = unknown>(): Promise<{ data: T[] }> {
        return this.get<{ data: T[] }>('/api/tags');
    }

    async get<T = unknown>(path: string, params?: Record<string, unknown>): Promise<T> {
        const cacheKey = `${path}:${params ? JSON.stringify(params) : ''}`;

        if (this.inFlight.has(cacheKey)) {
            Logger.debug(`[KikoeruApiClient] Dedup: ${cacheKey}`);
            return this.inFlight.get(cacheKey) as Promise<T>;
        }

        Logger.debug(`[KikoeruApiClient] GET ${path}`, params);
        const request = this.axios.get<T>(path, { params }).then((res) => res.data);
        this.inFlight.set(cacheKey, request);

        try {
            return await request;
        } finally {
            this.inFlight.delete(cacheKey);
        }
    }
}

/**
 * External API Client for third-party services (DLsite, etc.)
 */
export class ExternalApiClient {
    private baseUrl: string;
    private defaultHeaders: Record<string, string>;
    private rateLimitKey: string;

    constructor(baseUrl: string, options?: {
        headers?: Record<string, string>;
        rateLimitKey?: string;
    }) {
        this.baseUrl = baseUrl;
        this.defaultHeaders = options?.headers || {};
        this.rateLimitKey = options?.rateLimitKey || new URL(baseUrl).hostname;
    }

    isRateLimited(): boolean {
        return HttpClient.isRateLimited(this.rateLimitKey);
    }

    getRateLimitRemaining(): number {
        return HttpClient.getRateLimitRemaining(this.rateLimitKey);
    }

    async get<T = unknown>(path: string, config?: HttpRequestConfig): Promise<T> {
        if (this.isRateLimited()) throw new Error(`Rate limited for ${this.rateLimitKey}`);
        const url = `${this.baseUrl}${path}`;
        const response = await HttpClient.get<T>(url, {
            ...config,
            headers: { ...this.defaultHeaders, ...config?.headers },
        });
        return response.data;
    }

    async post<T = unknown>(path: string, data?: unknown, config?: HttpRequestConfig): Promise<T> {
        if (this.isRateLimited()) throw new Error(`Rate limited for ${this.rateLimitKey}`);
        const url = `${this.baseUrl}${path}`;
        const response = await HttpClient.post<T>(url, data, {
            ...config,
            headers: { ...this.defaultHeaders, ...config?.headers },
        });
        return response.data;
    }

    handleRateLimit(retryAfterSeconds?: number): void {
        const duration = (retryAfterSeconds || 60) * 1000;
        HttpClient.setRateLimit(this.rateLimitKey, duration);
    }
}
