import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { EventBus } from '../core/EventBus';
import { Config, Logger } from '../core/Utils';
import { buildCoverUrl } from '../types/api';
import { watchConfig } from '../store/ReactiveConfig';
import { gmRequest, retryWithBackoff } from '../infrastructure/HttpClient';
import { DEFAULT_API_SERVER, RETRY } from '../core/Constants';

const DEFAULT_FAVICON = 'https://images2.imgbox.com/c8/21/h1DhlGPW_o.png';

/**
 * Get the API base URL from the host app's axios baseURL
 */
function getApiBaseUrl(): string {
    try {
        const bridge = KikoeruBridge.getInstance();
        const baseURL = bridge.axios?.defaults?.baseURL;
        if (baseURL && baseURL.startsWith('http')) {
            return baseURL.replace(/\/$/, '');
        }
    } catch { /* ignore */ }
    return DEFAULT_API_SERVER;
}

export class FaviconNowPlaying {
    private bridge: KikoeruBridge;
    private originalFavicon: string | null = null;
    private lastWorkId: string | null = null;
    // Cache generated favicons by workId to avoid re-fetching/re-drawing
    private faviconCache = new Map<string, string>();
    private unwatchRoute: (() => void) | null = null;
    private eventCleanups: (() => void)[] = [];
    // Current favicon data URL we're trying to maintain
    private currentFaviconUrl: string | null = null;
    // MutationObserver to defend against site overwriting our favicon
    private faviconObserver: MutationObserver | null = null;
    private watcherInitialized = false;

    constructor() {
        this.bridge = KikoeruBridge.getInstance();
        this.watchToggle();
    }

    public enable(): void {
        if (!Config.get('dynamicFavicon')) {
            Logger.log('[FaviconNowPlaying] Disabled in settings');
            return;
        }

        Logger.log('[FaviconNowPlaying] Enabling dynamic favicon');
        this.saveOriginalFavicon();
        this.startFaviconGuard();

        // Subscribe to EventBus events for work/track changes
        this.setupEventListeners();

        // Watch route for work page navigation
        this.setupRouteWatcher();

        // Initial check - get workId from route or bridge
        const currentWorkId = this.bridge.currentWorkId;
        Logger.log('[FaviconNowPlaying] Current workId on init:', currentWorkId);
        if (currentWorkId && Config.get('dynamicFavicon')) {
            this.updateFaviconByWorkId(currentWorkId);
        } else {
            this.setFavicon(DEFAULT_FAVICON);
        }
    }

    private watchToggle(): void {
        if (this.watcherInitialized) return;
        this.watcherInitialized = true;

        watchConfig('dynamicFavicon', (enabled) => {
            if (enabled) {
                this.enable();
            } else {
                this.disable();
            }
        });
    }

    /**
     * Subscribe to EventBus events for work and track changes
     */
    private setupEventListeners(): void {
        // Listen for work changes (emitted by KikoeruBridge)
        const workChangeCleanup = EventBus.on('work:change', (data: { workId: string }) => {
            Logger.log('[FaviconNowPlaying] work:change event:', data.workId);
            if (Config.get('dynamicFavicon') && data.workId) {
                this.updateFaviconByWorkId(data.workId);
            }
        });
        this.eventCleanups.push(workChangeCleanup);

        // Listen for track changes (fallback)
        const trackChangeCleanup = EventBus.on('track:change', (data: { workId: string }) => {
            Logger.log('[FaviconNowPlaying] track:change event:', data.workId);
            if (Config.get('dynamicFavicon') && data.workId) {
                this.updateFaviconByWorkId(data.workId);
            }
        });
        this.eventCleanups.push(trackChangeCleanup);

        Logger.log('[FaviconNowPlaying] Event listeners registered');
    }

    /**
     * Watch Vue router for work page navigation
     */
    private setupRouteWatcher(): void {
        // Watch route params for workId
        this.unwatchRoute = this.bridge.$watch?.(
            '$route',
            (route: { path?: string; params?: { id?: string } }) => {
                const workId = route?.params?.id;
                Logger.log('[FaviconNowPlaying] Route changed:', route?.path, 'workId:', workId);
                if (workId && Config.get('dynamicFavicon')) {
                    this.updateFaviconByWorkId(workId);
                } else {
                    this.setFavicon(DEFAULT_FAVICON);
                }
            }
        ) || null;

        if (this.unwatchRoute) {
            Logger.log('[FaviconNowPlaying] Route watcher registered');
        }
    }

