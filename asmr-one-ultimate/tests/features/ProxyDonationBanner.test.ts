import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    gmGetValue: vi.fn(),
    gmSetValue: vi.fn(),
    gmRequest: vi.fn(),
    proxyListener: null as (() => void) | null,
    proxyCleanup: vi.fn(),
    proxyAlreadyUsed: false,
}));

vi.mock('$', () => ({
    GM_getValue: mocks.gmGetValue,
    GM_setValue: mocks.gmSetValue,
}));

vi.mock('../../src/infrastructure/HttpClient', () => ({
    gmRequest: mocks.gmRequest,
}));

vi.mock('../../src/core/ProxyUsage', () => ({
    onProxyUse: vi.fn((listener: () => void) => {
        mocks.proxyListener = listener;
        if (mocks.proxyAlreadyUsed) listener();
        return mocks.proxyCleanup;
    }),
}));

import { ProxyDonationBanner } from '../../src/features/ProxyDonationBanner';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const activeBanners: ProxyDonationBanner[] = [];
const createBanner = () => {
    const banner = new ProxyDonationBanner();
    activeBanners.push(banner);
    return banner;
};

describe('ProxyDonationBanner', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        mocks.gmGetValue.mockReset().mockReturnValue(0);
        mocks.gmSetValue.mockReset();
        mocks.gmRequest.mockReset().mockResolvedValue({
            responseText: '<h2 id="service-budget">Service Budget</h2><p>Current <strong>£10/month floor</strong>.</p>',
        });
        mocks.proxyListener = null;
        mocks.proxyAlreadyUsed = false;
        mocks.proxyCleanup.mockReset();
    });

    afterEach(() => {
        activeBanners.splice(0).forEach(banner => banner.disable());
    });

    it('shows only after proxy use and renders the live support goal and safe links', async () => {
        const banner = createBanner();
        banner.enable();
        expect(document.getElementById('asmr-ultimate-proxy-banner')).toBeNull();

        mocks.proxyListener?.();
        await flush();

        const element = document.getElementById('asmr-ultimate-proxy-banner');
        expect(element?.textContent).toContain('£10/month floor');
        const donate = element?.querySelector<HTMLAnchorElement>('[data-testid="proxy-banner-donate"]');
        const yomu = element?.querySelector<HTMLAnchorElement>('[data-testid="proxy-banner-yomu"]');
        expect(donate?.href).toBe('https://support.yomureader.com/donate');
        expect(yomu?.href).toBe('https://yomureader.com/');
        expect(donate?.rel).toContain('noopener');
        expect(yomu?.rel).toContain('noreferrer');
    });

    it('renders immediately and hydrates the optional goal without blocking the notice', async () => {
        let resolveRequest!: (value: { responseText: string }) => void;
        mocks.gmRequest.mockReturnValue(new Promise(resolve => { resolveRequest = resolve; }));
        const banner = createBanner();
        banner.enable();

        mocks.proxyListener?.();

        const element = document.getElementById('asmr-ultimate-proxy-banner');
        expect(element).not.toBeNull();
        expect(element?.querySelector<HTMLElement>('[data-testid="proxy-banner-goal"]')?.hidden).toBe(true);

        resolveRequest({ responseText: '<strong>£10/month floor</strong>' });
        await flush();

        const goal = element?.querySelector<HTMLElement>('[data-testid="proxy-banner-goal"]');
        expect(goal?.hidden).toBe(false);
        expect(goal?.textContent).toContain('£10/month floor');
    });

    it('shows for a late subscriber when proxy use was recorded before enable', () => {
        mocks.proxyAlreadyUsed = true;
        const banner = createBanner();

        banner.enable();

        expect(document.getElementById('asmr-ultimate-proxy-banner')).not.toBeNull();
        expect(mocks.gmRequest).toHaveBeenCalledOnce();
    });

    it('spans the top of the viewport immediately below the visible host header', async () => {
        const header = document.createElement('header');
        header.className = 'q-header';
        header.getBoundingClientRect = vi.fn(() => ({
            x: 0,
            y: 0,
            top: 0,
            right: 1200,
            bottom: 64,
            left: 0,
            width: 1200,
            height: 64,
            toJSON: () => ({}),
        }));
        document.body.appendChild(header);

        const banner = createBanner();
        banner.enable();
        mocks.proxyListener?.();
        await flush();

        const element = document.getElementById('asmr-ultimate-proxy-banner') as HTMLElement;
        const content = element.querySelector<HTMLElement>('[data-testid="proxy-banner-content"]');
        expect(element.style.position).toBe('fixed');
        expect(element.style.top).toBe('64px');
        expect(element.style.left).toBe('0px');
        expect(element.style.right).toBe('0px');
        expect(element.style.width).toBe('100%');
        expect(element.style.bottom).toBe('');
        expect(element.style.maxWidth).toBe('');
        expect(element.style.transform).toBe('');
        expect(content?.style.flexWrap).toBe('wrap');

        header.getBoundingClientRect = vi.fn(() => ({
            x: 0,
            y: 0,
            top: 0,
            right: 1200,
            bottom: 72,
            left: 0,
            width: 1200,
            height: 72,
            toJSON: () => ({}),
        }));
        window.dispatchEvent(new Event('resize'));
        expect(element.style.top).toBe('72px');

        banner.disable();
    });

    it('rediscovers and observes a host header replaced during a route re-render', async () => {
        const qApp = document.createElement('div');
        qApp.id = 'q-app';
        const firstHeader = document.createElement('header');
        firstHeader.className = 'q-header';
        const firstHeaderRect = vi.fn(() => ({
            x: 0, y: 0, top: 0, right: 1200, bottom: 56, left: 0,
            width: 1200, height: 56, toJSON: () => ({}),
        }));
        firstHeader.getBoundingClientRect = firstHeaderRect;
        qApp.appendChild(firstHeader);
        document.body.appendChild(qApp);

        const banner = createBanner();
        banner.enable();
        mocks.proxyListener?.();
        await flush();

        const element = document.getElementById('asmr-ultimate-proxy-banner') as HTMLElement;
        expect(element.style.top).toBe('56px');
        const firstHeaderCallsBeforeReplacement = firstHeaderRect.mock.calls.length;

        const replacementHeader = document.createElement('header');
        replacementHeader.className = 'q-header';
        const replacementHeaderRect = vi.fn(() => ({
            x: 0, y: 0, top: 0, right: 1200, bottom: 80, left: 0,
            width: 1200, height: 80, toJSON: () => ({}),
        }));
        replacementHeader.getBoundingClientRect = replacementHeaderRect;
        firstHeader.replaceWith(replacementHeader);
        await flush();

        expect(element.style.top).toBe('80px');
        expect(firstHeaderRect).toHaveBeenCalledTimes(firstHeaderCallsBeforeReplacement);
        expect(replacementHeaderRect).toHaveBeenCalled();

        banner.disable();
    });

    it('sits above host dialogs and reader-extension overlays', async () => {
        const banner = createBanner();
        banner.enable();
        mocks.proxyListener?.();
        await flush();

        const element = document.getElementById('asmr-ultimate-proxy-banner') as HTMLElement;
        const style = document.getElementById('asmr-ultimate-proxy-banner-style');
        expect(Number(element.style.zIndex)).toBeGreaterThan(1_000_000);
        // Quasar dialogs sit near 7000 and reader extensions stack their own
        // overlays on top; an invisible funding notice is no notice at all.
        expect(style?.textContent).toContain('z-index: 2147483000 !important');
        expect(style?.textContent).toContain('visibility: visible !important');

        banner.disable();
        expect(document.getElementById('asmr-ultimate-proxy-banner-style')).toBeNull();
    });

    it('reattaches itself when a host re-render detaches it', async () => {
        const qApp = document.createElement('div');
        qApp.id = 'q-app';
        document.body.appendChild(qApp);
        const banner = createBanner();
        banner.enable();
        mocks.proxyListener?.();
        await flush();

        const element = document.getElementById('asmr-ultimate-proxy-banner') as HTMLElement;
        expect(element).not.toBeNull();

        // A router transition, a layout swap or an extension rewriting the
        // document can drop a body-level node. Without repair it is gone for
        // the whole session.
        element.remove();
        expect(document.getElementById('asmr-ultimate-proxy-banner')).toBeNull();

        window.dispatchEvent(new Event('resize'));
        expect(document.getElementById('asmr-ultimate-proxy-banner')).toBe(element);

        banner.disable();
    });

    it('never resurrects a banner the user dismissed', async () => {
        const banner = createBanner();
        banner.enable();
        mocks.proxyListener?.();
        await flush();

        document.querySelector<HTMLButtonElement>('[data-testid="proxy-banner-dismiss"]')?.click();
        expect(document.getElementById('asmr-ultimate-proxy-banner')).toBeNull();

        window.dispatchEvent(new Event('resize'));
        await flush();
        mocks.proxyListener?.();
        await flush();

        expect(document.getElementById('asmr-ultimate-proxy-banner')).toBeNull();
    });

    it('stays dismissible after a reader extension annotates its text', async () => {
        const banner = createBanner();
        banner.enable();
        mocks.proxyListener?.();
        await flush();

        const element = document.getElementById('asmr-ultimate-proxy-banner') as HTMLElement;
        // Yomu / jpdb wrap CJK text nodes in their own elements. The controls
        // must keep working because handlers are bound to elements, not text.
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const textNodes: Text[] = [];
        while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
        for (const node of textNodes) {
            if (!node.data.trim()) continue;
            const wrapper = document.createElement('span');
            wrapper.className = 'yomu-word';
            wrapper.textContent = node.data;
            node.replaceWith(wrapper);
        }

        const donate = element.querySelector<HTMLAnchorElement>('[data-testid="proxy-banner-donate"]');
        expect(donate?.href).toBe('https://support.yomureader.com/donate');

        element.querySelector<HTMLButtonElement>('[data-testid="proxy-banner-dismiss"]')?.click();
        expect(mocks.gmSetValue).toHaveBeenCalledWith(
            'asmr-ult:proxy-banner-dismissed-at',
            expect.any(Number),
        );
        expect(document.getElementById('asmr-ultimate-proxy-banner')).toBeNull();
    });

    it('remembers dismissal for seven days', async () => {
        const banner = createBanner();
        banner.enable();
        mocks.proxyListener?.();
        await flush();

        document.querySelector<HTMLButtonElement>('[data-testid="proxy-banner-dismiss"]')?.click();
        expect(mocks.gmSetValue).toHaveBeenCalledWith(
            'asmr-ult:proxy-banner-dismissed-at',
            expect.any(Number),
        );
        expect(document.getElementById('asmr-ultimate-proxy-banner')).toBeNull();
    });

    it('unsubscribes and cannot append after disable during goal loading', async () => {
        let resolveRequest!: (value: { responseText: string }) => void;
        mocks.gmRequest.mockReturnValue(new Promise(resolve => { resolveRequest = resolve; }));
        const banner = createBanner();
        banner.enable();
        mocks.proxyListener?.();
        banner.disable();
        resolveRequest({ responseText: '<strong>£10/month floor</strong>' });
        await flush();

        expect(mocks.proxyCleanup).toHaveBeenCalledOnce();
        expect(document.getElementById('asmr-ultimate-proxy-banner')).toBeNull();
    });

    it('coalesces duplicate proxy-use signals while the goal request is in flight', async () => {
        let resolveRequest!: (value: { responseText: string }) => void;
        mocks.gmRequest.mockReturnValue(new Promise(resolve => { resolveRequest = resolve; }));
        const banner = createBanner();
        banner.enable();

        mocks.proxyListener?.();
        mocks.proxyListener?.();
        expect(mocks.gmRequest).toHaveBeenCalledOnce();

        resolveRequest({ responseText: '<strong>£10/month floor</strong>' });
        await flush();

        expect(document.querySelectorAll('#asmr-ultimate-proxy-banner')).toHaveLength(1);
    });
});
