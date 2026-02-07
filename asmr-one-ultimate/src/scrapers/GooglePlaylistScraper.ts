import { GM_getValue, GM_setValue } from '$';
import { Logger } from '../core/Utils';
import { gmRequest } from '../infrastructure/HttpClient';

const RATE_LIMIT_KEY = 'asmr_ultimate_google_rate_limited';
const RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes cooldown after 429

/**
 * Google Search scraper for finding indexed playlist URLs
 * Uses the simple Google Search URL format with pagination
 */
export class GooglePlaylistScraper {
    // Search all ASMR domains for playlists - use inurl: to find playlist pages
    // Google deduplicates similar content automatically, but we also dedupe by UUID in code
    private static readonly SEARCH_QUERY = 'inurl:playlist (site:asmr.one OR site:asmr-100.com OR site:asmr-200.com OR site:asmr-300.com)';
    private static readonly MAX_PAGES = 30; // Reduced since we have hardcoded IDs
    private static readonly RESULTS_PER_PAGE = 10; // Google defaults to 10 per page
    private static readonly MAX_RETRIES = 3;
    private static readonly INITIAL_BACKOFF_MS = 1000;
    private static readonly PAGE_DELAY_MS = 1500; // Increased delay to be safer

    /**
     * Fetch playlist IDs from Google search results (all pages)
     */
    static async discoverPlaylists(
        onProgress?: (page: number, found: number) => void
    ): Promise<string[]> {
        // Check rate limit before starting
        if (this.isRateLimited()) {
            Logger.warn('[GooglePlaylistScraper] Skipping discovery - rate limited');
            return [];
        }

        const allPlaylistIds = new Set<string>();
        let consecutiveErrors = 0;
        let consecutiveNoNewResults = 0;
        let hitRateLimit = false;

        Logger.debug('[GooglePlaylistScraper] Starting Google discovery');

        for (let page = 0; page < this.MAX_PAGES; page++) {
            try {
                const start = page * this.RESULTS_PER_PAGE;
                const html = await this.fetchSearchPageWithRetry(start);
                const playlistIds = this.parseSearchResults(html);

                const prevSize = allPlaylistIds.size;
                playlistIds.forEach(id => allPlaylistIds.add(id));
                const newCount = allPlaylistIds.size - prevSize;

                Logger.debug(`[GooglePlaylistScraper] Page ${page + 1}: found ${playlistIds.length} UUIDs, ${newCount} new, total ${allPlaylistIds.size}`);

                if (onProgress) {
                    onProgress(page + 1, allPlaylistIds.size);
                }

                // Track consecutive pages with no new results
                if (newCount === 0) {
                    consecutiveNoNewResults++;
                    // Only stop after 3 consecutive pages with no new results
                    if (consecutiveNoNewResults >= 3) {
                        Logger.debug('[GooglePlaylistScraper] 3 consecutive pages with no new results, stopping');
                        break;
                    }
                } else {
                    consecutiveNoNewResults = 0;
                }

                // Check if we've hit a "no more results" indicator
                if (this.isLastPage(html)) {
                    Logger.debug('[GooglePlaylistScraper] Last page detected, stopping');
                    break;
                }

                consecutiveErrors = 0;

                // Delay between pages to be respectful
                if (page < this.MAX_PAGES - 1) {
                    await new Promise(resolve => setTimeout(resolve, this.PAGE_DELAY_MS));
                }
            } catch (error) {
                // Check if rate limited - stop immediately
                const isRateLimited = error instanceof Error && error.message === 'RATE_LIMITED';
                if (isRateLimited) {
                    hitRateLimit = true;
                    Logger.warn('[GooglePlaylistScraper] Rate limited - stopping discovery');
                    break;
                }

                consecutiveErrors++;
                Logger.error(`[GooglePlaylistScraper] Error on page ${page + 1}:`, error);

                if (consecutiveErrors >= 2) {
                    Logger.warn('[GooglePlaylistScraper] Too many consecutive errors, stopping');
                    break;
                }
            }
        }

        const results = Array.from(allPlaylistIds);
        if (hitRateLimit) {
            Logger.debug(`[GooglePlaylistScraper] Discovery stopped due to rate limit: ${results.length} playlists found before limit`);
        } else {
            Logger.debug(`[GooglePlaylistScraper] Discovery complete: ${results.length} playlists found`);
        }
        return results;
    }

