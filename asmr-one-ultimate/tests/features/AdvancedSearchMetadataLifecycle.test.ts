import { flushPromises, mount } from '@vue/test-utils';
import { nextTick, type DefineComponent } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface LabelFetchResult<T> {
    items: T[];
    error: Error | null;
    fromCache: boolean;
}

const ok = <T>(items: T[]): LabelFetchResult<T> => ({ items, error: null, fromCache: false });
const failed = <T>(error: Error): LabelFetchResult<T> => ({ items: [], error, fromCache: false });

const mocks = vi.hoisted(() => ({
    fetchTagList: vi.fn(),
    fetchVAList: vi.fn(),
    fetchCircleList: vi.fn(),
    clearCache: vi.fn(),
    hostTagList: vi.fn(() => [] as Array<{ id: number; name: string; ja: string; en: string; count: number }>),
}));

vi.mock('../../src/composables/useBridge', () => ({
    useBridge: () => ({
        findComponent: vi.fn(() => null),
        router: { push: vi.fn(async () => undefined) },
    }),
}));
vi.mock('../../src/composables/useI18n', async () => {
    const { ref } = await import('vue');
    const lang = ref('en');
    return {
        useI18n: () => ({
            t: (key: string) => key,
            format: (key: string) => key,
            lang,
        }),
    };
});
vi.mock('../../src/composables/useEventBus', () => ({
    useEventBus: () => ({ emit: vi.fn(), on: vi.fn(), once: vi.fn() }),
}));
vi.mock('../../src/api', () => ({
    MetadataApi: {
        fetchTagList: mocks.fetchTagList,
        fetchVAList: mocks.fetchVAList,
        fetchCircleList: mocks.fetchCircleList,
        clearCache: mocks.clearCache,
    },
    PlaylistApi: { createPlaylist: vi.fn() },
    HistoryApi: { getRecent: vi.fn(async () => []) },
}));
vi.mock('../../src/api/Client', () => ({ getAxios: () => ({ get: vi.fn() }) }));
vi.mock('../../src/features/TranslatedTags', () => ({
    TranslatedTags: { getInstance: () => ({ getTagList: mocks.hostTagList }) },
}));
vi.mock('../../src/services/TranslationService', () => ({
    TranslationService: {
        getUiTargetLang: () => 'en',
        translate: vi.fn(async (text: string) => text),
    },
}));
vi.mock('../../src/store/AppStore', () => ({
    AppStore: { state: { search: {} }, setSearchState: vi.fn() },
}));
vi.mock('../../src/features/RouteStateSync', () => ({
    RouteStateSync: { getInstance: () => ({ syncDisplayToHost: vi.fn(), getSortLabel: vi.fn(() => '') }) },
}));
vi.mock('../../src/features/radio', () => ({ RadioMode: { getInstance: () => null } }));
vi.mock('../../src/core/GpuScheduler', () => ({ Priority: { LOW: 2 } }));
vi.mock('../../src/core/Utils', () => ({
    Logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    I18n: {
        lang: 'en',
        t: (key: string) => key,
        format: (key: string) => key,
        syncFromHost: vi.fn(),
    },
}));

import AdvancedSearchDialog from '../../src/features/components/AdvancedSearchDialog.vue';

const TypedAdvancedSearchDialog = AdvancedSearchDialog as DefineComponent<{ visible: boolean }>;

function mountDialog() {
    return mount(TypedAdvancedSearchDialog, {
        attachTo: document.body,
        props: { visible: false },
    });
}

/** Text of every "loading ..." placeholder the dialog can show. */
const LOADING_KEYS = ['advLoadingTags', 'advLoadingVA', 'advLoadingCircles'];

function expectNotLoading(): void {
    for (const key of LOADING_KEYS) {
        expect(document.body.textContent).not.toContain(key);
    }
}

