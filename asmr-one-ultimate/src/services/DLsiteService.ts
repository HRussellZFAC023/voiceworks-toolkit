import { Logger, Config } from '../core/Utils';
import { gmRequest, retryWithBackoff } from '../infrastructure/HttpClient';
import type { GmRequestConfig } from '../infrastructure/HttpClient';
import type { DLsiteProductApiResponse, DLsiteDynamicEntry, DLsiteUserReview } from '../types/dlsite';
import { DEFAULT_DLSITE_PROXY, LIMITS } from '../core/Constants';
import { runPacedBatches } from '../core/PacedBatch';

const DLSITE_HEADERS = {
    Accept: 'application/json',
    'Accept-Language': 'ja',
    Referer: 'https://www.dlsite.com/',
    Origin: 'https://www.dlsite.com',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'X-Requested-With': 'XMLHttpRequest',
};

/**
 * Validate that a URL string is a well-formed http: or https: URL.
 */
function isValidProxyUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch {
        return false;
    }
}

/**
 * Get the user-configured DLsite proxy URL (Cloudflare Worker).
 * When set, all DLsite requests are routed through this proxy.
 * Empty or invalid configuration falls back to the maintained Japan relay.
 */
function getProxyBaseUrl(): string {
    let raw = (String(Config.get('dlsiteProxyUrl') || '')).replace(/\/+$/, '');
    if (!raw) return DEFAULT_DLSITE_PROXY;
    // Auto-prepend https:// if no protocol is provided
    if (!/^https?:\/\//i.test(raw)) {
        raw = 'https://' + raw;
    }
    if (!isValidProxyUrl(raw)) {
        Logger.warn('[DLsiteService] Invalid proxy URL configured, using the maintained Japan relay:', raw);
        return DEFAULT_DLSITE_PROXY;
    }
    return raw;
}

/**
 * Rewrite a DLsite URL through the user-configured proxy.
 * Format: `{proxyBaseUrl}{pathname}{search}`
 * e.g. `https://worker.dev/maniax/api/review?product_id=RJ123`
 *
 * For non-www hosts (e.g. `img.dlsite.jp`), append `__host` query so the
 * proxy worker can preserve the upstream hostname.
 *
 * If no proxy is configured, returns the original URL unchanged.
 */
function proxyDlsiteUrl(originalUrl: string): string {
    const base = getProxyBaseUrl();
    if (!base) return originalUrl;
    try {
        const u = new URL(originalUrl);
        const host = u.hostname.toLowerCase();
        if (!host.includes('dlsite.com') && !host.includes('dlsite.jp')) return originalUrl;

        const params = new URLSearchParams(u.search);
        if (host !== 'www.dlsite.com') {
            params.set('__host', host);
        }
        const query = params.toString();
        return `${base}${u.pathname}${query ? `?${query}` : ''}`;
    } catch {
        return originalUrl;
    }
}

/**
 * gmRequest wrapper that routes DLsite URLs through the configured proxy.
 */
async function proxiedGmRequest(config: GmRequestConfig) {
    const proxiedUrl = proxyDlsiteUrl(config.url);
    if (proxiedUrl !== config.url) {
        Logger.debug(`[DLsiteService] Proxying request: ${config.url} -> ${proxiedUrl}`);
        try {
            return await gmRequest({ ...config, url: proxiedUrl });
        } catch (error) {
            Logger.warn('[DLsiteService] Japan relay failed; retrying the original DLsite URL directly', error);
            return gmRequest(config);
        }
    }
    return gmRequest(config);
}

const RETRY_JSON = { attempts: 2, backoffMs: 800, multiplier: 2 };
const RETRY_HTML = { attempts: 2, backoffMs: 1000, multiplier: 2 };

/** Markers that identify a DLsite age-verification gate page */
const AGE_GATE_MARKERS = [
    'あなたは18歳以上ですか',       // "Are you 18 or older?"
    '18歳未満の方は閲覧できない',    // "Cannot be viewed by those under 18"
    'age_verification',
    '成人向け入室確認',              // "Adult entry confirmation"
];

/** 
 * Specific text patterns that should trigger a review to be discarded.
 * Includes age gate text that might leak into comments, content warnings, and stray UI elements (prices).
 */
const INVALID_CONTENT_MARKERS = [
    ...AGE_GATE_MARKERS,
    '一般的な作品に加えて暴力表現・性描写など',
    'In addition to general works, violence and sexual depictions etc.'
];

/** Check whether an HTML response is the DLsite age-verification gate */
function isAgeGatePage(html: string): boolean {
    return AGE_GATE_MARKERS.some(marker => html.includes(marker));
}

/**
 * DLsite network service — handles all HTTP communication with DLsite APIs.
 *
 * Returns raw API response types. Parsing/normalization is done by DLsiteScraper.
 */
