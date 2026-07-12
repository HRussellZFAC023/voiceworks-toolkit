import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    ensure: vi.fn(),
    waitFor: vi.fn(),
    observerCallback: null as (() => void) | null,
    unregister: vi.fn(),
}));

vi.mock('../../src/ui/HeaderActions', () => ({
    HeaderActions: { ensure: mocks.ensure },
}));

vi.mock('../../src/core/Utils', () => ({
    SafeUtils: { waitFor: mocks.waitFor },
    I18n: { t: (key: string) => key === 'donateLabel' ? 'Support Development' : key },
}));

vi.mock('../../src/core/CentralObserver', () => ({
    CentralObserver: {
        register: vi.fn((_name: string, callback: () => void) => {
            mocks.observerCallback = callback;
        }),
        unregister: mocks.unregister,
    },
}));

import { SupportButton } from '../../src/features/SupportButton';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
}

describe('SupportButton lifecycle', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="actions"></div>';
        mocks.ensure.mockReset().mockImplementation(() => document.getElementById('actions'));
        mocks.waitFor.mockReset().mockResolvedValue(true);
        mocks.observerCallback = null;
        mocks.unregister.mockReset();
    });

    it('does not resume a pending enable after disable', async () => {
        const wait = deferred<boolean>();
        mocks.waitFor.mockReturnValue(wait.promise);
        const feature = new SupportButton();

        const first = feature.enable();
        const duplicate = feature.enable();
        feature.disable();
        wait.resolve(true);
        await Promise.all([first, duplicate]);

        expect(mocks.waitFor).toHaveBeenCalledOnce();
        expect(document.querySelector('.asmr-support-btn')).toBeNull();
        expect(mocks.observerCallback).toBeNull();
    });

    it('rejects a captured observer callback after disable', async () => {
        const feature = new SupportButton();
        await feature.enable();
        const queued = mocks.observerCallback;
        feature.disable();

        queued?.();

        expect(document.querySelector('.asmr-support-btn')).toBeNull();
        expect(mocks.unregister).toHaveBeenCalledWith('support-button');
    });
});