describe('AdvancedSearchDialog metadata lifecycle', () => {
    beforeEach(() => {
        mocks.clearCache.mockReset();
        mocks.hostTagList.mockReset().mockReturnValue([]);
        mocks.fetchTagList.mockReset()
            .mockResolvedValueOnce(ok([]))
            .mockResolvedValue(ok([{ id: 1, name: 'Whisper', count: 3 }]));
        mocks.fetchVAList.mockReset()
            .mockResolvedValueOnce(ok([]))
            .mockResolvedValue(ok([{ id: 2, name: 'Test VA', count: 2 }]));
        mocks.fetchCircleList.mockReset()
            .mockResolvedValueOnce(ok([]))
            .mockResolvedValue(ok([{ id: 3, name: 'Test Circle', count: 1 }]));
    });

    afterEach(() => {
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    it('defers hidden loading and retries empty metadata when reopened', async () => {
        const wrapper = mountDialog();
        await flushPromises();
        expect(mocks.fetchTagList).not.toHaveBeenCalled();
        expect(mocks.fetchVAList).not.toHaveBeenCalled();
        expect(mocks.fetchCircleList).not.toHaveBeenCalled();

        await wrapper.setProps({ visible: true });
        await flushPromises();
        expect(mocks.fetchTagList).toHaveBeenCalledTimes(1);
        expect(document.body.textContent).toContain('advNoResults');
        expectNotLoading();

        await wrapper.setProps({ visible: false });
        await wrapper.setProps({ visible: true });
        await flushPromises();
        expect(mocks.fetchTagList).toHaveBeenCalledTimes(2);
        expect(mocks.fetchVAList).toHaveBeenCalledTimes(2);
        expect(mocks.fetchCircleList).toHaveBeenCalledTimes(2);
        expect(document.body.textContent).toContain('Whisper');
        expect(document.body.textContent).toContain('Test VA');
        expect(document.body.textContent).toContain('Test Circle');

        wrapper.unmount();
    });

    it('retries when only one metadata endpoint was transiently empty', async () => {
        mocks.fetchTagList.mockReset()
            .mockResolvedValueOnce(ok([]))
            .mockResolvedValue(ok([{ id: 1, name: 'Recovered tag', count: 1 }]));
        mocks.fetchVAList.mockReset().mockResolvedValue(ok([{ id: 2, name: 'Stable VA', count: 1 }]));
        mocks.fetchCircleList.mockReset().mockResolvedValue(ok([{ id: 3, name: 'Stable Circle', count: 1 }]));

        const wrapper = mountDialog();
        await wrapper.setProps({ visible: true });
        await flushPromises();
        expect(document.body.textContent).not.toContain('Recovered tag');
        expect(document.body.textContent).toContain('Stable VA');

        await wrapper.setProps({ visible: false });
        await wrapper.setProps({ visible: true });
        await flushPromises();

        expect(mocks.fetchTagList).toHaveBeenCalledTimes(2);
        expect(document.body.textContent).toContain('Recovered tag');
        wrapper.unmount();
    });

    // -----------------------------------------------------------------------
    // Regression: the loading flag must clear on EVERY terminal outcome.
    // -----------------------------------------------------------------------

    it('clears the loading state when every request fails', async () => {
        const boom = new Error('Network error');
        mocks.fetchTagList.mockReset().mockResolvedValue(failed(boom));
        mocks.fetchVAList.mockReset().mockResolvedValue(failed(boom));
        mocks.fetchCircleList.mockReset().mockResolvedValue(failed(boom));

        const wrapper = mountDialog();
        await wrapper.setProps({ visible: true });
        await flushPromises();

        expectNotLoading();
        expect(document.body.textContent).toContain('advMetadataFailed');
        expect(document.querySelector('.asmr-metadata-error')).not.toBeNull();
        wrapper.unmount();
    });

    it('clears the loading state when a single request fails', async () => {
        mocks.fetchTagList.mockReset().mockResolvedValue(ok([{ id: 1, name: 'Whisper', count: 1 }]));
        mocks.fetchVAList.mockReset().mockResolvedValue(failed(new Error('vas exploded')));
        mocks.fetchCircleList.mockReset().mockResolvedValue(ok([{ id: 3, name: 'Circle', count: 1 }]));

        const wrapper = mountDialog();
        await wrapper.setProps({ visible: true });
        await flushPromises();

        expectNotLoading();
        expect(document.body.textContent).toContain('advMetadataFailed');
        // Data that did arrive is still bound.
        expect(document.body.textContent).toContain('Whisper');
        wrapper.unmount();
    });

    it('clears the loading state when every request returns empty', async () => {
        mocks.fetchTagList.mockReset().mockResolvedValue(ok([]));
        mocks.fetchVAList.mockReset().mockResolvedValue(ok([]));
        mocks.fetchCircleList.mockReset().mockResolvedValue(ok([]));

        const wrapper = mountDialog();
        await wrapper.setProps({ visible: true });
        await flushPromises();

        expectNotLoading();
        // Empty is not an error: no retry banner, just "no results".
        expect(document.body.textContent).toContain('advNoResults');
        expect(document.querySelector('.asmr-metadata-error')).toBeNull();
        wrapper.unmount();
    });

    it('clears the loading state when a request rejects outright', async () => {
        mocks.fetchTagList.mockReset().mockRejectedValue(new Error('unhandled'));
        mocks.fetchVAList.mockReset().mockResolvedValue(ok([]));
        mocks.fetchCircleList.mockReset().mockResolvedValue(ok([]));

        const wrapper = mountDialog();
        await wrapper.setProps({ visible: true });
        await flushPromises();

        expectNotLoading();
        expect(document.body.textContent).toContain('advMetadataFailed');
        wrapper.unmount();
    });

    it('clears the loading state when a request never settles (watchdog)', async () => {
        vi.useFakeTimers();
        mocks.fetchTagList.mockReset().mockReturnValue(new Promise(() => { /* never settles */ }));
        mocks.fetchVAList.mockReset().mockResolvedValue(ok([]));
        mocks.fetchCircleList.mockReset().mockResolvedValue(ok([]));

        const wrapper = mountDialog();
        await wrapper.setProps({ visible: true });
        await vi.advanceTimersByTimeAsync(0);
        // Before the watchdog fires the dialog legitimately shows the spinner text.
        expect(document.body.textContent).toContain('advLoadingTags');

        await vi.advanceTimersByTimeAsync(30000);
        await nextTick();

        expectNotLoading();
        expect(document.body.textContent).toContain('advMetadataFailed');
        wrapper.unmount();
    });

    // -----------------------------------------------------------------------
    // Regression: error must be retryable, and reopening must retry.
    // -----------------------------------------------------------------------

    it('recovers through the retry button after a failure', async () => {
        mocks.fetchTagList.mockReset()
            .mockResolvedValueOnce(failed(new Error('down')))
            .mockResolvedValue(ok([{ id: 1, name: 'Whisper', count: 1 }]));
        mocks.fetchVAList.mockReset()
            .mockResolvedValueOnce(failed(new Error('down')))
            .mockResolvedValue(ok([{ id: 2, name: 'Test VA', count: 1 }]));
        mocks.fetchCircleList.mockReset()
            .mockResolvedValueOnce(failed(new Error('down')))
            .mockResolvedValue(ok([{ id: 3, name: 'Test Circle', count: 1 }]));

        const wrapper = mountDialog();
        await wrapper.setProps({ visible: true });
        await flushPromises();
        expect(document.body.textContent).toContain('advMetadataFailed');

        const retry = document.querySelector('.asmr-metadata-retry') as HTMLButtonElement | null;
        expect(retry).not.toBeNull();
        expect(retry?.textContent).toContain('advRetry');

        retry?.click();
        await flushPromises();

        expect(mocks.clearCache).toHaveBeenCalled();
        expectNotLoading();
        expect(document.querySelector('.asmr-metadata-error')).toBeNull();
        expect(document.body.textContent).toContain('Whisper');
        expect(document.body.textContent).toContain('Test VA');
        expect(document.body.textContent).toContain('Test Circle');
        wrapper.unmount();
    });

    it('retries automatically when reopened after a failed first load', async () => {
        mocks.fetchTagList.mockReset()
            .mockResolvedValueOnce(failed(new Error('down')))
            .mockResolvedValue(ok([{ id: 1, name: 'Whisper', count: 1 }]));
        mocks.fetchVAList.mockReset()
            .mockResolvedValueOnce(failed(new Error('down')))
            .mockResolvedValue(ok([{ id: 2, name: 'Test VA', count: 1 }]));
        mocks.fetchCircleList.mockReset()
            .mockResolvedValueOnce(failed(new Error('down')))
            .mockResolvedValue(ok([{ id: 3, name: 'Test Circle', count: 1 }]));

        const wrapper = mountDialog();
        await wrapper.setProps({ visible: true });
        await flushPromises();
        expect(document.body.textContent).toContain('advMetadataFailed');

        await wrapper.setProps({ visible: false });
        await wrapper.setProps({ visible: true });
        await flushPromises();

        expect(mocks.fetchTagList).toHaveBeenCalledTimes(2);
        expect(document.querySelector('.asmr-metadata-error')).toBeNull();
        expectNotLoading();
        expect(document.body.textContent).toContain('Whisper');
        wrapper.unmount();
    });

    it('does not stay stuck loading across close/reopen when the first load hangs', async () => {
        vi.useFakeTimers();
        const tagResolvers: Array<(value: LabelFetchResult<{ id: number; name: string; count: number }>) => void> = [];
        mocks.fetchTagList.mockReset().mockImplementation(() => new Promise((resolve) => { tagResolvers.push(resolve); }));
        mocks.fetchVAList.mockReset().mockResolvedValue(ok([{ id: 2, name: 'Test VA', count: 1 }]));
        mocks.fetchCircleList.mockReset().mockResolvedValue(ok([{ id: 3, name: 'Test Circle', count: 1 }]));

        const wrapper = mountDialog();
        await wrapper.setProps({ visible: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(document.body.textContent).toContain('advLoadingTags');

        await wrapper.setProps({ visible: false });
        await wrapper.setProps({ visible: true });
        await vi.advanceTimersByTimeAsync(30000);
        await nextTick();

        expectNotLoading();
        expect(document.body.textContent).toContain('advMetadataFailed');

        // A late response from the abandoned request must not resurrect anything.
        tagResolvers.forEach(resolve => resolve(ok([{ id: 1, name: 'Late tag', count: 1 }])));
        await vi.advanceTimersByTimeAsync(0);
        expectNotLoading();
        wrapper.unmount();
    });

    it('merges host tag translations that arrive after the first load', async () => {
        // Host tag cache is still empty when the dialog first loads.
        mocks.hostTagList.mockReturnValue([]);
        mocks.fetchTagList.mockReset().mockResolvedValue(ok([{ id: 1, name: 'ささやき', count: 5 }]));
        mocks.fetchVAList.mockReset().mockResolvedValue(ok([{ id: 2, name: 'Test VA', count: 1 }]));
        mocks.fetchCircleList.mockReset().mockResolvedValue(ok([{ id: 3, name: 'Test Circle', count: 1 }]));

        const wrapper = mountDialog();
        await wrapper.setProps({ visible: true });
        await flushPromises();
        expect(document.body.textContent).not.toContain('Whispering');

        // Host metadata lands late; reopening picks it up without a refetch.
        mocks.hostTagList.mockReturnValue([
            { id: 1, name: 'ささやき', ja: 'ささやき', en: 'Whispering', count: 5 },
        ]);
        await wrapper.setProps({ visible: false });
        await wrapper.setProps({ visible: true });
        await flushPromises();

        expect(document.body.textContent).toContain('Whispering');
        expectNotLoading();
        wrapper.unmount();
    });

    it('signed-out style bridge failures render the retry banner, not a spinner', async () => {
        // MetadataApi surfaces "Bridge not initialized" / 401 as an error result.
        const authError = new Error('Bridge not initialized');
        mocks.fetchTagList.mockReset().mockResolvedValue(failed(authError));
        mocks.fetchVAList.mockReset().mockResolvedValue(failed(authError));
        mocks.fetchCircleList.mockReset().mockResolvedValue(failed(authError));

        const wrapper = mountDialog();
        await wrapper.setProps({ visible: true });
        await flushPromises();

        expectNotLoading();
        const banner = document.querySelector('.asmr-metadata-error');
        expect(banner).not.toBeNull();
        expect(banner?.getAttribute('role')).toBe('alert');
        wrapper.unmount();
    });
});