    private static async fetchSearchPageWithRetry(start: number, retryCount = 0): Promise<string> {
        try {
            return await this.fetchSearchPage(start);
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            const isRateLimited = errMsg === 'RATE_LIMITED' || errMsg.includes('429');
            if (isRateLimited) {
                // Mark rate limited and don't retry - need to wait much longer
                GM_setValue(RATE_LIMIT_KEY, Date.now());
                Logger.warn('[GooglePlaylistScraper] Rate limited by Google, cooldown activated');
                throw new Error('RATE_LIMITED');
            }
            if (retryCount < this.MAX_RETRIES) {
                const backoffMs = this.INITIAL_BACKOFF_MS * Math.pow(2, retryCount);
                Logger.debug(`[GooglePlaylistScraper] Retry ${retryCount + 1}/${this.MAX_RETRIES} after ${backoffMs}ms`);
                await new Promise(resolve => setTimeout(resolve, backoffMs));
                return this.fetchSearchPageWithRetry(start, retryCount + 1);
            }
            throw error;
        }
    }

    /**
     * Check if we're currently rate limited by Google
     */
    static isRateLimited(): boolean {
        try {
            const limitedAt = this.safeGetValue(RATE_LIMIT_KEY, 0) as number;
            if (limitedAt && Date.now() - limitedAt < RATE_LIMIT_COOLDOWN_MS) {
                const remainingMin = Math.ceil((RATE_LIMIT_COOLDOWN_MS - (Date.now() - limitedAt)) / 60000);
                Logger.debug(`[GooglePlaylistScraper] Still rate limited, ${remainingMin} minutes remaining`);
                return true;
            }
        } catch (e) {
            // ignore
        }
        return false;
    }

    /**
     * Clear rate limit flag (for manual refresh)
     */
    static clearRateLimit(): void {
        this.safeSetValue(RATE_LIMIT_KEY, 0);
    }

    static safeSetValue(key: string, value: any): void {
        try {
            if (typeof GM_setValue !== 'undefined') {
                GM_setValue(key, value);
            }
        } catch (e) { /* ignore */ }
    }

    static safeGetValue(key: string, defaultValue: any): any {
        try {
            if (typeof GM_getValue !== 'undefined') {
                return GM_getValue(key, defaultValue);
            }
        } catch (e) { /* ignore */ }
        return defaultValue;
    }

    private static async fetchSearchPage(start: number): Promise<string> {
        // Build Google search URL with pagination
        // num=10: explicitly request 10 results
        // hl=en: force English UI for reliable scraping
        // aic=0: additional parameter from user's working links
        const url = `https://www.google.com/search?q=${encodeURIComponent(this.SEARCH_QUERY)}&num=10&start=${start}&hl=en&aic=0`;

        Logger.debug(`[GooglePlaylistScraper] Fetching: ${url}`);

        try {
            const response = await gmRequest({
                method: 'GET',
                url: url,
                headers: {
                    // Rotate user agents to avoid detection
                    'User-Agent': this.getRandomUserAgent(),
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache',
                },
                timeout: 30000,
            });

            // Check for CAPTCHA or block in the response text
            if (response.responseText.includes('detected unusual traffic') ||
                response.responseText.includes('CAPTCHA') ||
                response.responseText.includes('recaptcha')) {
                Logger.warn('[GooglePlaylistScraper] CAPTCHA detected, may need to slow down');
                throw new Error('RATE_LIMITED');
            }

            return response.responseText;

        } catch (error: any) {
            // Handle specific errors
            if (error.status === 429 || error.message === 'RATE_LIMITED') {
                Logger.warn('[GooglePlaylistScraper] Rate limited (429)');
                this.safeSetValue(RATE_LIMIT_KEY, Date.now());
                throw new Error('RATE_LIMITED');
            }
            throw new Error(`Fetch failed: ${error.message}`);
        }
    }