export class DLsiteServiceImpl {
    private static readonly DOMAINS = ['maniax', 'home', 'girls', 'pro', 'ana', 'eng'] as const;
    private productPageInflight = new Map<string, Promise<string | null>>();

    /**
     * Fetch product data from DLsite Product API.
     * Tries domains in small hedged pairs, returning the first success. This
     * keeps the common maniax/home path quick without firing six requests (and
     * their retries) at the relay for every work.
     */
    public async fetchProductApi(rjCode: string): Promise<DLsiteProductApiResponse | null> {
        if (!rjCode || !/^(RJ|VJ|BJ)?\d{5,}/i.test(rjCode)) {
            Logger.warn('[DLsiteService] Invalid RJ code:', rjCode);
            return null;
        }
        const normalized = rjCode.toUpperCase();
        Logger.debug(`[DLsiteService] fetchProductApi: ${normalized}`);

        for (let index = 0; index < DLsiteServiceImpl.DOMAINS.length; index += 2) {
            const domains = DLsiteServiceImpl.DOMAINS.slice(index, index + 2);
            try {
                const result = await Promise.any(domains.map(async (domain) => {
                    const url = `https://www.dlsite.com/${domain}/api/=/product.json?workno=${normalized}&locale=ja-jp`;
                    Logger.debug(`[DLsiteService] Fetching ${domain} API:`, url);
                    const payload = await this.fetchJson(url, domain);
                    const entry = this.extractEntry(payload, normalized);
                    if (!entry) throw new Error(`[DLsiteService] ${domain} empty`);
                    return entry;
                }));
                Logger.debug(`[DLsiteService] fetchProductApi succeeded for ${normalized}`, { title: result?.work_name });
                return result;
            } catch (err) {
                Logger.debug(`[DLsiteService] Product API pair failed for ${normalized}`, err);
            }
        }

        Logger.warn(`[DLsiteService] fetchProductApi failed for ${normalized}: all domains rejected`);
        return null;
    }

    /**
     * Fetch dynamic pricing/rating data from DLsite touch API.
     */
    public async fetchDynamicApi(rjCode: string): Promise<DLsiteDynamicEntry | null> {
        if (!rjCode || !/^(RJ|VJ|BJ)?\d{5,}/i.test(rjCode)) {
            Logger.warn('[DLsiteService] Invalid RJ code:', rjCode);
            return null;
        }
        const normalized = rjCode.toUpperCase();
        Logger.debug(`[DLsiteService] fetchDynamicApi: ${normalized}`);
        const url = `https://www.dlsite.com/maniax-touch/product/info/ajax?product_id=${normalized}`;

        try {
            const res = await retryWithBackoff(
                () => proxiedGmRequest({ url, headers: DLSITE_HEADERS, responseType: 'json' }),
                RETRY_JSON,
            );

            const payload = res.response && typeof res.response === 'object'
                ? res.response as Record<string, unknown>
                : JSON.parse(res.responseText || '{}');

            if (typeof payload !== 'object' || payload === null) {
                Logger.warn('[DLsiteService] Dynamic API returned non-object', payload);
                return null;
            }

            const obj = payload as Record<string, DLsiteDynamicEntry | any>;
            const entry = obj[normalized]
                || obj.data?.[normalized]
                || obj.data?.[0]
                || obj.product
                || obj.work
                || obj.items?.[0];

            if (!entry) {
                Logger.warn('[DLsiteService] Dynamic API empty for', normalized);
                return null;
            }
            Logger.debug('[DLsiteService] Dynamic API entry:', entry);
            return entry as DLsiteDynamicEntry;
        } catch (e) {
            Logger.warn('[DLsiteService] Dynamic API error', e);
            return null;
        }
    }

    /**
     * Fetch the DLsite product HTML page and extract the full description body.
     * Concurrent body/gallery consumers share one in-flight HTML request.
     */
    public async fetchProductPageBody(rjCode: string): Promise<string | null> {
        if (!rjCode || !/^(RJ|VJ|BJ)?\d{5,}/i.test(rjCode)) {
            Logger.warn('[DLsiteService] Invalid RJ code:', rjCode);
            return null;
        }
        const html = await this.fetchProductPageHtml(rjCode.toUpperCase());
        return html ? this.extractDescriptionBody(html) : null;
    }

    /**
     * Fetch sample image URLs from product HTML.
     * Prefers stable `modpub/images2/parts/...` gallery images over `_img_smpN` URLs.
     */
    public async fetchProductPageSampleImages(rjCode: string): Promise<string[]> {
        if (!rjCode || !/^(RJ|VJ|BJ)?\d{5,}/i.test(rjCode)) {
            Logger.warn('[DLsiteService] Invalid RJ code:', rjCode);
            return [];
        }

        const html = await this.fetchProductPageHtml(rjCode.toUpperCase());
        return html ? this.extractSampleImageUrls(html) : [];
    }

