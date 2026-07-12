import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    enabled: { __v_isRef: true, value: true },
    route: { __v_isRef: true, value: { path: '/works', query: {} as Record<string, unknown> } },
    axiosGet: vi.fn(),
    works: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../src/composables/useConfig', () => ({ useConfig: () => mocks.enabled }));
vi.mock('../../src/composables/useRoute', () => ({ useRoute: () => mocks.route }));
vi.mock('../../src/composables/useBridge', () => ({
    useBridge: () => ({
        axios: { get: mocks.axiosGet },
        store: { state: { Works: { list: mocks.works } } },
    }),
}));
vi.mock('../../src/composables/useI18n', () => ({
    useI18n: () => ({
        t: (key: string) => key,
        format: (key: string) => key,
    }),
}));
vi.mock('../../src/core/Utils', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import InfiniteScrollGrid from '../../src/features/components/InfiniteScrollGrid.vue';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
}

class FakeIntersectionObserver {
    observe = vi.fn();
    disconnect = vi.fn();
    unobserve = vi.fn();
    takeRecords = vi.fn(() => []);
    root = null;
    rootMargin = '';
    thresholds = [];
    constructor(_callback: IntersectionObserverCallback) {}
}

describe('InfiniteScrollGrid async lifecycle', () => {
    beforeEach(() => {
        mocks.enabled.value = true;
        mocks.route.value = { path: '/works', query: {} };
        mocks.works.splice(0);
        mocks.axiosGet.mockReset();
        document.body.innerHTML = `
            <div class="q-pagination">
                <button class="q-btn" aria-current="true">1</button>
                <button class="q-btn">2</button>
            </div>`;
        vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        document.body.innerHTML = '';
    });

    it('does not append a deferred page response after the component is unmounted', async () => {
        const prefetch = deferred<{ data: { works: Array<Record<string, unknown>> } }>();
        const visibleLoad = deferred<{ data: { works: Array<Record<string, unknown>> } }>();
        mocks.axiosGet
            .mockReturnValueOnce(prefetch.promise)
            .mockReturnValueOnce(visibleLoad.promise);

        const wrapper = mount(InfiniteScrollGrid, { attachTo: document.body });
        await nextTick();
        await vi.waitFor(() => expect(mocks.axiosGet).toHaveBeenCalledTimes(2));

        wrapper.unmount();
        prefetch.resolve({ data: { works: [{ id: 100 }] } });
        visibleLoad.resolve({ data: { works: [{ id: 200 }] } });
        await flushPromises();

        expect(mocks.works).toEqual([]);
    });
});
