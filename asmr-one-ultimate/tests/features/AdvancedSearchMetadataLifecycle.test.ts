import { flushPromises, mount } from '@vue/test-utils';
import type { DefineComponent } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getTagList: vi.fn(),
    getVAList: vi.fn(),
    getCircleList: vi.fn(),
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
        getTagList: mocks.getTagList,
        getVAList: mocks.getVAList,
        getCircleList: mocks.getCircleList,
    },
    PlaylistApi: { createPlaylist: vi.fn() },
    HistoryApi: { getRecent: vi.fn(async () => []) },
}));
vi.mock('../../src/api/Client', () => ({ getAxios: () => ({ get: vi.fn() }) }));
vi.mock('../../src/features/TranslatedTags', () => ({
    TranslatedTags: { getInstance: () => ({ getTagList: () => [] }) },
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

describe('AdvancedSearchDialog metadata lifecycle', () => {
    beforeEach(() => {
        mocks.getTagList.mockReset()
            .mockResolvedValueOnce([])
            .mockResolvedValue([{ id: 1, name: 'Whisper', count: 3 }]);
        mocks.getVAList.mockReset()
            .mockResolvedValueOnce([])
            .mockResolvedValue([{ id: 2, name: 'Test VA', count: 2 }]);
        mocks.getCircleList.mockReset()
            .mockResolvedValueOnce([])
            .mockResolvedValue([{ id: 3, name: 'Test Circle', count: 1 }]);
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('defers hidden loading and retries empty metadata when reopened', async () => {
        const wrapper = mount(TypedAdvancedSearchDialog, {
            attachTo: document.body,
            props: { visible: false },
        });
        await flushPromises();
        expect(mocks.getTagList).not.toHaveBeenCalled();
        expect(mocks.getVAList).not.toHaveBeenCalled();
        expect(mocks.getCircleList).not.toHaveBeenCalled();

        await wrapper.setProps({ visible: true });
        await flushPromises();
        expect(mocks.getTagList).toHaveBeenCalledTimes(1);
        expect(document.body.textContent).toContain('advNoResults');
        expect(document.body.textContent).not.toContain('advLoadingTags');

        await wrapper.setProps({ visible: false });
        await wrapper.setProps({ visible: true });
        await flushPromises();
        expect(mocks.getTagList).toHaveBeenCalledTimes(2);
        expect(mocks.getVAList).toHaveBeenCalledTimes(2);
        expect(mocks.getCircleList).toHaveBeenCalledTimes(2);
        expect(document.body.textContent).toContain('Whisper');
        expect(document.body.textContent).toContain('Test VA');
        expect(document.body.textContent).toContain('Test Circle');

        wrapper.unmount();
    });

    it('retries when only one metadata endpoint was transiently empty', async () => {
        mocks.getTagList.mockReset()
            .mockResolvedValueOnce([])
            .mockResolvedValue([{ id: 1, name: 'Recovered tag', count: 1 }]);
        mocks.getVAList.mockReset().mockResolvedValue([{ id: 2, name: 'Stable VA', count: 1 }]);
        mocks.getCircleList.mockReset().mockResolvedValue([{ id: 3, name: 'Stable Circle', count: 1 }]);

        const wrapper = mount(TypedAdvancedSearchDialog, {
            attachTo: document.body,
            props: { visible: false },
        });
        await wrapper.setProps({ visible: true });
        await flushPromises();
        expect(document.body.textContent).not.toContain('Recovered tag');
        expect(document.body.textContent).toContain('Stable VA');

        await wrapper.setProps({ visible: false });
        await wrapper.setProps({ visible: true });
        await flushPromises();

        expect(mocks.getTagList).toHaveBeenCalledTimes(2);
        expect(document.body.textContent).toContain('Recovered tag');
        wrapper.unmount();
    });
});