    private fetchProductPageHtml(rjCode: string): Promise<string | null> {
        const existing = this.productPageInflight.get(rjCode);
        if (existing) return existing;

        const request = this.fetchProductPageHtmlFresh(rjCode).finally(() => {
            if (this.productPageInflight.get(rjCode) === request) {
                this.productPageInflight.delete(rjCode);
            }
        });
        this.productPageInflight.set(rjCode, request);
        return request;
    }

    private async fetchProductPageHtmlFresh(rjCode: string): Promise<string | null> {
        Logger.debug(`[DLsiteService] Fetching shared product page for: ${rjCode}`);
        for (let index = 0; index < DLsiteServiceImpl.DOMAINS.length; index += 2) {
            const domains = DLsiteServiceImpl.DOMAINS.slice(index, index + 2);
            try {
                return await Promise.any(domains.map(async (domain) => {
                    const url = `https://www.dlsite.com/${domain}/work/=/product_id/${rjCode}.html`;
                    const res = await retryWithBackoff(
                        () => proxiedGmRequest({
                            url,
                            headers: {
                                Accept: 'text/html',
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                                'Accept-Language': 'ja',
                                Referer: 'https://www.dlsite.com/',
                                Cookie: 'adultchecked=1',
                            },
                            responseType: 'text',
                        }),
                        RETRY_HTML,
                    );
                    const html = res.responseText || '';
                    if (isAgeGatePage(html)) throw new Error(`[DLsiteService] ${domain} hit age gate`);
                    if (!this.extractDescriptionBody(html) && this.extractSampleImageUrls(html).length === 0) {
                        throw new Error(`[DLsiteService] ${domain} did not return product details`);
                    }
                    return html;
                }));
            } catch (error) {
                Logger.debug(`[DLsiteService] Product page pair failed for ${rjCode}`, error);
            }
        }
        Logger.warn(`[DLsiteService] Product page unavailable for ${rjCode}`);
        return null;
    }

    /**
     * Fetch user reviews from DLsite for a given RJ code.
     * Races JSON API against HTML scraping in parallel for speed.
     * If proxy is configured and fails, retries with direct GM_xmlhttpRequest.
     * Returns empty array on failure — never throws.
     */
    public async fetchProductPageReviews(rjCode: string): Promise<DLsiteUserReview[]> {
        if (!rjCode || !/^(RJ|VJ|BJ)?\d{5,}/i.test(rjCode)) {
            Logger.warn('[DLsiteService] Invalid RJ code:', rjCode);
            return [];
        }
        Logger.debug(`[DLsiteService] fetchProductPageReviews: ${rjCode}`);

        // Race Strategy 1 (JSON API) against Strategy 2 (HTML scraping) in parallel.
        // Promise.any resolves as soon as the first strategy returns reviews.
        const apiTask = this.fetchReviewsViaApi(rjCode).then(reviews => {
            if (reviews.length === 0) throw new Error('API returned no reviews');
            Logger.debug(`[DLsiteService] API returned ${reviews.length} reviews for ${rjCode}`);
            return reviews;
        });

        const htmlTask = this.fetchReviewsViaHtml(rjCode).then(reviews => {
            if (reviews.length === 0) throw new Error('HTML returned no reviews');
            Logger.debug(`[DLsiteService] HTML extracted ${reviews.length} reviews for ${rjCode}`);
            return reviews;
        });

        try {
            return await Promise.any([apiTask, htmlTask]);
        } catch (err) {
            if (err instanceof AggregateError) {
                Logger.debug('[DLsiteService] All strategies failed:', err.errors);
            }
            Logger.warn(`[DLsiteService] API + HTML both failed for ${rjCode}`);
            Logger.debug(`[DLsiteService] Promise.any rejected for ${rjCode}:`, err);
            // If a proxy is configured, retry without it (direct GM_xmlhttpRequest bypasses CORS)
            if (getProxyBaseUrl()) {
                Logger.debug(`[DLsiteService] Retrying direct (no proxy) for ${rjCode}`);
                return this.fetchReviewsDirect(rjCode);
            }
            return [];
        }
    }

