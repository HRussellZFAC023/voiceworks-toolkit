import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    parse: vi.fn(),
}));

vi.mock('../../src/core/CentralObserver', () => ({
    CentralObserver: {
        register: vi.fn(),
        unregister: vi.fn(),
        withModification: (callback: () => void) => callback(),
    },
}));

vi.mock('../../src/core/EventBus', () => ({
    EventBus: { on: vi.fn(() => () => {}) },
}));

vi.mock('../../src/store/AppStore', () => ({
    AppStore: { getConfig: vi.fn(() => true) },
}));

vi.mock('../../src/services/JpdbService', () => ({
    JpdbService: { parse: mocks.parse },
}));

vi.mock('../../src/core/Logger', () => ({
    Logger: { debug: vi.fn(), error: vi.fn() },
}));

import { FuriganaRenderer } from '../../src/features/FuriganaRenderer';

class FakeIntersectionObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
    takeRecords = vi.fn(() => []);
    root = null;
    rootMargin = '';
    thresholds = [];
    constructor(_callback: IntersectionObserverCallback) {}
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
}

describe('FuriganaRenderer lifecycle', () => {
    beforeEach(() => {
        document.body.innerHTML = '<h1 id="target">漢字</h1>';
        mocks.parse.mockReset();
        vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    });

    it('does not apply a late JPDB parse across disable and re-enable', async () => {
        const parsed = deferred<{ tokens: any[][] }>();
        mocks.parse.mockReturnValueOnce(parsed.promise);
        const renderer = new FuriganaRenderer();
        renderer.enable();
        const target = document.getElementById('target') as HTMLElement;
        (renderer as any).pendingElements.add(target);
        const processing = (renderer as any).processVisible();

        renderer.disable();
        renderer.enable();
        parsed.resolve({
            tokens: [[{
                start: 0,
                end: 2,
                length: 2,
                rubies: [{ text: 'かんじ', start: 0, end: 2, length: 2 }],
                pitchClass: '',
                card: { vid: 1, sid: 1, cardState: [] },
            }]],
        });
        await processing;

        expect(target.hasAttribute('data-jpdb')).toBe(false);
        expect(target.querySelector('ruby')).toBeNull();
        expect(target.textContent).toBe('漢字');
        renderer.disable();
    });
});
