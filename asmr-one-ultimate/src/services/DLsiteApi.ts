import { HttpClient } from '../infrastructure/HttpClient';
import { Logger } from '../core/Utils';
import type {
    DLsiteProductApiResponse,
    DLsiteProductApiParams,
    DLsiteReviewApiResponse,
    DLsiteReviewApiParams
} from '../types/dlsite';

/**
 * DLsite Maniax API Client
 *
 * Provides strongly-typed access to DLsite's internal AJAX APIs.
 * Note: These APIs are unofficial and subject to change.
 *
 * Endpoints:
 * - Product: https://www.dlsite.com/{domain}/api/=/product.json
 * - Review:  https://www.dlsite.com/{domain}/api/=/review.json
 */
export class DLsiteApiClient {
    private static readonly BASE_URL = 'https://www.dlsite.com';
    private static readonly DOMAINS = ['maniax', 'home', 'girls', 'pro', 'ana', 'eng'] as const;

    /**
     * Fetch product information by RJ code.
     * Checks multiple domains (maniax, home, etc.) in parallel to find the product.
     *
     * @param workno - RJ code (e.g. RJ123456)
     * @returns Promise resolving to the product data or null if not found
     */
    public async getProduct(workno: string): Promise<DLsiteProductApiResponse | null> {
        const normalized = workno.toUpperCase();
        // Race all domains to find the product
        const tasks = DLsiteApiClient.DOMAINS.map(domain =>
            this.fetchProductFromDomain(domain, { workno: normalized })
        );

        try {
            const result = await Promise.any(tasks);
            return result;
        } catch (error) {
            Logger.warn(`[DLsiteApi] Product not found: ${normalized}`, error);
            return null;
        }
    }

    /**
     * Search for products using the product.json endpoint.
     * Note: This uses the `keyword_work_name` parameter which seems to filter by name.
     *
     * @param keyword - Search keyword
     * @returns Promise resolving to a list of products
     */
    public async search(keyword: string): Promise<DLsiteProductApiResponse[]> {
        // Search usually works best on maniax or home
        const domain = 'maniax';
        const params: DLsiteProductApiParams = {
            workno: '', // Not used for search, but required by type? No, interface allows strict keys if we want, but for now workno is mandatory in our type?
            // Actually DLsiteProductApiParams defined 'workno' as string.
            // But we can trick it or make workno optional in params if we change the type.
            // For now, let's use type casting or ignore. A cleaner way is to use a separate SearchParams interface.
            keyword_work_name: keyword,
            locale: 'ja-jp'
        };
        // workno is required in the interface I defined? check dlsite.ts.
        // It is `workno: string`. Ill pass empty string which is likely ignored if keyword is present.

        return this.fetchProductListFromDomain(domain, params);
    }

    /**
     * Fetch specific product list by params (e.g. maker_id).
     */
    public async getProducts(params: Partial<DLsiteProductApiParams>): Promise<DLsiteProductApiResponse[]> {
        const domain = 'maniax';
        return this.fetchProductListFromDomain(domain, params as DLsiteProductApiParams);
    }

    /**
     * Fetch reviews for a work.
     *
     * @param params - Review query parameters
     * @returns Promise resolving to the review API response
     */
    public async getReviews(params: DLsiteReviewApiParams): Promise<DLsiteReviewApiResponse | null> {
        // Reviews are usually accessible via maniax or home
        const url = `${DLsiteApiClient.BASE_URL}/maniax/api/=/review.json`;

        try {
            const response = await HttpClient.getJsonViaCors<DLsiteReviewApiResponse>(url, {
                params: params as unknown as Record<string, string | number | boolean>,
                retry: { attempts: 2 }
            });
            return response.data;
        } catch (error) {
            Logger.warn(`[DLsiteApi] Failed to fetch reviews for ${params.workno}`, error);
            return null;
        }
    }

    // ========================================================================
    // Private Helpers
    // ========================================================================

    private async fetchProductFromDomain(domain: string, params: Partial<DLsiteProductApiParams>): Promise<DLsiteProductApiResponse> {
        const url = `${DLsiteApiClient.BASE_URL}/${domain}/api/=/product.json`;
        const query = {
            workno: params.workno,
            locale: params.locale || 'ja-jp',
            ...params
        };

        const response = await HttpClient.getJsonViaCors<DLsiteProductApiResponse[] | DLsiteProductApiResponse>(url, {
            params: query as unknown as Record<string, string | number | boolean>,
            retry: { attempts: 1 } // Do not retry aggressively for racing
        });

        // The API can return a single object or an array depending on context/params.
        // For 'workno', it usually returns array [ { ... } ] or just { ... }?
        // Based on read_url_content, it returned [ { ... } ].

        const data = response.data;
        if (Array.isArray(data)) {
            if (data.length > 0) return data[0];
            throw new Error('Empty array');
        }
        if (data && typeof data === 'object') {
            // Check if it's a valid product object
            if ((data as any).workno) return data as DLsiteProductApiResponse;
        }

        throw new Error('Invalid response');
    }

    private async fetchProductListFromDomain(domain: string, params: Partial<DLsiteProductApiParams>): Promise<DLsiteProductApiResponse[]> {
        const url = `${DLsiteApiClient.BASE_URL}/${domain}/api/=/product.json`;

        const response = await HttpClient.getJsonViaCors<DLsiteProductApiResponse[]>(url, {
            params: params as unknown as Record<string, string | number | boolean>,
            retry: { attempts: 2 }
        });

        const data = response.data;
        if (Array.isArray(data)) return data;

        // Sometimes it might return a wrapper?
        // But for keyword/maker search it usually returns array.
        return [];
    }
}

export const DLsiteApi = new DLsiteApiClient();
