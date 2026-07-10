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
import { HttpClient } from '../infrastructure/HttpClient';
import { onProxyUse } from './playlist/PlaylistService';

const DONATE_URL = 'https://support.yomureader.com/donate';
const GOAL_URL = 'https://support.yomureader.com/goal';
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

    public enable(): void {
        if (this.armed) return;
        this.armed = true;
        onProxyUse(() => this.show());
    }

    public disable(): void {
        this.banner?.remove();
        this.banner = null;
    }

    private isDismissed(): boolean {
        const at = Number(GM_getValue(DISMISS_KEY, 0)) || 0;
        return Date.now() - at < DISMISS_TTL_MS;
    }

    private async show(): Promise<void> {
        if (this.banner?.isConnected || this.isDismissed()) return;
        if (document.getElementById(BANNER_ID)) return;

        let goalLabel = '';
        try {
            const res = await HttpClient.getJsonViaCors<SupportGoalPayload>(GOAL_URL, {
                retry: { attempts: 1, backoffMs: 500 },
            });
            const goal = res.data;
            if (goal?.banner?.goalLabel) {
                goalLabel = goal.banner.goalLabel;
            } else if (typeof goal?.donationGoalGbp === 'number') {
                goalLabel = `£${goal.donationsThisMonthGbp ?? 0} / £${goal.donationGoalGbp}`;
            }
        } catch (error) {
            Logger.debug('[ProxyBanner] Could not load donation goal', error);
        }

        const t = (key: string) => I18n.t(key);
        const banner = document.createElement('div');
        banner.id = BANNER_ID;
        banner.setAttribute('role', 'status');
        banner.style.cssText = [
            'position:fixed', 'left:50%', 'bottom:12px', 'transform:translateX(-50%)',
            'z-index:9999', 'max-width:680px', 'width:calc(100% - 24px)',
            'background:linear-gradient(135deg,#1b1b2b,#242438)', 'color:#f4f4f8',
            'border:1px solid rgba(255,255,255,0.14)', 'border-radius:12px',
            'padding:12px 16px', 'box-shadow:0 8px 28px rgba(0,0,0,0.45)',
            'font-size:13px', 'line-height:1.5',
        ].join(';');

        const goalLine = goalLabel ? `<span style="opacity:.85">${t('proxyBannerGoal')} ${goalLabel}</span>` : '';
        banner.innerHTML = `
            <div style="display:flex;gap:12px;align-items:flex-start">
                <div style="flex:1">
                    <div style="font-weight:600;margin-bottom:2px">${t('proxyBannerTitle')}</div>
                    <div>${t('proxyBannerMsg')} ${goalLine}</div>
                    <div style="opacity:.8;margin-top:4px">${t('proxyBannerVpn')}</div>
                    <div style="margin-top:6px">
                        <a href="${DONATE_URL}" target="_blank" rel="noopener noreferrer" data-testid="proxy-banner-donate"
                           style="display:inline-block;background:#7c6cf0;color:#fff;text-decoration:none;padding:5px 14px;border-radius:8px;font-weight:600">${t('proxyBannerDonate')}</a>
                        <a href="${YOMU_URL}" target="_blank" rel="noopener noreferrer" data-testid="proxy-banner-yomu"
                           style="display:inline-block;margin-left:10px;color:#b9b0ff;text-decoration:underline">${t('proxyBannerYomuAd')}</a>
                    </div>
                </div>
                <button type="button" data-testid="proxy-banner-dismiss" aria-label="Dismiss"
                        style="background:none;border:none;color:#f4f4f8;cursor:pointer;font-size:16px;line-height:1;padding:2px">✕</button>
            </div>`;

        banner.querySelector('[data-testid="proxy-banner-dismiss"]')?.addEventListener('click', () => {
            try { GM_setValue(DISMISS_KEY, Date.now()); } catch { /* storage optional */ }
            banner.remove();
        });

        document.body.appendChild(banner);
        this.banner = banner;
        Logger.info('[ProxyBanner] Shown (proxy in use)');
    }
}
