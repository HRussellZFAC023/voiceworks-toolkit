import { Logger } from '../core/Utils';
import { CacheKeys, SharedCache } from '../core/Cache';
import { DLsiteService } from '../services/DLsiteService';
import type { DLsiteProductApiResponse, DLsiteDynamicEntry, DLsiteUserReview } from '../types/dlsite';

// Re-export DLsiteMetadata so existing imports from './DLsiteScraper' still work
export type { DLsiteMetadata } from '../types/dlsite';
import type { DLsiteMetadata } from '../types/dlsite';

export class DLsiteScraper {
    private static instance: DLsiteScraper;
    private cacheTtlMs = 1000 * 60 * 60 * 24 * 7;  // 7 days — use refresh button to force re-fetch

    public static getInstance(): DLsiteScraper {
        if (!this.instance) this.instance = new DLsiteScraper();
        return this.instance;
    }

    public async scrape(rjCode: string): Promise<DLsiteMetadata> {
        const normalized = rjCode.toUpperCase();
        const key = CacheKeys.dlsite(normalized);
        return SharedCache.getOrFetch(key, this.cacheTtlMs, async () => {
            return this.scrapeFresh(normalized);
        });
    }

    /**
     * Progressive scrape: emits partial metadata via onProgress as each phase completes.
     * Phase 1: Product API + Dynamic API → stats, chips, description, images (no body).
     * Phase 2: Page body fetch → full body text for expandable details.
     * Returns the final complete metadata (also cached).
     */
    public async scrapeProgressive(
        rjCode: string,
        onProgress: (meta: DLsiteMetadata) => void
    ): Promise<DLsiteMetadata> {
        const normalized = rjCode.toUpperCase();
        const key = CacheKeys.dlsite(normalized);

        // Cache hit — return immediately, no progressive phases needed
        const cached = SharedCache.get<DLsiteMetadata>(key);
        if (cached) return cached;

        // Deduplicate concurrent requests for the same key
        let base: DLsiteMetadata | null = null;
        let dynamic: DLsiteDynamicEntry | null = null;

        // Phase 1: Product API + Dynamic API (parallel)
        try {
            const [rawProduct, rawDynamic] = await Promise.all([
                DLsiteService.fetchProductApi(normalized),
                DLsiteService.fetchDynamicApi(normalized)
            ]);
            if (rawProduct) base = this.parseApi(rawProduct, normalized);
            if (rawDynamic) dynamic = rawDynamic;

            // Emit Phase 1 result: everything except body
            if (base) {
                onProgress(this.mergeDynamic({ ...base }, dynamic));
            }
        } catch (e) {
            Logger.warn('[DLsiteScraper] Product/Dynamic API failed', e);
        }

        // Phase 2: Fetch the full product page body (HTML scraping)
        if (base) {
            try {
                const body = await DLsiteService.fetchProductPageBody(normalized);
                if (body) base.body = body;
            } catch (e) {
                Logger.warn('[DLsiteScraper] Page body fetch failed', e);
            }
        }

        if (!base) {
            base = this.buildMinimalMeta(normalized, dynamic);
            Logger.warn('[DLsiteScraper] Falling back to minimal metadata for', normalized);
        }

        const final = this.mergeDynamic(base, dynamic);
        SharedCache.set(key, final, this.cacheTtlMs);
        return final;
    }

    private async scrapeFresh(normalized: string): Promise<DLsiteMetadata> {
        let base: DLsiteMetadata | null = null;
        let dynamic: DLsiteDynamicEntry | null = null;

        try {
            const [rawProduct, rawDynamic] = await Promise.all([
                DLsiteService.fetchProductApi(normalized),
                DLsiteService.fetchDynamicApi(normalized)
            ]);
            if (rawProduct) base = this.parseApi(rawProduct, normalized);
            if (rawDynamic) dynamic = rawDynamic;
        } catch (e) {
            Logger.warn('[DLsiteScraper] Product/Dynamic API failed', e);
        }

        // Try to fetch the full product page body (HTML scraping)
        if (base) {
            try {
                const body = await DLsiteService.fetchProductPageBody(normalized);
                if (body) base.body = body;
            } catch (e) {
                Logger.warn('[DLsiteScraper] Page body fetch failed', e);
            }
        }

        if (!base) {
            base = this.buildMinimalMeta(normalized, dynamic);
            Logger.warn('[DLsiteScraper] Falling back to minimal metadata for', normalized);
        }

        return this.mergeDynamic(base, dynamic);
    }

