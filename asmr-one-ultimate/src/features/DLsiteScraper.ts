import { Logger } from '../core/Utils';
import { CACHE_TTL } from '../core/Constants';
import { CacheKeys, SharedCache } from '../core/Cache';
import { DLsiteService } from '../services/DLsiteService';
import type { DLsiteProductApiResponse, DLsiteDynamicEntry, DLsiteUserReview } from '../types/dlsite';

// Re-export DLsiteMetadata so existing imports from './DLsiteScraper' still work
export type { DLsiteMetadata } from '../types/dlsite';
import type { DLsiteMetadata } from '../types/dlsite';

export class DLsiteScraper {
    private static instance: DLsiteScraper;
    private cacheTtlMs = CACHE_TTL.SEVEN_DAYS_MS;
    private static readonly DETAILS_SCHEMA_VERSION = 2;

    public static getInstance(): DLsiteScraper {
        if (!this.instance) this.instance = new DLsiteScraper();
        return this.instance;
    }

    public async scrape(rjCode: string): Promise<DLsiteMetadata> {
        const normalized = rjCode.toUpperCase();
        const key = CacheKeys.dlsite(normalized);
        const cached = SharedCache.get<DLsiteMetadata>(key);
        if (cached) {
            return this.maybeUpgradeMetadata(cached, normalized, key);
        }
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
        if (cached) return this.maybeUpgradeMetadata(cached, normalized, key);

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

        // Phase 2: Fetch enriched data from product HTML (body + stable sample images)
        if (base) {
            let detailsEnriched = false;
            try {
                const [bodyResult, samplesResult] = await Promise.allSettled([
                    DLsiteService.fetchProductPageBody(normalized),
                    DLsiteService.fetchProductPageSampleImages(normalized),
                ]);
                if (bodyResult.status === 'fulfilled' && bodyResult.value) {
                    base.body = bodyResult.value;
                    detailsEnriched = true;
                }
                if (samplesResult.status === 'fulfilled' && samplesResult.value.length > 0) {
                    base.image_samples = this.mergeSampleImageUrls(samplesResult.value, base.image_samples || []);
                    detailsEnriched = true;
                }
            } catch (e) {
                Logger.warn('[DLsiteScraper] Page body fetch failed', e);
            }
            if (detailsEnriched) base.details_schema_version = DLsiteScraper.DETAILS_SCHEMA_VERSION;
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

        // Try to fetch enriched data from product HTML (body + stable sample images)
        if (base) {
            let detailsEnriched = false;
            try {
                const [bodyResult, samplesResult] = await Promise.allSettled([
                    DLsiteService.fetchProductPageBody(normalized),
                    DLsiteService.fetchProductPageSampleImages(normalized),
                ]);
                if (bodyResult.status === 'fulfilled' && bodyResult.value) {
                    base.body = bodyResult.value;
                    detailsEnriched = true;
                }
                if (samplesResult.status === 'fulfilled' && samplesResult.value.length > 0) {
                    base.image_samples = this.mergeSampleImageUrls(samplesResult.value, base.image_samples || []);
                    detailsEnriched = true;
                }
            } catch (e) {
                Logger.warn('[DLsiteScraper] Page body fetch failed', e);
            }
            if (detailsEnriched) base.details_schema_version = DLsiteScraper.DETAILS_SCHEMA_VERSION;
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

    private needsSampleUpgrade(meta: DLsiteMetadata): boolean {
        const samples = meta.image_samples || [];
        if (samples.length === 0) return false;
        const hasParts = samples.some(url => this.isPartsSampleUrl(url));
        const hasLegacy = samples.some(url => this.isLegacySampleUrl(url));
        // Already resilient when both families are present.
        if (hasParts && hasLegacy) return false;
        // Upgrade if only one family is present.
        return hasParts || hasLegacy;
    }

    private async maybeUpgradeMetadata(meta: DLsiteMetadata, normalized: string, key: string): Promise<DLsiteMetadata> {
        const needsDetailUpgrade = meta.details_schema_version !== DLsiteScraper.DETAILS_SCHEMA_VERSION;
        if (!needsDetailUpgrade && !this.needsSampleUpgrade(meta)) return meta;
        try {
            const existing = meta.image_samples || [];
            const hasParts = existing.some(url => this.isPartsSampleUrl(url));
            const hasLegacy = existing.some(url => this.isLegacySampleUrl(url));

            const bodyPromise = needsDetailUpgrade && !meta.body
                ? DLsiteService.fetchProductPageBody(normalized).catch(() => null)
                : Promise.resolve<string | null>(null);
            const pageSamplesPromise = hasParts
                ? Promise.resolve<string[]>([])
                : DLsiteService.fetchProductPageSampleImages(normalized).catch(() => []);
            const legacySamplesPromise = hasLegacy
                ? Promise.resolve<string[]>([])
                : DLsiteService.fetchProductApi(normalized)
                    .then((info) => this.extractApiSampleUrls(info))
                    .catch(() => []);

            const [body, pageSamples, legacySamples] = await Promise.all([
                bodyPromise,
                pageSamplesPromise,
                legacySamplesPromise,
            ]);
            const upgradedSamples = this.mergeSampleImageUrls(pageSamples, this.mergeSampleImageUrls(existing, legacySamples));
            // details_schema_version records a successful HTML enrichment pass,
            // not merely an `intro` body inherited from the product JSON API.
            // Keeping the latter unversioned lets a transient HTML/gallery
            // failure recover on the next cache read.
            const detailEnriched = !!body || pageSamples.length > 0;
            const nextDetailsSchema = detailEnriched
                ? DLsiteScraper.DETAILS_SCHEMA_VERSION
                : meta.details_schema_version;
            const hasMetadataChanges = !!body || nextDetailsSchema !== meta.details_schema_version;
            if (!hasMetadataChanges && upgradedSamples.length === existing.length &&
                upgradedSamples.every((url, idx) => url === existing[idx])) {
                return meta;
            }

            const upgraded = {
                ...meta,
                ...(body ? { body } : {}),
                image_samples: upgradedSamples,
                ...(nextDetailsSchema ? { details_schema_version: nextDetailsSchema } : {}),
            };
            SharedCache.set(key, upgraded, this.cacheTtlMs);
            return upgraded;
        } catch (e) {
            Logger.debug('[DLsiteScraper] Sample URL cache upgrade failed', e);
            return meta;
        }
    }

    private extractApiSampleUrls(info: DLsiteProductApiResponse | null): string[] {
        if (!info || !Array.isArray(info.image_samples) || info.image_samples.length === 0) return [];
        return info.image_samples
            .map((img) => {
                const url = img?.url || img?.resize_url || '';
                return this.normalizeSampleUrl(url);
            })
            .filter((url): url is string => !!url);
    }

    private mergeSampleImageUrls(primary: string[], secondary: string[]): string[] {
        const merged = [...primary, ...secondary]
            .map((url) => this.normalizeSampleUrl(url))
            .filter((url): url is string => !!url);
        const deduped = merged.filter((url, idx, arr) => arr.indexOf(url) === idx);
        const partUrls = deduped.filter((url) => this.isPartsSampleUrl(url));
        const otherUrls = deduped.filter((url) => !this.isPartsSampleUrl(url));
        return [...partUrls, ...otherUrls];
    }

    private normalizeSampleUrl(url: string): string {
        if (!url) return '';
        if (url.startsWith('//')) return `https:${url}`;
        return url;
    }

    private isPartsSampleUrl(url: string): boolean {
        return /\/modpub\/images2\/parts\//i.test(url);
    }

    private isLegacySampleUrl(url: string): boolean {
        return /_img_smp\d+\.(jpg|jpeg|png)(\?|$)/i.test(url);
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
            meta.image_samples = this.extractApiSampleUrls(info);
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
