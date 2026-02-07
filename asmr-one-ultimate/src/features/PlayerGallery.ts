/**
 * PlayerGallery - Image slideshow for the audio player.
 *
 * In normal mode: shows prev/next arrows on albumart hover when 2+ images.
 * In fullscreen mode: shows full gallery with large image, nav arrows, counter.
 * Auto-slideshow: cycles images every N seconds in fullscreen (configurable).
 *
 * Image sources (priority):
 *   1. Cover art from the existing q-img background-image (always available)
 *   2. DLsite sample images from WorkMetadata gallery
 *   3. Work tree images from the tracks API
 */

import { Config, Logger } from '../core/Utils';
import { I18n } from '../core/Config';
import { CentralObserver } from '../core/CentralObserver';
import { EventBus } from '../core/EventBus';
import { AppStore } from '../store/AppStore';
import { WorkService } from '../services/WorkService';
import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { MediaViewerController } from './MediaViewerController';
import type { TrackFolder, TrackItem } from '../types/api';

const IMG_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg']);

export class PlayerGallery {
    private static instance: PlayerGallery;
    private images: string[] = [];
    private index = 0;
    private loadedWorkId: string | null = null;
    private loadSeq = 0;
    private touchStartX = 0;
    private _isFullscreen = false;

    // Auto-slideshow state
    private slideshowTimer: ReturnType<typeof setInterval> | null = null;
    private slideshowPaused = false; // user paused via nav for this work

    // MutationObserver for late-arriving DLsite gallery images
    private galleryObserver: MutationObserver | null = null;
    private imageSeen = new Set<string>(); // dedup across loadImages + observer

    private constructor() {}