    /**
     * Direct fallback: fetch reviews bypassing the proxy entirely.
     * Uses GM_xmlhttpRequest which is not subject to CORS restrictions.
     */
    private async fetchReviewsDirect(rjCode: string): Promise<DLsiteUserReview[]> {
        const domains = ['maniax', 'home'] as const;

        for (const domain of domains) {
            try {
                const url = `https://www.dlsite.com/${domain}/api/review?product_id=${rjCode}&limit=30&mix_pickup=true&page=1&order=regist_d&locale=ja_JP`;
                Logger.debug(`[DLsiteService] Direct fetch attempt: ${url}`);
                const res = await retryWithBackoff(
                    () => gmRequest({
                        url,
                        headers: { ...DLSITE_HEADERS, Accept: 'application/json', Cookie: 'adultchecked=1; locale=ja-jp' },
                        responseType: 'text',
                    }),
                    RETRY_JSON,
                );

                Logger.debug(`[DLsiteService] Direct response status: ${res.status}, length: ${res.responseText?.length ?? 0}`);
                const payload = this.parseJsonResponse(res, `${domain} direct review API`);
                Logger.debug(`[DLsiteService] Direct parsed payload keys: ${Object.keys(payload).join(', ')}`, payload);
                
                // Check for API error response
                const payloadObj = payload as Record<string, unknown>;
                if (payloadObj.is_success === false || payloadObj.error) {
                    Logger.debug(`[DLsiteService] API returned error for ${domain}:`, payloadObj.error || payloadObj.message || 'is_success=false');
                    continue;
                }
                
                const items = this.extractReviewItems(payload);
                Logger.debug(`[DLsiteService] Extracted ${items.length} review items from ${domain}`);
                if (items.length === 0) continue;

                const reviews = this.parseReviewItems(items, rjCode);
                if (reviews.length > 0) {
                    Logger.debug(`[DLsiteService] Direct fetch returned ${reviews.length} reviews for ${rjCode}`);
                    return reviews;
                }
            } catch (e) {
                Logger.debug(`[DLsiteService] Direct review fetch failed for ${domain}/${rjCode}`, e);
            }
        }

        // Last resort: try direct HTML scraping (bypassing proxy)
        Logger.debug(`[DLsiteService] Trying direct HTML scraping for ${rjCode}`);
        const htmlReviews = await this.fetchReviewsViaHtmlDirect(rjCode);
        if (htmlReviews.length > 0) {
            Logger.debug(`[DLsiteService] Direct HTML scraping returned ${htmlReviews.length} reviews for ${rjCode}`);
            return htmlReviews;
        }

        Logger.warn(`[DLsiteService] All review strategies failed for ${rjCode}`);
        return [];
    }

    /**
     * Direct HTML scraping fallback: bypasses proxy entirely.
     * Uses GM_xmlhttpRequest which is not subject to CORS restrictions.
     */
    private async fetchReviewsViaHtmlDirect(rjCode: string): Promise<DLsiteUserReview[]> {
        const domains = ['maniax', 'home'] as const;

        for (const domain of domains) {
            try {
                const url = `https://www.dlsite.com/${domain}/work/=/product_id/${rjCode}.html`;
                Logger.debug(`[DLsiteService] Direct HTML attempt: ${url}`);
                const res = await retryWithBackoff(
                    () => gmRequest({
                        url,
                        headers: {
                            Accept: 'text/html',
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                            'Accept-Language': 'ja',
                            Referer: 'https://www.dlsite.com/',
                            Cookie: 'adultchecked=1',
                        },
                        responseType: 'text',
                    }),
                    RETRY_HTML,
                );

                Logger.debug(`[DLsiteService] Direct HTML response status: ${res.status}, length: ${res.responseText?.length ?? 0}`);
                
                if (isAgeGatePage(res.responseText)) {
                    Logger.debug(`[DLsiteService] Direct HTML hit age gate for ${domain}`);
                    continue;
                }

                const reviews = this.extractReviewsFromHtml(res.responseText);
                Logger.debug(`[DLsiteService] Direct HTML extracted ${reviews.length} reviews from ${domain}`);
                if (reviews.length > 0) return reviews;
            } catch (e) {
                Logger.debug(`[DLsiteService] Direct HTML fetch failed for ${domain}/${rjCode}`, e);
            }
        }
        return [];
    }

    /**
     * HTML scraping strategy: try maniax then home domain sequentially.
     */
    private async fetchReviewsViaHtml(rjCode: string): Promise<DLsiteUserReview[]> {
        const domains = ['maniax', 'home'] as const;

        for (const domain of domains) {
            try {
                const url = `https://www.dlsite.com/${domain}/work/=/product_id/${rjCode}.html`;
                Logger.debug(`[DLsiteService] HTML scrape attempt: ${url}`);
                const res = await retryWithBackoff(
                    () => proxiedGmRequest({
                        url,
                        headers: {
                            Accept: 'text/html',
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                            'Accept-Language': 'ja',
                            Referer: 'https://www.dlsite.com/',
                            Cookie: 'adultchecked=1',
                        },
                        responseType: 'text',
                    }),
                    RETRY_HTML,
                );

                Logger.debug(`[DLsiteService] HTML response status: ${res.status}, length: ${res.responseText?.length ?? 0}`);
                
                if (isAgeGatePage(res.responseText)) {
                    Logger.debug(`[DLsiteService] Hit age gate for ${domain}`);
                    continue;
                }

                const reviews = this.extractReviewsFromHtml(res.responseText);
                Logger.debug(`[DLsiteService] HTML extracted ${reviews.length} reviews from ${domain}`);
                if (reviews.length > 0) return reviews;
            } catch (e) {
                Logger.debug(`[DLsiteService] HTML review fetch failed for ${domain}`, e);
            }
        }
        return [];
    }

