import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    translateBatch: vi.fn(),
    itemsWatch: vi.fn(() => vi.fn()),
    route: { path: '/circles', query: {} as Record<string, unknown> },
}));

const listVm = {
    restrict: 'circles',
    items: [{ id: 1, name: '癒やし屋', count: 1 }],
    keyword: '',
    $watch: mocks.itemsWatch,
};

vi.mock('../../src/infrastructure/KikoeruBridge', () => ({
    KikoeruBridge: {
        getInstance: () => ({
            get route() { return mocks.route; },
            findComponent: () => listVm,
            router: undefined,
        }),
    },
}));
vi.mock('../../src/features/TranslatedTags', () => ({
    TranslatedTags: { getInstance: () => ({ getTagList: () => [] }) },
}));
vi.mock('../../src/services/TranslationService', () => ({
    TranslationService: {
        getUiTargetLang: () => 'en',
        translateBatch: mocks.translateBatch,
        formatPair: (original: string, translated: string) => `${original} (${translated})`,
    },
}));
vi.mock('../../src/core/Utils', () => ({
    Logger: { debug: vi.fn(), warn: vi.fn() },
    Config: { get: () => true },
}));
vi.mock('../../src/core/EventBus', () => ({
    EventBus: { on: () => vi.fn() },
}));

import { ListSearchEnhancer } from '../../src/features/ListSearchEnhancer';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
}

describe('ListSearchEnhancer async lifecycle', () => {
    it('does not install an items watcher when translation settles after disable', async () => {
        mocks.itemsWatch.mockClear();
        listVm.items = [{ id: 1, name: '癒やし屋', count: 1 }];
        const translation = deferred<string[]>();
        mocks.translateBatch.mockReturnValueOnce(translation.promise);
        const enhancer = new ListSearchEnhancer();
        (enhancer as unknown as { isEnabled: boolean }).isEnabled = true;

        const augmenting = (enhancer as unknown as { tryAugment(): Promise<void> }).tryAugment();
        await vi.waitFor(() => expect(mocks.translateBatch).toHaveBeenCalledTimes(1));
        enhancer.disable();
        translation.resolve(['Healing Shop']);
        await augmenting;

        expect(mocks.itemsWatch).not.toHaveBeenCalled();
        expect(listVm.items[0].name).toBe('癒やし屋');
    });
});