    /**
     * Get a random user agent to avoid detection
     */
    private static getRandomUserAgent(): string {
        const userAgents = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
        ];
        return userAgents[Math.floor(Math.random() * userAgents.length)];
    }

    /**
     * Parse Google search results HTML to extract playlist IDs (UUIDs)
     */
    private static parseSearchResults(html: string): string[] {
        const playlistIds: string[] = [];

        // Log a sample of the HTML for debugging
        Logger.debug(`[GooglePlaylistScraper] HTML length: ${html.length}`);

        // Pattern 1: Query parameter format - asmr.one/playlist?id=UUID (most common)
        // Matches: href="https://www.asmr.one/playlist?id=4b715ad5-3f14-46c0-a708-6d8c950baa7b"
        const queryPattern = /asmr\.one\/playlist\?id=([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/gi;
        for (const match of html.matchAll(queryPattern)) {
            const uuid = match[1].toLowerCase();
            if (!playlistIds.includes(uuid)) {
                playlistIds.push(uuid);
            }
        }

        // Pattern 2: URL-encoded query parameter - asmr.one/playlist%3Fid%3DUUID or asmr.one%2Fplaylist%3Fid%3DUUID
        const encodedQueryPattern = /asmr\.one(?:%2F|\/)playlist(?:%3F|\?)id(?:%3D|=)([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/gi;
        for (const match of html.matchAll(encodedQueryPattern)) {
            const uuid = match[1].toLowerCase();
            if (!playlistIds.includes(uuid)) {
                playlistIds.push(uuid);
            }
        }

        // Pattern 3: Path format - asmr.one/playlist/UUID (older format, still may exist)
        const pathPattern = /asmr\.one\/playlist\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/gi;
        for (const match of html.matchAll(pathPattern)) {
            const uuid = match[1].toLowerCase();
            if (!playlistIds.includes(uuid)) {
                playlistIds.push(uuid);
            }
        }

        // Pattern 4: Google translate links contain encoded URLs
        // translate.google.com/translate?u=https://www.asmr.one/playlist?id%3DUUID
        const translatePattern = /translate\.google\.com\/translate\?u=[^"]*asmr\.one[^"]*(?:%3D|=)([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/gi;
        for (const match of html.matchAll(translatePattern)) {
            const uuid = match[1].toLowerCase();
            if (!playlistIds.includes(uuid)) {
                playlistIds.push(uuid);
            }
        }

        // Pattern 5: Fallback - find any valid UUID in the HTML if other patterns found nothing
        // Only if we haven't found anything and the page mentions asmr.one playlist
        if (playlistIds.length === 0 && html.includes('asmr') && html.includes('playlist')) {
            const uuidPattern = /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/gi;
            for (const match of html.matchAll(uuidPattern)) {
                const uuid = match[1].toLowerCase();
                if (!playlistIds.includes(uuid)) {
                    playlistIds.push(uuid);
                }
            }
            if (playlistIds.length > 0) {
                Logger.debug(`[GooglePlaylistScraper] Used fallback pattern, found ${playlistIds.length} UUIDs`);
            }
        }

        Logger.debug(`[GooglePlaylistScraper] Page parsed: ${playlistIds.length} unique UUIDs`);
        return playlistIds;
    }

    /**
     * Check if this is the last page of results
     */
    private static isLastPage(html: string): boolean {
        // Google shows various "Next" indicators
        // Check for multiple patterns since Google's HTML changes frequently
        const nextPatterns = [
            /id="pnnext"/i,                    // Classic next page link
            /aria-label="Next"/i,              // Aria label for next
            /aria-label="Next page"/i,         // Specific aria-label
            /aria-label="Page \d+"/i,          // Page number buttons
            /class="[^"]*AaVjTc[^"]*"/i,       // Pagination container class
            />Next</i,                         // "Next" text in button
            /start=\d+["']/i,                  // More page links with start param
        ];

        // Also check for "no results" or end of results indicators
        const endIndicators = [
            /did not match any documents/i,
            /No results found/i,
            /your search.*did not match/i,
        ];

        // If we see end indicators, definitely last page
        for (const pattern of endIndicators) {
            if (pattern.test(html)) {
                Logger.debug('[GooglePlaylistScraper] End of results detected');
                return true;
            }
        }

        // If we see any next page indicator, not last page
        for (const pattern of nextPatterns) {
            if (pattern.test(html)) {
                return false;
            }
        }

        // Default: assume not last page to continue searching
        // We rely on consecutiveNoNewResults to stop
        return false;
    }
}
