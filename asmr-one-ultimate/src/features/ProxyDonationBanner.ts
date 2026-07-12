/**
 * ProxyDonationBanner — funding notice shown ONLY to users whose requests were
 * served through the region-bypass proxy worker.
 *
 * The proxy costs real money to run. This banner (same style/mechanics as the
 * yomu support banner) states the donation goal, warns that the proxy is
 * switched off if the goal is missed, notes the free alternative (VPN to
 * CN/JP), links the donation page, and plugs Yomu Reader. Users who reach the
 * site directly never see it; a dismissal is remembered for 7 days.
 */

import { GM_getValue, GM_setValue } from '$';
import { I18n } from '../core/Config';
import { Logger } from '../core/Utils';
import { escapeHtml } from '../core/DomUtils';
import { gmRequest } from '../infrastructure/HttpClient';
import { onProxyUse } from '../core/ProxyUsage';

const DONATE_URL = 'https://support.yomureader.com/donate';
const GOAL_URL = 'https://yomureader.com/support';
const YOMU_URL = 'https://yomureader.com/';
const DISMISS_KEY = 'asmr-ult:proxy-banner-dismissed-at';
const DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BANNER_ID = 'asmr-ultimate-proxy-banner';

interface SupportGoalPayload {
    donationGoalGbp?: number;
    donationsThisMonthGbp?: number;
    goalMet?: boolean;
    banner?: { costLabel?: string; goalLabel?: string };
}

export class ProxyDonationBanner {
    private banner: HTMLElement | null = null;
    private armed = false;
    private lifecycleGeneration = 0;
    private proxyCleanup: (() => void) | null = null;
    private positionCleanup: (() => void) | null = null;

    public enable(): void {
        if (this.armed) return;
        this.armed = true;
        this.proxyCleanup = onProxyUse(() => this.show());
    }

    public disable(): void {
        this.armed = false;
        this.lifecycleGeneration += 1;
        this.proxyCleanup?.();
        this.proxyCleanup = null;
        this.positionCleanup?.();
        this.positionCleanup = null;
        this.banner?.remove();
        this.banner = null;
    }

    private trackHeaderPosition(banner: HTMLElement): void {
        this.positionCleanup?.();

        let disposed = false;
        let updateQueued = false;
        let resizeObserver: ResizeObserver | null = null;
        const observedHeaders = new Set<HTMLElement>();

        const updateTop = () => {
            if (disposed) return;
            const headers = Array.from(document.querySelectorAll<HTMLElement>('.q-header'));
            const currentHeaders = new Set(headers);
            for (const previous of observedHeaders) {
                if (currentHeaders.has(previous)) continue;
                resizeObserver?.unobserve(previous);
                observedHeaders.delete(previous);
            }
            for (const header of headers) {
                if (observedHeaders.has(header)) continue;
                resizeObserver?.observe(header);
                observedHeaders.add(header);
            }

            const headerBottom = headers.reduce((bottom, header) => {
                const style = getComputedStyle(header);
                if (style.display === 'none' || style.visibility === 'hidden') return bottom;
                const rect = header.getBoundingClientRect();
                if (rect.height <= 0 || rect.bottom <= 0) return bottom;
                return Math.max(bottom, rect.bottom);
            }, 0);
            banner.style.top = `${Math.max(0, Math.ceil(headerBottom))}px`;
        };

        const queueUpdate = () => {
            if (disposed || updateQueued) return;
            updateQueued = true;
            queueMicrotask(() => {
                updateQueued = false;
                updateTop();
            });
        };

        resizeObserver = typeof ResizeObserver === 'function'
            ? new ResizeObserver(queueUpdate)
            : null;
        updateTop();
        window.addEventListener('resize', updateTop, { passive: true });
        window.addEventListener('scroll', updateTop, { passive: true });

        const layoutRoot = document.getElementById('q-app') || document.body;
        const mutationObserver = typeof MutationObserver === 'function'
            ? new MutationObserver(queueUpdate)
            : null;
        mutationObserver?.observe(layoutRoot, { childList: true, subtree: true });

        this.positionCleanup = () => {
            disposed = true;
            window.removeEventListener('resize', updateTop);
            window.removeEventListener('scroll', updateTop);
            mutationObserver?.disconnect();
            resizeObserver?.disconnect();
            observedHeaders.clear();
        };
    }

    private isDismissed(): boolean {
        const at = Number(GM_getValue(DISMISS_KEY, 0)) || 0;
        return Date.now() - at < DISMISS_TTL_MS;
    }

