import { HttpClient } from '../infrastructure/HttpClient';
import { Logger, Config } from '../core/Utils';
import { DEFAULT_DLSITE_PROXY } from '../core/Constants';
import type {
    DLsiteProductApiResponse,
    DLsiteProductApiParams,
    DLsiteReviewApiResponse,
    DLsiteReviewApiParams,
} from '../types/dlsite';

type ApiQueryValue = string | number | boolean;
type ApiQueryParams = Record<string, ApiQueryValue>;

function isValidProxyUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch {
        return false;
    }
}

function getProxyBaseUrl(): string {
    let raw = String(Config.get('dlsiteProxyUrl') || '').trim().replace(/\/+$/, '');
    if (!raw) return DEFAULT_DLSITE_PROXY;
    if (!/^https?:\/\//i.test(raw)) {
        raw = `https://${raw}`;
    }
    if (!isValidProxyUrl(raw)) {
        Logger.warn('[DLsiteApi] Invalid proxy URL configured, using the maintained Japan relay:', raw);
        return DEFAULT_DLSITE_PROXY;
    }
    return raw;
}

function proxyDlsiteUrl(originalUrl: string): string {
    const base = getProxyBaseUrl();
    if (!base) return originalUrl;
    try {
        const parsed = new URL(originalUrl);
        const host = parsed.hostname.toLowerCase();
        if (!host.includes('dlsite.com') && !host.includes('dlsite.jp')) {
            return originalUrl;
        }

        const params = new URLSearchParams(parsed.search);
        if (host !== 'www.dlsite.com') {
            params.set('__host', host);
        }
        const query = params.toString();
        return `${base}${parsed.pathname}${query ? `?${query}` : ''}`;
    } catch {
        return originalUrl;
    }
}

function normalizeWorkno(input: string): string {
    return String(input || '').trim().toUpperCase();
}

function toApiQueryParams<T extends object>(params: T): ApiQueryParams {
    const query: ApiQueryParams = {};
    const source = params as Record<string, ApiQueryValue | null | undefined>;
    for (const [key, value] of Object.entries(source)) {
        if (value !== undefined && value !== null) {
            query[key] = value;
        }
    }
    return query;
}

function normalizeProductResponse(data: unknown): DLsiteProductApiResponse {
    if (Array.isArray(data)) {
        if (data.length > 0) return data[0];
        throw new Error('Empty product response');
    }
    if (data && typeof data === 'object' && 'workno' in data) {
        return data as DLsiteProductApiResponse;
    }
    throw new Error('Invalid product response');
}

function normalizeProductListResponse(data: unknown): DLsiteProductApiResponse[] {
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object' && 'workno' in data) {
        return [data as DLsiteProductApiResponse];
    }
    return [];
}

export class DLsiteApiClient {
    private static readonly BASE_URL = 'https://www.dlsite.com';
    private static readonly FALLBACK_DOMAINS = ['home', 'girls', 'pro', 'ana', 'eng'] as const;

    public async getProduct(workno: string): Promise<DLsiteProductApiResponse | null> {
        const normalized = normalizeWorkno(workno);
        if (!normalized) return null;

        try {
            return await this.fetchProductFromDomain('maniax', { workno: normalized });
        } catch (maniaxError) {
            const tasks = DLsiteApiClient.FALLBACK_DOMAINS.map((domain) =>
                this.fetchProductFromDomain(domain, { workno: normalized }),
            );
            try {
                return await Promise.any(tasks);
            } catch (error) {
                Logger.warn(`[DLsiteApi] Product not found: ${normalized}`, { maniaxError, error });
                return null;
            }
        }
    }

    public async search(keywordInput: string): Promise<DLsiteProductApiResponse[]> {
        const keyword = String(keywordInput || '').trim();
        if (!keyword) return [];
        return this.fetchProductListFromDomain('maniax', {
            keyword_work_name: keyword,
            locale: 'ja-jp',
        });
    }

    public async getProducts(params: Partial<DLsiteProductApiParams>): Promise<DLsiteProductApiResponse[]> {
        return this.fetchProductListFromDomain('maniax', params);
    }

    public async getReviews(params: DLsiteReviewApiParams): Promise<DLsiteReviewApiResponse | null> {
        const path = '/maniax/api/=/review.json';
        try {
            const response = await this.fetchJsonViaCors<DLsiteReviewApiResponse>(path, {
                params: toApiQueryParams(params),
                retry: { attempts: 2 },
            });
            return response.data;
        } catch (error) {
            Logger.warn(`[DLsiteApi] Failed to fetch reviews for ${params.workno}`, error);
            return null;
        }
    }

    private buildApiUrl(path: string): string {
        return proxyDlsiteUrl(`${DLsiteApiClient.BASE_URL}${path}`);
    }

    private async fetchJsonViaCors<T>(
        path: string,
        options: {
            params?: ApiQueryParams;
            retry?: { attempts: number };
        },
    ) {
        return HttpClient.getJsonViaCors<T>(this.buildApiUrl(path), options);
    }

    private async fetchProductFromDomain(
        domain: string,
        params: Partial<DLsiteProductApiParams>,
    ): Promise<DLsiteProductApiResponse> {
        const path = `/${domain}/api/=/product.json`;
        const response = await this.fetchJsonViaCors<DLsiteProductApiResponse[] | DLsiteProductApiResponse>(path, {
            params: toApiQueryParams({
                locale: params.locale || 'ja-jp',
                ...params,
            }),
            retry: { attempts: 1 },
        });
        return normalizeProductResponse(response.data);
    }

    private async fetchProductListFromDomain(
        domain: string,
        params: Partial<DLsiteProductApiParams>,
    ): Promise<DLsiteProductApiResponse[]> {
        const path = `/${domain}/api/=/product.json`;
        const response = await this.fetchJsonViaCors<DLsiteProductApiResponse[] | DLsiteProductApiResponse>(path, {
            params: toApiQueryParams(params),
            retry: { attempts: 2 },
        });
        return normalizeProductListResponse(response.data);
    }
}

export const DLsiteApi = new DLsiteApiClient();
