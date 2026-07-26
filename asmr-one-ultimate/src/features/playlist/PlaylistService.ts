import { KikoeruBridge } from '../../infrastructure/KikoeruBridge';
import { Logger } from '../../core/Utils';
import { HttpClient, HttpError } from '../../infrastructure/HttpClient';

import { DEFAULT_API_SERVER, DEFAULT_API_PROXY } from '../../core/Constants';
import { Config } from '../../core/Config';
import { recordProxyUse } from '../../core/ProxyUsage';
import { readHostAuthToken } from '../../core/hostAuthToken';

export { hasUsedProxy, onProxyUse } from '../../core/ProxyUsage';

/**
 * Get the API base URL from the host app's axios baseURL (set by "Select server" setting)
 */
export function getApiBaseUrl(): string {
    try {
        const bridge = KikoeruBridge.getInstance();
        const baseURL = bridge.axios.defaults?.baseURL;
        if (baseURL && baseURL.startsWith('http')) {
            const normalized = baseURL.replace(/\/$/, '');
            return normalized.endsWith('/api')
                ? normalized.slice(0, -4)
                : normalized;
        }
    } catch { /* ignore */ }
    return DEFAULT_API_SERVER;
}

export function getAuthHeader(): Record<string, string> {
    try {
        const bridge = KikoeruBridge.getInstance();
        const axiosDefaults = bridge.axios.defaults as Record<string, unknown>;
        const headers = (axiosDefaults?.headers as Record<string, Record<string, unknown>> | undefined)?.common;
        const axiosHeader = (headers?.Authorization || headers?.authorization) as string | undefined;
        if (typeof axiosHeader === 'string' && axiosHeader.trim()) {
            return { Authorization: axiosHeader.trim() };
        }
    } catch {
        // ignore
    }
    const token = readHostAuthToken();
    if (token) return { Authorization: `Bearer ${token}` };
    return {};
}

/**
 * Make API request using host axios first (auth + origin), then fall back to GM_xmlhttpRequest.
 */
export async function apiRequest<T>(endpoint: string, params?: Record<string, string | number>): Promise<T> {
    try {
        const bridge = KikoeruBridge.getInstance();
        if (bridge?.axios?.get) {
            const response = await bridge.axios.get<T>(endpoint, { params });
            return response.data;
        }
    } catch (error) {
        const status = (error as { response?: { status?: number } })?.response?.status;
        if (status === 401) {
            Logger.warn(`[PlaylistDiscovery] 401 for ${endpoint} via axios, falling back to CORS request...`);
        } else {
            const errCode = (error as { code?: string })?.code || 'UNKNOWN';
            const errMsg = (error as { message?: string })?.message || String(error);
            Logger.warn(`[PlaylistDiscovery] Axios request failed for ${endpoint} (Status: ${status} Code: ${errCode}): ${errMsg}, falling back to CORS request...`);
        }
    }

    const apiServerUrl = getApiBaseUrl();
    const url = `${apiServerUrl}${endpoint}`;

    const run = (headers: Record<string, string>) =>
        HttpClient.getJsonViaCors<T>(url, {
            params,
            headers,
            retry: { attempts: 2, backoffMs: 500 },
        }).then((res) => res.data);

    try {
        return await run({
            Accept: 'application/json',
            ...getAuthHeader(),
        });
    } catch (error) {
        if (error instanceof HttpError && error.status === 401) {
            Logger.warn(`[PlaylistDiscovery] 401 for ${endpoint}, retrying without auth...`);
            return await run({ Accept: 'application/json' });
        }
        const proxied = await proxyRequest<T>(endpoint, params);
        if (proxied !== null) return proxied;
        throw error;
    }
}

/**
 * Get the API proxy base URL (Cloudflare Worker relaying the asmr API).
 * A user-configured URL wins; empty config falls back to the default worker.
 */
export function getApiProxyUrl(): string {
    try {
        const configured = Config.get('apiProxyUrl');
        if (typeof configured === 'string' && configured.trim().startsWith('http')) {
            return configured.trim().replace(/\/$/, '');
        }
    } catch { /* config not ready yet — use default */ }
    return DEFAULT_API_PROXY;
}

/**
 * Last-resort API route: relay the request through the Cloudflare Worker proxy,
 * pinning the currently-selected API mirror via `__host`.
 * Returns null when the proxy also fails.
 */
export async function proxyRequest<T>(endpoint: string, params?: Record<string, string | number>): Promise<T | null> {
    const proxyBase = getApiProxyUrl();
    if (!proxyBase) return null;

    const apiHost = getApiBaseUrl().replace(/^https?:\/\//, '');
    try {
        const res = await HttpClient.getJsonViaCors<T>(`${proxyBase}${endpoint}`, {
            params: { ...(params || {}), __host: apiHost },
            headers: { Accept: 'application/json', ...getAuthHeader() },
            retry: { attempts: 2, backoffMs: 500 },
        });
        recordProxyUse();
        return res.data;
    } catch (proxyError) {
        Logger.warn(`[PlaylistDiscovery] Proxy fallback failed for ${endpoint}: ${(proxyError as Error)?.message || proxyError}`);
        return null;
    }
}
