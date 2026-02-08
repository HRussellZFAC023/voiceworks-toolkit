/**
 * VisitCounter - Tracks and displays how many times each work has been opened
 *
 * Shows a small badge on work cards indicating the visit count.
 * Persists counts in GM storage across sessions.
 */

import { GM_getValue, GM_setValue } from '$';
import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { CentralObserver } from '../core/CentralObserver';
import { Logger } from '../core/Utils';

const STORAGE_KEY = 'asmr-ult:visitCounts';

export class VisitCounter {
    private bridge: KikoeruBridge;
    private counts: Record<string, number> = {};
    private routeUnwatch: (() => void) | undefined;

    constructor() {
        this.bridge = KikoeruBridge.getInstance();
        this.loadCounts();
    }

    public enable(): void {
        // Watch route changes to track visits
        this.routeUnwatch = this.bridge.$watch?.('$route', (to: { path?: string }) => {
            this.onRouteChange(to);
        });

        // Check current route on enable
        const route = this.bridge.route;
        if (route?.path?.startsWith('/work/')) {
            this.recordVisit(route.path);
        }

        // Register with CentralObserver to inject badges on DOM changes
        CentralObserver.register('visit-counter', () => this.injectBadges(), 500);

        // Initial injection
        this.injectBadges();
    }

    public disable(): void {
        this.routeUnwatch?.();
        CentralObserver.unregister('visit-counter');
    }

    private loadCounts(): void {
        try {
            const raw = GM_getValue(STORAGE_KEY, '{}');
            this.counts = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
        } catch {
            this.counts = {};
        }
    }

    private saveCounts(): void {
        GM_setValue(STORAGE_KEY, JSON.stringify(this.counts));
    }

    private onRouteChange(to: { path?: string }): void {
        const path = to?.path || '';
        if (path.startsWith('/work/')) {
            this.recordVisit(path);
        }
    }

    private recordVisit(path: string): void {
        const workId = this.extractWorkId(path);
        if (!workId) return;

        this.counts[workId] = (this.counts[workId] || 0) + 1;
        this.saveCounts();
        Logger.debug(`[VisitCounter] Recorded visit #${this.counts[workId]} for ${workId}`);
    }

    private extractWorkId(str: string): string | null {
        const match = str.match(/\/work\/(?:RJ)?(\d+)/i);
        return match?.[1] || null;
    }

    private injectBadges(): void {
        // Find all work card cover links
        const links = document.querySelectorAll<HTMLAnchorElement>(
            '.q-card a[href*="/work/"], a[href*="/work/"] .q-img'
        );

        const processed = new Set<Element>();

        CentralObserver.withModification(() => {
            for (const el of links) {
                // Find the .q-img__content overlay container
                const anchor = el.tagName === 'A' ? el : el.closest('a');
                if (!anchor) continue;

                const href = anchor.getAttribute('href') || '';
                const workId = this.extractWorkId(href);
                if (!workId) continue;

                const count = this.counts[workId];
                if (!count || count < 1) continue;

                // Find the image overlay
                const card = anchor.closest('.q-card') || anchor.closest('[class*="col-"]');
                if (!card || processed.has(card)) continue;
                processed.add(card);

                const overlay = card.querySelector('.q-img__content');
                if (!overlay) continue;

                // Skip if badge already exists
                if (overlay.querySelector('.asmr-visit-badge')) {
                    // Update count if changed
                    const existing = overlay.querySelector('.asmr-visit-count');
                    if (existing && existing.textContent !== String(count)) {
                        existing.textContent = String(count);
                    }
                    continue;
                }

                const badge = document.createElement('div');
                badge.className = 'absolute-top-right asmr-visit-badge';

                const chip = document.createElement('div');
                chip.className = 'q-chip row inline no-wrap items-center q-ma-sm bg-deep-purple text-white q-chip--colored q-chip--dense q-chip--square q-chip--dark q-dark';

                chip.innerHTML =
                    '<div class="q-chip__content col row no-wrap items-center q-anchor--skip">' +
                    '<i class="q-icon material-icons" style="font-size:14px;margin-right:2px">visibility</i>' +
                    '<span class="asmr-visit-count">' + count + '</span>' +
                    '</div>';

                badge.appendChild(chip);
                overlay.appendChild(badge);
            }
        });
    }
}