    public static getInstance(): PlayerGallery {
        if (!PlayerGallery.instance) {
            PlayerGallery.instance = new PlayerGallery();
        }
        return PlayerGallery.instance;
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    public enable(): void {
        CentralObserver.register('player-gallery', () => this.ensureElements(), 500);
        EventBus.on('fullscreen:enter', () => { this._isFullscreen = true; this.onEnterFullscreen(); });
        EventBus.on('fullscreen:exit', () => { this._isFullscreen = false; this.onExitFullscreen(); });
        EventBus.on('work:change', (p) => this.onWorkChange(p.workId));
        EventBus.on('config:change', (p) => {
            if (p.key === 'galleryAutoSlideshow' || p.key === 'galleryAutoSlideshowInterval') {
                this.syncSlideshow();
            }
        });
        document.addEventListener('keydown', (e) => this.onKeydown(e), true);
        Logger.log('[PlayerGallery] Enabled');
    }

    public disable(): void {
        this.stopSlideshow();
        this.disconnectGalleryObserver();
    }

    // ------------------------------------------------------------------
    // Fullscreen events
    // ------------------------------------------------------------------

    private async onEnterFullscreen(): Promise<void> {
        Logger.debug('[PlayerGallery] fullscreen:enter');

        // Step 1: Immediately show the cover image (scraped from DOM)
        const coverUrl = this.scrapeCoverUrl();
        if (coverUrl && this.images.length === 0) {
            this.images = [coverUrl];
            this.imageSeen.add(coverUrl);
            this.index = 0;
        }
        if (this.images.length > 0) {
            this.showImage();
        }

        // Step 2: Load more images from the tracks API
        const workId = this.detectWorkId();
        Logger.debug('[PlayerGallery] workId=', workId, 'cached=', this.loadedWorkId, 'images=', this.images.length);

        if (workId && workId !== this.loadedWorkId) {
            await this.loadImages(workId);
            if (this.isFullscreen) {
                this.showImage();
            }
        } else {
            // Catch-up: DLsite gallery may have rendered after preload()
            this.scrapeDlsiteGallery((url) => {
                if (!url || this.imageSeen.has(url)) return;
                this.imageSeen.add(url);
                this.images.push(url);
            });
        }

        this.syncAlbumart();
        // Reset pause state on re-entering fullscreen
        this.slideshowPaused = false;
        this.startSlideshow();
    }

    private onExitFullscreen(): void {
        this.stopSlideshow();
        // Remove inline display override — CSS base rule handles hiding
        const img = document.querySelector('.audio-player .albumart .asmr-gallery-img') as HTMLImageElement;
        if (img) img.style.removeProperty('display');
    }

    private onWorkChange(workId: string): void {
        // Reset slideshow state for the new work
        this.stopSlideshow();
        this.slideshowPaused = false;
        this.disconnectGalleryObserver();

        if (workId && workId !== this.loadedWorkId) {
            // Hide stale gallery image from previous work
            const img = document.querySelector('.audio-player .albumart .asmr-gallery-img') as HTMLImageElement;
            if (img) img.style.removeProperty('display');
            this.loadImages(workId).then(() => {
                // After loading, start slideshow if in fullscreen
                if (this.isFullscreen && this.images.length >= 2) {
                    this.startSlideshow();
                }
            });
        }
    }

    // ------------------------------------------------------------------
    // Auto-slideshow
    // ------------------------------------------------------------------

    private startSlideshow(): void {
        this.stopSlideshow();
        if (!this.isFullscreen) return;
        if (this.slideshowPaused) return;
        if (this.images.length < 2) return;
        if (!Config.get('galleryAutoSlideshow')) return;

        const interval = Math.max(2, Number(Config.get('galleryAutoSlideshowInterval')) || 6);
        this.slideshowTimer = setInterval(() => {
            if (!this.isFullscreen || this.images.length < 2) {
                this.stopSlideshow();
                return;
            }
            this.index = (this.index + 1) % this.images.length;
            this.showImage();
        }, interval * 1000);
        Logger.debug('[PlayerGallery] Slideshow started, interval=', interval, 's');
    }

    private stopSlideshow(): void {
        if (this.slideshowTimer !== null) {
            clearInterval(this.slideshowTimer);
            this.slideshowTimer = null;
            Logger.debug('[PlayerGallery] Slideshow stopped');
        }
    }

    /** Re-evaluate slideshow state (e.g. after config change) */
    private syncSlideshow(): void {
        if (this.isFullscreen && !this.slideshowPaused && this.images.length >= 2) {
            this.startSlideshow();
        } else {
            this.stopSlideshow();
        }
    }

    /** Pause slideshow for this work (user navigated manually) */
    private pauseSlideshow(): void {
        if (this.slideshowTimer !== null || !this.slideshowPaused) {
            this.slideshowPaused = true;
            this.stopSlideshow();
            Logger.debug('[PlayerGallery] Slideshow paused by user navigation');
        }
    }

    // ------------------------------------------------------------------
    // DLsite gallery MutationObserver
    // ------------------------------------------------------------------

    private observeDlsiteGallery(): void {
        this.disconnectGalleryObserver();
        const gallery = document.querySelector('.asmr-meta-gallery');
        if (!gallery) {
            // Gallery element doesn't exist yet — watch for it to appear
            const bodyObs = new MutationObserver(() => {
                const g = document.querySelector('.asmr-meta-gallery');
                if (g) {
                    bodyObs.disconnect();
                    this.attachGalleryObserver(g);
                }
            });
            bodyObs.observe(document.body, { childList: true, subtree: true });
            // Store so we can disconnect on cleanup
            this.galleryObserver = bodyObs;
            return;
        }
        this.attachGalleryObserver(gallery);
    }

    private attachGalleryObserver(gallery: Element): void {
        this.disconnectGalleryObserver();
        const obs = new MutationObserver(() => {
            let added = false;
            const imgs = gallery.querySelectorAll('img');
            for (const el of imgs) {
                const src = (el as HTMLImageElement).src;
                if (src && !this.imageSeen.has(src)) {
                    this.imageSeen.add(src);
                    this.images.push(src);
                    added = true;
                }
            }
            if (added) {
                this.syncAlbumart();
                if (this.isFullscreen) this.updateCounter();
                // If slideshow wasn't started because <2 images, try again
                if (this.isFullscreen && !this.slideshowPaused && this.slideshowTimer === null && this.images.length >= 2) {
                    this.startSlideshow();
                }
                Logger.debug('[PlayerGallery] DLsite gallery updated, total images:', this.images.length);
            }
        });
        obs.observe(gallery, { childList: true, subtree: true });
        this.galleryObserver = obs;
    }

    private disconnectGalleryObserver(): void {
        if (this.galleryObserver) {
            this.galleryObserver.disconnect();
            this.galleryObserver = null;
        }
    }

    // ------------------------------------------------------------------
    // DOM element injection
    // ------------------------------------------------------------------

    private ensureElements(): void {
        const albumart = document.querySelector('.audio-player .albumart') as HTMLElement;
        if (!albumart || albumart.querySelector('.asmr-gallery-img')) return;

        CentralObserver.withModification(() => {
            // Ensure positioning context
            if (getComputedStyle(albumart).position === 'static') {
                albumart.style.position = 'relative';
            }

            // Gallery image (hidden by default via CSS)
            const img = document.createElement('img');
            img.className = 'asmr-gallery-img';
            img.draggable = false;

            // Navigation arrows
            const prev = this.createNavButton('chevron_left', 'galleryPrev', 'asmr-gallery-prev', -1);
            const next = this.createNavButton('chevron_right', 'galleryNext', 'asmr-gallery-next', 1);

            // Counter badge
            const counter = document.createElement('span');
            counter.className = 'asmr-gallery-counter';

            // Click albumart → open lightbox (fullscreen only)
            albumart.addEventListener('click', (e) => {
                if (!this.isFullscreen || !this.images.length) return;
                if ((e.target as HTMLElement).closest('.asmr-gallery-nav')) return;
                this.openLightbox();
            });

            // Touch swipe on albumart (fullscreen only)
            albumart.addEventListener('touchstart', (e) => {
                if (!this.isFullscreen || e.touches.length !== 1) return;
                this.touchStartX = e.touches[0].clientX;
            }, { passive: true });
            albumart.addEventListener('touchend', (e) => {
                if (!this.isFullscreen || !e.changedTouches.length) return;
                const dx = e.changedTouches[0].clientX - this.touchStartX;
                if (Math.abs(dx) > 50) this.navigate(dx < 0 ? 1 : -1);
            }, { passive: true });

            albumart.append(img, prev, next, counter);

            // If already in fullscreen with images, render now
            if (this.isFullscreen && this.images.length > 0) {
                this.showImage();
            }

            this.syncAlbumart();
        });
    }

    private createNavButton(icon: string, i18nKey: string, cls: string, dir: number): HTMLButtonElement {
        const btn = document.createElement('button');
        btn.className = `asmr-gallery-nav ${cls}`;
        btn.setAttribute('aria-label', I18n.t(i18nKey));
        btn.title = I18n.t(i18nKey);
        btn.innerHTML = `<i class="material-icons" aria-hidden="true">${icon}</i>`;
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.navigate(dir);
        });
        return btn;
    }

    // ------------------------------------------------------------------
    // Navigation
    // ------------------------------------------------------------------

    private onKeydown(e: KeyboardEvent): void {
        if (!this.isFullscreen) return;
        const t = e.target as HTMLElement;
        if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;

        if (this.images.length < 2) return;
        if (e.key === 'ArrowLeft') { this.navigate(-1); e.preventDefault(); }
        else if (e.key === 'ArrowRight') { this.navigate(1); e.preventDefault(); }
    }

    private navigate(dir: number): void {
        if (this.images.length < 2) return;
        // Manual navigation pauses auto-slideshow for this work
        this.pauseSlideshow();
        this.index = (this.index + dir + this.images.length) % this.images.length;
        this.showImage();
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

    private showImage(): void {
        const albumart = document.querySelector('.audio-player .albumart') as HTMLElement;
        if (!albumart) return;
        const img = albumart.querySelector('.asmr-gallery-img') as HTMLImageElement;
        if (!img) return;

        const url = this.images[this.index];
        if (!url) return;

        Logger.debug('[PlayerGallery] showImage index=', this.index, 'url=', url.substring(0, 80));

        img.src = url;
        img.style.display = 'block';

        // Update blurred backdrop
        const player = document.querySelector('.audio-player') as HTMLElement;
        if (player) player.style.setProperty('--cover-url', `url("${url}")`);

        this.updateCounter(albumart);
    }

    private updateCounter(albumart?: HTMLElement): void {
        albumart = albumart || document.querySelector('.audio-player .albumart') as HTMLElement;
        if (!albumart) return;
        const counter = albumart.querySelector('.asmr-gallery-counter') as HTMLElement;
        if (!counter) return;
        counter.textContent = this.images.length > 1 ? `${this.index + 1} / ${this.images.length}` : '';
    }

    /**
     * Set data-gallery-count on albumart so CSS can hide nav when <=1 image.
     */
    private syncAlbumart(): void {
        const albumart = document.querySelector('.audio-player .albumart') as HTMLElement;
        if (!albumart) return;
        albumart.setAttribute('data-gallery-count', String(this.images.length));
    }

    private openLightbox(): void {
        // Pause slideshow while lightbox is open
        this.pauseSlideshow();
        try {
            MediaViewerController.getInstance().showExternalImages(this.images, this.index);
        } catch {
            window.open(this.images[this.index], '_blank');
        }
    }

    // ------------------------------------------------------------------
    // Image collection
    // ------------------------------------------------------------------

    private async loadImages(workId: string): Promise<void> {
        if (!workId) return;
        const seq = ++this.loadSeq;
        this.loadedWorkId = workId;

        // Clear previous work's images
        this.images = [];
        this.index = 0;
        this.imageSeen.clear();
        const add = (url: string) => {
            if (!url || this.imageSeen.has(url)) return;
            this.imageSeen.add(url);
            this.images.push(url);
        };

        // Ensure cover is present
        const cover = this.scrapeCoverUrl();
        if (cover) add(cover);

        // Show cover immediately if in fullscreen (don't wait for async)
        if (this.isFullscreen && this.images.length > 0) {
            this.showImage();
            this.syncAlbumart();
        }

        // Scrape DLsite sample images from WorkMetadata gallery
        this.scrapeDlsiteGallery(add);

        // Start observing for late-arriving DLsite gallery images
        this.observeDlsiteGallery();

        // Try Vue work tree component
        try {
            if (seq !== this.loadSeq) return;
            const bridge = KikoeruBridge.getInstance();
            const wt = bridge.findWorkTreeComponent() as any;
            if (wt) {
                const folder = wt.fatherFolder || wt.$data?.fatherFolder || [];
                if (Array.isArray(folder)) this.extractImageUrls(folder, add);
                const tree = wt.tree || wt.$data?.tree;
                if (Array.isArray(tree)) this.extractImageUrls(this.flatten(tree), add);
            }
        } catch { /* ignore */ }

        // Fetch tracks API
        try {
            const tracks = await WorkService.getTracks(workId);
            if (seq !== this.loadSeq) return;
            if (Array.isArray(tracks)) {
                this.extractImageUrls(this.flatten(tracks), add);
                Logger.debug('[PlayerGallery] Tracks loaded, total images:', this.images.length);
            }
        } catch (err) {
            Logger.debug('[PlayerGallery] Tracks fetch failed:', err);
        }

        if (seq !== this.loadSeq) return;
        this.syncAlbumart();
    }

    private extractImageUrls(items: any[], add: (url: string) => void): void {
        const token = localStorage.getItem('jwt-token') || '';
        for (const item of items) {
            if (item.type === 'folder') continue;
            if (!this.isImageItem(item)) continue;
            const url = this.buildUrl(item, token);
            if (url) add(url);
        }
    }

    private isImageItem(item: any): boolean {
        if (item.type === 'image') return true;
        if (item.title) {
            const name = item.title.replace(/\s*\(.*?\)\s*$/, '');
            const dot = name.lastIndexOf('.');
            return dot >= 0 && IMG_EXTS.has(name.slice(dot).toLowerCase());
        }
        return false;
    }

    private buildUrl(item: any, token: string): string {
        const withToken = (url: string): string => {
            if (url.startsWith('http') || url.startsWith('//')) return url;
            if (url.startsWith('/api/') && token) {
                return `${url}${url.includes('?') ? '&' : '?'}token=${token}`;
            }
            return url;
        };
        if (item.mediaStreamUrl) return withToken(item.mediaStreamUrl);
        if (item.media_stream_url) return withToken(item.media_stream_url);
        if (item.hash) return withToken(`/api/media/stream/${item.hash}`);
        return '';
    }

    private flatten(nodes: (TrackFolder | TrackItem)[]): TrackItem[] {
        const out: TrackItem[] = [];
        const walk = (items: (TrackFolder | TrackItem)[]) => {
            if (!Array.isArray(items)) return;
            for (const n of items) {
                if (n.type === 'folder') walk((n as TrackFolder).children || []);
                else out.push(n as TrackItem);
            }
        };
        walk(nodes);
        return out;
    }

    // ------------------------------------------------------------------
    // URL detection helpers
    // ------------------------------------------------------------------

    /**
     * Scrape DLsite sample images from the WorkMetadata gallery in the DOM.
     */
    private scrapeDlsiteGallery(add: (url: string) => void): void {
        const imgs = document.querySelectorAll('.asmr-meta-gallery img');
        for (const el of imgs) {
            const src = (el as HTMLImageElement).src;
            if (src) add(src);
        }
    }

    /**
     * Scrape the cover art URL from the DOM. This always works because
     * the Kikoeru player renders the cover as a background-image.
     */
    private scrapeCoverUrl(): string {
        // 1. q-img background-image (always rendered by Kikoeru)
        const qimg = document.querySelector('.audio-player .albumart .q-img__image') as HTMLElement;
        if (qimg) {
            const bg = qimg.style.backgroundImage;
            const m = bg.match(/url\(["']?([^"')]+)["']?\)/);
            if (m?.[1]) return m[1];
        }

        // 2. --cover-url CSS variable on .audio-player
        const player = document.querySelector('.audio-player') as HTMLElement;
        if (player) {
            const style = player.getAttribute('style') || '';
            const m = style.match(/--cover-url:\s*url\(["']?([^"')]+)["']?\)/);
            if (m?.[1]) return m[1];
        }

        // 3. AppStore
        try {
            const work = AppStore.currentWork;
            if (work?.mainCoverUrl) return work.mainCoverUrl;
        } catch { /* host store may not be ready */ }

        return '';
    }

    /**
     * Detect the current work ID from multiple sources.
     */
    private detectWorkId(): string | null {
        // 1. Vuex store
        try {
            const id = (AppStore.currentWork as any)?.id;
            if (id) return String(id);
        } catch { /* host store may not be ready */ }

        // 2. Cover URL contains numeric ID
        const cover = this.scrapeCoverUrl();
        const coverMatch = cover.match(/\/cover\/(\d+)/);
        if (coverMatch) return coverMatch[1];

        // 3. URL path
        const pathMatch = location.pathname.match(/\/work\/(?:RJ)?(\d+)/i);
        if (pathMatch) return pathMatch[1];

        return null;
    }

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------

    private get isFullscreen(): boolean {
        return this._isFullscreen;
    }

}