    /**
     * Update favicon using just a workId (when full work object isn't available)
     */
    private async updateFaviconByWorkId(workId: string): Promise<void> {
        if (this.lastWorkId === workId) return;
        this.lastWorkId = workId;

        if (this.faviconCache.has(workId)) {
            this.setFavicon(this.faviconCache.get(workId)!);
            return;
        }

        // Extract numeric ID from workId (RJ01382560 -> 1382560)
        const numericId = workId.replace(/^RJ0*/i, '');
        const coverUrl = buildCoverUrl(numericId, 'main', getApiBaseUrl());
        Logger.log('[Favicon] Generating by workId:', workId, 'numericId:', numericId);
        await this.generateFavicon(coverUrl, workId);
    }

    private saveOriginalFavicon(): void {
        const link = document.querySelector("link[rel*='icon']") as HTMLLinkElement;
        if (link) {
            this.originalFavicon = link.href;
        } else {
            this.originalFavicon = '/favicon.ico';
        }
    }

    /**
     * MutationObserver to detect and undo site's favicon changes.
     * SPAs like Vue/Quasar often reset favicons during navigation.
     */
    private startFaviconGuard(): void {
        if (this.faviconObserver) return;

        this.faviconObserver = new MutationObserver((mutations) => {
            if (!this.currentFaviconUrl) return;

            for (const mutation of mutations) {
                // Check added nodes for new favicon links
                for (const node of mutation.addedNodes) {
                    if (node instanceof HTMLLinkElement && node.rel.includes('icon')) {
                        // Site added a new favicon - check if it's ours
                        if (node.href !== this.currentFaviconUrl) {
                            Logger.log('[Favicon] Site tried to add favicon, removing it');
                            node.remove();
                            // Re-apply ours
                            this.applyFavicon(this.currentFaviconUrl);
                        }
                    }
                }

                // Check for attribute changes on existing favicons
                if (mutation.type === 'attributes' && mutation.target instanceof HTMLLinkElement) {
                    const link = mutation.target;
                    if (link.rel.includes('icon') && link.href !== this.currentFaviconUrl) {
                        Logger.log('[Favicon] Site tried to change favicon, reverting');
                        this.applyFavicon(this.currentFaviconUrl);
                    }
                }
            }
        });

        this.faviconObserver.observe(document.head, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['href', 'rel'],
        });
    }

    private stopFaviconGuard(): void {
        if (this.faviconObserver) {
            this.faviconObserver.disconnect();
            this.faviconObserver = null;
        }
    }

    public restoreFavicon(): void {
        this.currentFaviconUrl = null;
        this.lastWorkId = null;
        if (this.originalFavicon) {
            this.applyFavicon(this.originalFavicon);
        }
    }

    private async generateFavicon(imageUrl: string, workId: string): Promise<void> {
        try {
            // First, try setting the URL directly (works in some browsers)
            // This avoids CORS issues with cross-origin images
            Logger.log('[Favicon] Trying direct URL approach first:', imageUrl);
            this.setFavicon(imageUrl);

            // Then try to generate a data URL for better compatibility
            const blob = await this.fetchImage(imageUrl);
            if (!blob) {
                Logger.warn('[Favicon] Failed to fetch image, keeping direct URL:', imageUrl);
                return;
            }

            const dataUrl = await this.blobToFavicon(blob);
            this.faviconCache.set(workId, dataUrl);
            this.setFavicon(dataUrl);
            Logger.log('[Favicon] Successfully updated with data URL for work:', workId);
        } catch (e) {
            Logger.warn('[Favicon] Failed to generate data URL, using direct URL:', e);
            // Keep the direct URL that was set initially
        }
    }

    private async fetchImage(url: string): Promise<Blob | null> {
        try {
            const res = await retryWithBackoff(
                () => gmRequest({ url, responseType: 'blob' }),
                RETRY.BLOB,
            );
            return (res.response as Blob) ?? null;
        } catch {
            // Fallback to fetch
            try {
                const r = await fetch(url, { mode: 'cors' });
                return await r.blob();
            } catch (e) {
                Logger.warn('[Favicon] fetch error:', e);
                return null;
            }
        }
    }

    private blobToFavicon(blob: Blob): Promise<string> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const img = new Image();
                img.onload = () => {
                    try {
                        const canvas = document.createElement('canvas');
                        canvas.width = 32;
                        canvas.height = 32;
                        const ctx = canvas.getContext('2d');
                        if (!ctx) {
                            reject('No canvas context');
                            return;
                        }

                        ctx.drawImage(img, 0, 0, 32, 32);
                        const dataUrl = canvas.toDataURL('image/png');
                        resolve(dataUrl);
                    } catch (e) {
                        reject(e);
                    }
                };
                img.onerror = () => reject('Image load failed');
                img.src = reader.result as string;
            };
            reader.onerror = () => reject('FileReader failed');
            reader.readAsDataURL(blob);
        });
    }

    private setFavicon(url: string): void {
        this.currentFaviconUrl = url;
        this.applyFavicon(url);
    }

    /**
     * Actually apply the favicon to the DOM.
     * Removes all existing favicons first, then inserts ours at the head.
     */
    private applyFavicon(url: string): void {
        // Temporarily disconnect observer to avoid infinite loops
        const wasObserving = !!this.faviconObserver;
        if (wasObserving) {
            this.faviconObserver!.disconnect();
        }

        try {
            // Remove ALL existing favicon links
            const existingFavicons = document.querySelectorAll('link[rel*="icon"]');
            Logger.log('[Favicon] Removing', existingFavicons.length, 'existing favicon links');
            existingFavicons.forEach((el) => el.remove());

            // Create fresh favicon link
            const link = document.createElement('link');
            link.rel = 'icon';
            link.type = 'image/png';
            link.href = url;

            // Insert at the beginning of head for priority
            const head = document.head;
            if (head.firstChild) {
                head.insertBefore(link, head.firstChild);
            } else {
                head.appendChild(link);
            }

            Logger.log('[Favicon] Applied to DOM, href length:', url.length, 'isDataUrl:', url.startsWith('data:'));

            // Verify insertion
            const verifyLink = document.querySelector('link[rel="icon"]') as HTMLLinkElement;
            Logger.log('[Favicon] Verification - link found:', !!verifyLink, 'href matches:', verifyLink?.href === url);
        } finally {
            // Reconnect observer
            if (wasObserving && this.faviconObserver) {
                this.faviconObserver.observe(document.head, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    attributeFilter: ['href', 'rel'],
                });
            }
        }
    }

    public disable(): void {
        this.stopFaviconGuard();
        // Clean up event listeners
        for (const cleanup of this.eventCleanups) {
            cleanup();
        }
        this.eventCleanups = [];
        // Clean up route watcher
        if (this.unwatchRoute) this.unwatchRoute();
        this.restoreFavicon();
    }

    /**
     * Debug method - call from console: ASMRUlt.testFavicon()
     * Tests favicon setting with a simple colored square
     */
    public testWithColor(color = 'red'): void {
        Logger.log('[Favicon] Testing with color:', color);

        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            Logger.error('[Favicon] Cannot get canvas context');
            return;
        }

        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 32, 32);

        const dataUrl = canvas.toDataURL('image/png');
        Logger.log('[Favicon] Generated test data URL length:', dataUrl.length);
        Logger.log('[Favicon] Data URL preview:', dataUrl.substring(0, 100));

        this.setFavicon(dataUrl);

        // Verify it was set
        setTimeout(() => {
            const link = document.querySelector('link[rel*="icon"]') as HTMLLinkElement;
            Logger.log('[Favicon] After setting - link element:', link);
            Logger.log('[Favicon] After setting - href matches:', link?.href === dataUrl);
            Logger.log('[Favicon] After setting - href length:', link?.href?.length);
        }, 100);
    }

    /**
     * Debug: manually trigger favicon update for current work
     */
    public forceUpdate(): void {
        const workId = this.bridge.currentWorkId;
        Logger.log('[Favicon] Force update - workId:', workId);
        if (workId) {
            this.lastWorkId = null; // Reset to force update
            this.updateFaviconByWorkId(workId);
        } else {
            Logger.warn('[Favicon] No current workId to update');
        }
    }
}