    private mergeDynamic(base: DLsiteMetadata, dynamic: DLsiteDynamicEntry | null): DLsiteMetadata {
        if (!dynamic) return base;
        if (!base.rating_average && (dynamic.rate_average_2dp || dynamic.rate_average)) {
            base.rating_average = Number(dynamic.rate_average_2dp || dynamic.rate_average || 0);
        }
        if (!base.price && typeof dynamic.price === 'number') {
            base.price = dynamic.price;
        }
        if (!base.dl_count && dynamic.dl_count) {
            base.dl_count = String(dynamic.dl_count);
        }
        return base;
    }

    private buildMinimalMeta(rjCode: string, dynamic: DLsiteDynamicEntry | null): DLsiteMetadata {
        return {
            rjcode: rjCode,
            title: rjCode,
            nsfw: true,
            release: '',
            tags: [],
            cvs: [],
            rating_average: Number(dynamic?.rate_average_2dp || dynamic?.rate_average || 0),
            price: Number(dynamic?.price || 0),
            age_category_string: 'R18',
            dl_count: dynamic?.dl_count ? String(dynamic.dl_count) : undefined
        };
    }

    private parseApi(info: DLsiteProductApiResponse, rjCode: string): DLsiteMetadata {
        const ageCategory = Number(info.age_category || 0) || 0;
        const releaseRaw = String(info.regist_date || '');
        const release = releaseRaw ? releaseRaw.replace(/\//g, '-').substring(0, 10) : '';
        const meta: DLsiteMetadata = {
            rjcode: rjCode,
            title: info.work_name || '',
            nsfw: ageCategory > 1,
            release,
            tags: [],
            cvs: [],
            rating_average: 0,
            price: Number(info.price || 0) || 0,
            age_category_string: this.getAgeString(ageCategory)
        };

        if (info.maker_name) {
            const makerId = Number(info.maker_id || info.circle_id || 0) || 0;
            meta.circle = {
                id: makerId,
                name: info.maker_name
            };
        }

        if (info.series_name) {
            meta.series = {
                id: 0,
                name: info.series_name
            };
        }

        const genres = info.genres_replaced || info.genres || [];
        genres.forEach((g) => {
            if (!g || !g.name) return;
            const nameParts = g.name.split('/');
            const name = nameParts[nameParts.length - 1].trim();
            const id = Number(g.id || g.search_val || 0) || 0;
            meta.tags.push({ id, name });
        });

        if (info.creaters && !Array.isArray(info.creaters) && info.creaters.voice_by) {
            info.creaters.voice_by.forEach((cv) => {
                if (cv?.name) meta.cvs.push({ name: cv.name });
            });
        }
        if (Array.isArray(info.creaters)) {
            info.creaters.forEach((cv) => {
                const role = String(cv.type || cv.role || cv.job || '').toLowerCase();
                if (role.includes('voice') || role.includes('cv') || role.includes('\u58f0\u512a')) {
                    const name = cv.name || cv.value;
                    if (name) meta.cvs.push({ name });
                }
            });
        }
        if (Array.isArray(info.voice_by)) {
            info.voice_by.forEach((cv) => {
                const name = cv?.name || cv?.value;
                if (name) meta.cvs.push({ name });
            });
        }
        if (Array.isArray(info.voice)) {
            info.voice.forEach((cv) => {
                const name = cv?.name || cv?.value;
                if (name) meta.cvs.push({ name });
            });
        }
        meta.cvs = meta.cvs.filter((v, i, a) => a.findIndex(t => t.name === v.name) === i);

        // Prefer precise weighted average from rate_count_detail,
        // then rate_average_2dp, then rate_average_star (imprecise, rounded)
        const calculatedRating = this.calculateRating(info.rate_count_detail);
        if (calculatedRating > 0) {
            meta.rating_average = calculatedRating;
        } else if (info.rate_average_2dp) {
            meta.rating_average = Number(info.rate_average_2dp);
        } else if (info.rate_average_star != null) {
            // rate_average_star is on a 0–50 scale (50 = 5 stars)
            const raw = Number(info.rate_average_star);
            meta.rating_average = raw > 5 ? raw / 10 : raw;
        }

        // Brief description (intro_s)
        if (info.intro_s) {
            meta.description = info.intro_s;
            meta.summary = info.intro_s;
        }

        // Full intro text (from API — usually null, but handle when present)
        if (typeof info.intro === 'string' && info.intro) {
            meta.intro = info.intro;
            // If we got intro from API, also use it as body
            if (!meta.body) meta.body = info.intro;
        }

        if (info.file_size) {
            meta.file_size_string = info.file_size;
        }

        // Rankings
        if (info.rank_week || info.rank_month || info.rank_year || info.rank_total) {
            meta.rank = {};
            if (info.rank_day) meta.rank.day = info.rank_day;
            if (info.rank_week) meta.rank.week = info.rank_week;
            if (info.rank_month) meta.rank.month = info.rank_month;
            if (info.rank_year) meta.rank.year = info.rank_year;
            if (info.rank_total) meta.rank.total = info.rank_total;
        }

        // Discount
        if (info.discount) {
            meta.discount = {
                rate: info.discount.discount_rate || 0,
                end_date: info.discount.end_date ? String(info.discount.end_date) : ''
            };
        }

        if (info.rate_count_detail) {
            meta.rate_count_detail = info.rate_count_detail as Record<string, number>;
        }

        if (Array.isArray(info.contents)) {
            meta.contents = info.contents.map((c) => ({
                file_name: c.file_name || c.name || '',
                file_size: c.file_size_unit || c.file_size || ''
            }));
        }

        // Images
        if (info.image_main?.url) {
            const mainUrl = info.image_main.url.startsWith('//') ? `https:${info.image_main.url}` : info.image_main.url;
            meta.image_main = mainUrl;
        }
        if (Array.isArray(info.image_samples) && info.image_samples.length > 0) {
            meta.image_samples = info.image_samples
                .map((img) => {
                    const url = img?.url || img?.resize_url || '';
                    return url.startsWith('//') ? `https:${url}` : url;
                })
                .filter(Boolean);
        }

        return meta;
    }

    private getAgeString(ageCategory: number): string {
        if (ageCategory === 1) return 'ALL';
        if (ageCategory === 2) return 'R15';
        return 'R18';
    }

    private calculateRating(details: Record<string, number> | null): number {
        if (!details) return 0;
        let totalScore = 0;
        let totalCount = 0;

        for (const [scoreStr, count] of Object.entries(details)) {
            const score = parseInt(scoreStr, 10);
            const num = count as number;
            totalScore += score * num;
            totalCount += num;
        }

        return totalCount ? parseFloat((totalScore / totalCount).toFixed(2)) : 0;
    }

    /**
     * Scrape user reviews from the DLsite product page HTML.
     * Cached for 7 days. Resolves to empty array on failure.
     */
    public async scrapeReviews(rjCode: string): Promise<DLsiteUserReview[]> {
        const normalized = rjCode.toUpperCase();
        const key = CacheKeys.dlsiteReviews(normalized);

        // Check cache first
        const cached = SharedCache.get<DLsiteUserReview[]>(key);
        if (cached !== null && cached.length > 0) return cached;

        try {
            const reviews = await DLsiteService.fetchProductPageReviews(normalized);
            const tagged = reviews.map(r => ({ ...r, source_rjcode: r.source_rjcode || normalized }));

            if (tagged.length > 0) {
                // Cache successful results for 7 days
                SharedCache.set(key, tagged, this.cacheTtlMs);
            } else {
                // Cache empty results for only 30 minutes to allow retry
                SharedCache.set(key, tagged, 1000 * 60 * 30);
            }
            return tagged;
        } catch (e) {
            Logger.warn('[DLsiteScraper] Review scraping failed for', normalized, e);
            return [];
        }
    }
}