    /**
     * Fetch reviews from DLsite's JSON review API with pagination.
     * Fetches page 1 first (to get total_count), then remaining pages in parallel.
     * Tries multiple domain paths since reviews may be under maniax, home, etc.
     */
    private async fetchReviewsViaApi(rjCode: string): Promise<DLsiteUserReview[]> {
        const PAGE_SIZE = 30;
        const MAX_PAGES = LIMITS.MAX_REVIEW_PAGES;
        const domains = ['maniax', 'home'] as const;

        for (const domain of domains) {
            try {
                const page1Url = `https://www.dlsite.com/${domain}/api/review?product_id=${rjCode}&limit=${PAGE_SIZE}&mix_pickup=true&page=1&order=regist_d&locale=ja_JP`;
                Logger.debug(`[DLsiteService] API fetch attempt: ${page1Url}`);
                const page1Res = await retryWithBackoff(
                    () => proxiedGmRequest({
                        url: page1Url,
                        headers: { ...DLSITE_HEADERS, Accept: 'application/json', Cookie: 'adultchecked=1; locale=ja-jp' },
                        responseType: 'text',
                    }),
                    RETRY_JSON,
                );

                Logger.debug(`[DLsiteService] API response status: ${page1Res.status}, length: ${page1Res.responseText?.length ?? 0}`);
                const page1Payload = this.parseJsonResponse(page1Res, `${domain} review API page 1`);
                const page1Obj = page1Payload as Record<string, unknown>;
                Logger.debug(`[DLsiteService] API payload keys: ${Object.keys(page1Obj).join(', ')}`, {
                    is_success: page1Obj.is_success,
                    review_count: (page1Obj.review_param as Record<string, unknown>)?.total_count
                });
                if (page1Obj.is_success === false) {
                    Logger.debug(`[DLsiteService] API returned is_success=false for ${domain}`);
                    continue;
                }

                const page1Items = this.extractReviewItems(page1Payload);
                Logger.debug(`[DLsiteService] Extracted ${page1Items.length} items from ${domain} API`);
                if (page1Items.length === 0) continue;

                let totalCount = Infinity;
                const reviewParam = page1Obj.review_param as Record<string, unknown> | undefined;
                if (reviewParam?.total_count != null) {
                    totalCount = Number(reviewParam.total_count);
                }

                let allReviews = this.parseReviewItems(page1Items, rjCode);

                // Fetch remaining pages in parallel (same domain that worked for page 1)
                if (page1Items.length >= PAGE_SIZE && allReviews.length < totalCount) {
                    const totalPages = Math.min(MAX_PAGES, Math.ceil(totalCount / PAGE_SIZE));
                    const remainingPages = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);

                    const pageResults = await runPacedBatches(
                        remainingPages,
                        async (page) => {
                            const url = `https://www.dlsite.com/${domain}/api/review?product_id=${rjCode}&limit=${PAGE_SIZE}&mix_pickup=false&page=${page}&order=regist_d&locale=ja_JP`;
                            const res = await retryWithBackoff(
                                () => proxiedGmRequest({
                                    url,
                                    headers: { ...DLSITE_HEADERS, Accept: 'application/json', Cookie: 'adultchecked=1; locale=ja-jp' },
                                    responseType: 'text',
                                }),
                                RETRY_JSON,
                            );
                            const payload = this.parseJsonResponse(res, `${domain} review API page ${page}`);
                            const items = this.extractReviewItems(payload);
                            return items;
                        },
                        { batchSize: 2, delayMs: 400 },
                    );

                    for (const result of pageResults) {
                        if (result.status === 'fulfilled' && result.value.length > 0) {
                            allReviews.push(...this.parseReviewItems(result.value, rjCode));
                        }
                    }
                }

                if (allReviews.length > 0) return allReviews;
            } catch (e) {
                Logger.debug(`[DLsiteService] Review API ${domain} failed for ${rjCode}`, e);
            }
        }
        return [];
    }

    private parseReviewItems(items: unknown[], rjCode: string): DLsiteUserReview[] {
        const reviews: DLsiteUserReview[] = [];
        for (const item of items as Record<string, unknown>[]) {
            const text = String(item.review_text || item.longtext || item.comment || item.body || '').trim();
            if (!text) continue;
            const rateNum = Number(item.rate_num || item.star || item.rating || item.score || 0);

            const review: DLsiteUserReview = {
                username: String(item.nick_name || item.reviewer_name || item.user_name || item.reviewer || 'Anonymous'),
                rating: rateNum,
                text,
                date: String(item.regist_date || item.entry_date || item.date || '').substring(0, 10),
                source: 'dlsite',
                source_rjcode: rjCode,
            };

            if (this.isValidReview(review)) {
                reviews.push(review);
            }
        }
        return reviews;
    }

    private extractReviewsFromHtml(html: string): DLsiteUserReview[] {
        const reviews: DLsiteUserReview[] = [];

        // DLsite review blocks: look for review list sections
        // Pattern 1: <div class="review_list"> containing individual reviews
        // Pattern 2: <div class="user_review"> blocks
        // Pattern 3: Inline review section with star ratings

        // Check if we have any review-related content at all
        const hasReviewSection = html.includes('review_list') || html.includes('user_review') || html.includes('review_item');
        Logger.debug(`[DLsiteService] HTML has review section markers: ${hasReviewSection}`);

        // Try multiple extraction patterns
        const reviewBlockPatterns = [
            // Pattern: review items with rating + text
            /<li[^>]*class="[^"]*review_item[^"]*"[^>]*>([\s\S]*?)<\/li>/gi,
            // Pattern: user review divs
            /<div[^>]*class="[^"]*user_review[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]*class="[^"]*user_review|<\/[a-z])/gi,
            // Pattern: review_content blocks
            /<div[^>]*class="[^"]*review_content[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
        ];

        for (let i = 0; i < reviewBlockPatterns.length; i++) {
            const pattern = reviewBlockPatterns[i];
            let match;
            let matchCount = 0;
            while ((match = pattern.exec(html)) !== null) {
                matchCount++;
                const block = match[1] || match[0];
                const review = this.parseReviewBlock(block);
                if (review && this.isValidReview(review)) {
                    reviews.push(review);
                }
            }
            Logger.debug(`[DLsiteService] Pattern ${i+1} found ${matchCount} blocks, ${reviews.length} valid reviews so far`);
            if (reviews.length > 0) break;
        }

        // Fallback: try to extract from structured review data in script tags
        if (reviews.length === 0) {
            Logger.debug(`[DLsiteService] Trying script tag extraction`);
            
            // Pattern 1: review_list in JSON
            const scriptMatch = html.match(/"review_list"\s*:\s*(\[[\s\S]*?\])/);
            if (scriptMatch) {
                Logger.debug(`[DLsiteService] Found review_list in script tag`);
                try {
                    const data = JSON.parse(scriptMatch[1]);
                    if (Array.isArray(data)) {
                        Logger.debug(`[DLsiteService] Parsed ${data.length} items from script tag`);
                        data.forEach((item: Record<string, unknown>) => {
                            if (item.review_text || item.comment || item.body) {
                                const review: DLsiteUserReview = {
                                    username: (item.user_name || item.reviewer || item.nick_name || 'Anonymous') as string,
                                    rating: Number(item.star || item.rating || item.score || 0),
                                    text: (item.review_text || item.comment || item.body || '') as string,
                                    date: (item.date || item.regist_date || item.created_at || '') as string,
                                    source: 'dlsite',
                                };
                                if (this.isValidReview(review)) {
                                    reviews.push(review);
                                }
                            }
                        });
                    }
                } catch (e) {
                    Logger.debug(`[DLsiteService] Script tag JSON parse failed:`, e);
                }
            }
            
            // Pattern 2: Look for window.__NUXT__ or similar data
            if (reviews.length === 0) {
                const nuxtMatch = html.match(/window\.__NUXT__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/);
                if (nuxtMatch) {
                    Logger.debug(`[DLsiteService] Found __NUXT__ data, checking for reviews`);
                }
            }
        }

        Logger.debug(`[DLsiteService] extractReviewsFromHtml returning ${reviews.length} reviews`);
        return reviews;
    }

    private parseReviewBlock(block: string): DLsiteUserReview | null {
        // Extract rating (star count or numeric rating)
        let rating = 0;
        const starMatch = block.match(/star[_-](\d)/i)
            || block.match(/rating[_":\s]+(\d)/i)
            || block.match(/(\d)[\s]*(?:\/5|stars?)/i);
        if (starMatch) rating = parseInt(starMatch[1], 10);

        // Count filled star icons as fallback
        if (!rating) {
            const filledStars = (block.match(/star_on|star_fill|icon-star(?!_off|_empty)/gi) || []).length;
            if (filledStars > 0 && filledStars <= 5) rating = filledStars;
        }

        // Extract username
        let username = 'Anonymous';
        const userMatch = block.match(/class="[^"]*(?:reviewer|user_name|review_author|nick_name)[^"]*"[^>]*>([^<]+)/i)
            || block.match(/<span[^>]*class="[^"]*name[^"]*"[^>]*>([^<]+)/i);
        if (userMatch) username = this.cleanHtmlToText(userMatch[1]).trim();

        // Extract text
        let text = '';
        const textMatch = block.match(/class="[^"]*(?:review_text|review_body|comment_body|review_main)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|p|span)>/i)
            || block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
        if (textMatch) text = this.cleanHtmlToText(textMatch[1]).trim();

        // Extract date
        let date = '';
        const dateMatch = block.match(/(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})/)
            || block.match(/class="[^"]*date[^"]*"[^>]*>([^<]+)/i);
        if (dateMatch) date = dateMatch[1].trim();

        // Only return if we have meaningful text
        if (!text || text.length < 3) return null;

        return { username, rating, text, date, source: 'dlsite' };
    }

    private parseJsonResponse(res: { response?: unknown; responseText?: string; status?: number }, label: string): Record<string, unknown> {
        if (res.response && typeof res.response === 'object') return res.response as Record<string, unknown>;
        const raw = (typeof res.response === 'string' && res.response) || res.responseText || '';
        const text = raw.trim();
        
        // Check for various failure scenarios
        if (!text) {
            Logger.warn(`[DLsiteService] ${label} empty response (status: ${res.status})`);
            throw new Error('Empty response');
        }
        
        if (text.startsWith('<')) {
            // Check what kind of HTML we got
            const isAgeGate = isAgeGatePage(text);
            const is404 = text.includes('お探しのページは見つかりませんでした') || text.includes('Page not found');
            const isError = text.includes('エラー') || text.includes('Error');
            Logger.warn(`[DLsiteService] ${label} returned HTML instead of JSON (status: ${res.status}, ageGate: ${isAgeGate}, 404: ${is404}, error: ${isError})`);
            Logger.debug(`[DLsiteService] ${label} HTML snippet:`, text.slice(0, 300));
            throw new Error('HTML response instead of JSON');
        }
        
        try {
            return JSON.parse(text) as Record<string, unknown>;
        } catch (e) {
            Logger.warn(`[DLsiteService] ${label} JSON parse failed`, String(text).slice(0, 120));
            throw e;
        }
    }

    private extractReviewItems(payload: Record<string, unknown>): unknown[] {
        const obj = payload as Record<string, unknown>;
        Logger.debug(`[DLsiteService] extractReviewItems payload keys:`, Object.keys(obj));
        
        // Check for reviews in various possible locations
        const directList = Array.isArray(obj.review_list) ? obj.review_list : null;
        if (directList && directList.length) {
            Logger.debug(`[DLsiteService] Found ${directList.length} items in review_list`);
            return directList;
        }
        
        // Check data.review_list
        const dataReviewList = (obj.data as Record<string, unknown>)?.review_list;
        const dataList = Array.isArray(dataReviewList) ? dataReviewList : null;
        if (dataList && dataList.length) {
            Logger.debug(`[DLsiteService] Found ${dataList.length} items in data.review_list`);
            return dataList;
        }
        
        // Check reviews key (alternative API format)
        const reviews = Array.isArray(obj.reviews) ? obj.reviews : null;
        if (reviews && reviews.length) {
            Logger.debug(`[DLsiteService] Found ${reviews.length} items in reviews`);
            return reviews;
        }
        
        // Check data array
        const altData = Array.isArray(obj.data) ? obj.data : null;
        if (altData && altData.length) {
            Logger.debug(`[DLsiteService] Found ${altData.length} items in data array`);
            return altData;
        }
        
        // Check list key
        const list = Array.isArray(obj.list) ? obj.list : null;
        if (list && list.length) {
            Logger.debug(`[DLsiteService] Found ${list.length} items in list`);
            return list;
        }
        
        // Check if payload itself is an array
        if (Array.isArray(payload)) {
            Logger.debug(`[DLsiteService] Payload is array with ${(payload as unknown[]).length} items`);
            return payload as unknown[];
        }
        
        Logger.debug(`[DLsiteService] No review items found in payload`);
        return [];
    }

    /**
     * Determines if a scraped review should be included.
     * Filters out reviews containing blocklisted text (age gate, prices, etc).
     */
    private isValidReview(review: DLsiteUserReview): boolean {
        if (!review.text || review.text.length < 3) return false;

        if (INVALID_CONTENT_MARKERS.some(m => review.text.includes(m) || review.username?.includes(m))) {
            return false;
        }

        // Filter loose prices "660 円" or "660 JPY" (common scraper artifacts)
        if (/^\d+\s*[_]*円[_]*$/.test(review.text)) return false;
        if (/^\d{1,3}(,\d{3})*\s*JPY$/.test(review.text)) return false;

        return true;
    }

    // ========================================================================
    // Private helpers
    // ========================================================================

    private extractDescriptionBody(html: string): string | null {
        const containerStart = html.indexOf('work_parts_container');
        if (containerStart === -1) return null;

        const boundaries = [
            'work_buy_container',
            'work_matome',
            '_work_matome',
            'work_right',
            'productPreview',
            '<script',
            'id="matome',
        ];

        let containerEnd = containerStart + 15000;
        for (const marker of boundaries) {
            const idx = html.indexOf(marker, containerStart + 30);
            if (idx !== -1 && idx < containerEnd) containerEnd = idx;
        }

        let section = html.substring(containerStart, containerEnd)
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '');

        const textParts: string[] = [];
        const textBlockRegex = /class="work_parts_multitype_item type_text">\s*<p>([\s\S]*?)<\/p>/g;
        let match;
        while ((match = textBlockRegex.exec(section)) !== null) {
            const text = this.cleanHtmlToText(match[1]);
            if (text) textParts.push(text);
        }

        if (textParts.length === 0) {
            const fallbackRegex = /<p[^>]*>([\s\S]*?)<\/p>/g;
            while ((match = fallbackRegex.exec(section)) !== null) {
                const text = this.cleanHtmlToText(match[1]);
                if (text && text.length > 20 && !this.looksLikeCode(text)) {
                    textParts.push(text);
                }
            }
        }

        return textParts.length > 0 ? textParts.join('\n\n') : null;
    }

    private cleanHtmlToText(html: string): string {
        return html
            .replace(/<br\s*\/?>/gi, '\n')
            // Preserve <a> links as markdown before stripping other tags
            .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&quot;/gi, '"')
            .replace(/\t/g, '')
            .replace(/ {2,}/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    private looksLikeCode(text: string): boolean {
        return /\$[tf]\(|function\s*\(|\bvar\s+\w|\.get\(|\.html\(|\{\{.*\}\}|endpoint|swiper|breakpoints|slidesPerView/i.test(text);
    }

    private extractSampleImageUrls(html: string): string[] {
        const allMatches = Array.from(html.matchAll(/(?:https?:)?\/\/img\.dlsite\.jp\/modpub\/images2\/[^"'`\s>]+?\.(?:jpg|jpeg|png)(?:\?[^"'`\s>]*)?/gi))
            .map((m) => this.normalizeDlsiteImageUrl(m[0]));
        if (!allMatches.length) return [];

        const deduped = allMatches.filter((url, idx, arr) => arr.indexOf(url) === idx);
        const partUrls = deduped.filter(url => url.includes('/modpub/images2/parts/'));
        if (partUrls.length) return partUrls;

        // Fallback to classic sample naming if no parts URLs are present.
        return deduped.filter(url => /_img_smp\d+\.(jpg|jpeg|png)(\?|$)/i.test(url));
    }

    private normalizeDlsiteImageUrl(rawUrl: string): string {
        if (!rawUrl) return '';
        if (rawUrl.startsWith('//')) return `https:${rawUrl}`;
        return rawUrl;
    }

    private async fetchJson<T = Record<string, unknown>>(url: string, label: string): Promise<T> {
        const res = await retryWithBackoff(
            () => proxiedGmRequest({ url, headers: DLSITE_HEADERS, responseType: 'json' }),
            RETRY_JSON,
        );

        if (res.response && typeof res.response === 'object') return res.response as T;

        const text = (res.responseText || '').trim();
        if (!text || text.startsWith('<')) {
            Logger.warn(`[DLsiteService] ${label} empty or non - JSON response`);
            throw new Error('Empty response');
        }
        return JSON.parse(text);
    }

    private extractEntry(payload: unknown, rjCode: string): DLsiteProductApiResponse | null {
        if (payload === null || payload === undefined) return null;
        const obj = payload as Record<string, unknown>;
        const entry = Array.isArray(payload)
            ? payload[0]
            : (obj.data as unknown[] | undefined)?.[0]
            || obj.data
            || obj.product
            || obj.work
            || (obj.works as unknown[] | undefined)?.[0]
            || (obj.items as unknown[] | undefined)?.[0]
            || (obj.list as unknown[] | undefined)?.[0]
            || obj[rjCode.toUpperCase()]
            || null;

        if (!entry) {
            if (Array.isArray(payload) && payload.length === 0) return null;
            Logger.warn('[DLsiteService] Parsed but no entry found', JSON.stringify(payload).slice(0, 100));
            return null;
        }

        return entry as DLsiteProductApiResponse;
    }
}

export const DLsiteService = new DLsiteServiceImpl();