    private async loadGoalLabel(): Promise<string> {
        let goalLabel = '';
        try {
            const res = await gmRequest({
                url: GOAL_URL,
                responseType: 'text',
                timeout: 10_000,
            });
            const raw = res.responseText || (typeof res.response === 'string' ? res.response : '');
            let goal: SupportGoalPayload | null = null;
            try {
                goal = JSON.parse(raw) as SupportGoalPayload;
            } catch {
                const match = raw.match(/<strong[^>]*>\s*(£[^<]+(?:floor)?)\s*<\/strong>/i);
                if (match) goalLabel = match[1].replace(/\s+/g, ' ').trim();
            }
            if (goal?.banner?.goalLabel) {
                goalLabel = goal.banner.goalLabel;
            } else if (typeof goal?.donationGoalGbp === 'number') {
                goalLabel = `£${goal.donationsThisMonthGbp ?? 0} / £${goal.donationGoalGbp}`;
            }
        } catch (error) {
            Logger.debug('[ProxyBanner] Could not load donation goal', error);
        }
        return goalLabel;
    }

    private show(): void {
        if (this.banner?.isConnected || this.isDismissed()) return;
        if (document.getElementById(BANNER_ID)) return;
        const generation = this.lifecycleGeneration;

        const t = (key: string) => I18n.t(key);
        const safeT = (key: string) => escapeHtml(t(key));
        const banner = document.createElement('div');
        banner.id = BANNER_ID;
        banner.setAttribute('role', 'status');
        banner.setAttribute('aria-live', 'polite');
        banner.setAttribute('aria-label', t('proxyBannerTitle'));
        banner.style.cssText = [
            'position:fixed', 'left:0', 'right:0', 'top:0',
            'z-index:9999', 'width:100%', 'box-sizing:border-box',
            'background:linear-gradient(135deg,#1b1b2b,#242438)', 'color:#f4f4f8',
            'border-top:1px solid rgba(255,255,255,0.18)',
            'border-bottom:1px solid rgba(255,255,255,0.18)',
            'padding:12px max(16px,env(safe-area-inset-right)) 12px max(16px,env(safe-area-inset-left))',
            'box-shadow:0 6px 24px rgba(0,0,0,0.48)',
            'font-size:14px', 'line-height:1.5',
        ].join(';');

        banner.innerHTML = `
            <div data-testid="proxy-banner-content" style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;max-width:1200px;margin:0 auto">
                <div style="flex:1;min-width:min(100%,260px)">
                    <div style="font-size:15px;font-weight:700;margin-bottom:2px">${safeT('proxyBannerTitle')}</div>
                    <div>${safeT('proxyBannerMsg')} <span data-testid="proxy-banner-goal" style="opacity:.9" hidden></span></div>
                    <div style="opacity:.9;margin-top:3px">${safeT('proxyBannerVpn')}</div>
                    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:8px">
                        <a href="${DONATE_URL}" target="_blank" rel="noopener noreferrer" data-testid="proxy-banner-donate"
                           style="display:inline-block;background:#7c6cf0;color:#fff;text-decoration:none;padding:7px 16px;border-radius:8px;font-weight:700">${safeT('proxyBannerDonate')}</a>
                        <a href="${YOMU_URL}" target="_blank" rel="noopener noreferrer" data-testid="proxy-banner-yomu"
                           style="display:inline-block;color:#d2ccff;text-decoration:underline;font-weight:600">${safeT('proxyBannerYomuAd')}</a>
                    </div>
                </div>
                <button type="button" data-testid="proxy-banner-dismiss" aria-label="${escapeHtml(t('cancel') || 'Close')}"
                        style="align-self:flex-start;background:none;border:1px solid rgba(255,255,255,.25);border-radius:50%;color:#f4f4f8;cursor:pointer;font-size:16px;line-height:1;padding:5px">✕</button>
            </div>`;

        banner.querySelector('[data-testid="proxy-banner-dismiss"]')?.addEventListener('click', () => {
            try { GM_setValue(DISMISS_KEY, Date.now()); } catch { /* storage optional */ }
            this.positionCleanup?.();
            this.positionCleanup = null;
            banner.remove();
            if (this.banner === banner) this.banner = null;
        });

        this.trackHeaderPosition(banner);
        document.body.appendChild(banner);
        this.banner = banner;
        Logger.info('[ProxyBanner] Shown (proxy in use)');

        // The funding goal is optional metadata. Never delay the primary
        // notice or its links while a cross-site request is slow/unavailable.
        void this.loadGoalLabel().then((goalLabel) => {
            if (
                !goalLabel ||
                !this.armed ||
                generation !== this.lifecycleGeneration ||
                this.banner !== banner ||
                !banner.isConnected ||
                this.isDismissed()
            ) return;
            const goal = banner.querySelector<HTMLElement>('[data-testid="proxy-banner-goal"]');
            if (!goal) return;
            goal.textContent = `${t('proxyBannerGoal')} ${goalLabel}`;
            goal.hidden = false;
        });
    }
}
