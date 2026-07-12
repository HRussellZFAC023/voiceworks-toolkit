import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    configEnabled: true,
    bridge: {
        currentWorkId: null as string | null,
        axios: { defaults: { baseURL: 'https://api.example' } },
        $watch: vi.fn(),
    },
    eventCleanups: [] as ReturnType<typeof vi.fn>[],
    eventOn: vi.fn(),
    watchConfig: vi.fn(),
}));

vi.mock('../../src/infrastructure/KikoeruBridge', () => ({
    KikoeruBridge: { getInstance: () => mocks.bridge },
}));

vi.mock('../../src/core/Utils', () => ({
    Config: { get: () => mocks.configEnabled },
    Logger: {
        log: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

vi.mock('../../src/core/EventBus', () => ({
    EventBus: { on: (...args: unknown[]) => mocks.eventOn(...args) },
}));

vi.mock('../../src/store/ReactiveConfig', () => ({
    watchConfig: (...args: unknown[]) => mocks.watchConfig(...args),
}));

vi.mock('../../src/infrastructure/HttpClient', () => ({
    gmRequest: vi.fn(),
    retryWithBackoff: vi.fn(),
}));

import { FaviconNowPlaying } from '../../src/features/FaviconNowPlaying';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

describe('FaviconNowPlaying lifecycle', () => {
    beforeEach(() => {
        mocks.configEnabled = true;
        mocks.bridge.currentWorkId = null;
        mocks.eventCleanups = [];
        mocks.bridge.$watch.mockReset();
        mocks.bridge.$watch.mockImplementation(() => vi.fn());
        mocks.eventOn.mockReset();
        mocks.eventOn.mockImplementation(() => {
            const cleanup = vi.fn();
            mocks.eventCleanups.push(cleanup);
            return cleanup;
        });
        mocks.watchConfig.mockReset();
        mocks.watchConfig.mockReturnValue(vi.fn());
        document.head.innerHTML = '<link rel="icon" href="https://original.example/favicon.png">';
    });

    it('keeps the newest work favicon when an older async generation finishes later', async () => {
        const manager = new FaviconNowPlaying();
        manager.enable();

        const first = deferred<Blob | null>();
        const second = deferred<Blob | null>();
        vi.spyOn(manager as any, 'fetchImage')
            .mockImplementationOnce(() => first.promise)
            .mockImplementationOnce(() => second.promise);
        vi.spyOn(manager as any, 'blobToFavicon').mockImplementation((...args: unknown[]) => {
            const blob = args[0] as Blob & { id?: string };
            return Promise.resolve(`data:image/png;${blob.id}`);
        });

        const firstUpdate = (manager as any).updateFaviconByWorkId('RJ00001');
        const secondUpdate = (manager as any).updateFaviconByWorkId('RJ00002');

        second.resolve(Object.assign(new Blob(['second']), { id: 'second' }));
        await secondUpdate;
        expect((manager as any).currentFaviconUrl).toBe('data:image/png;second');

        first.resolve(Object.assign(new Blob(['first']), { id: 'first' }));
        await firstUpdate;
        expect((manager as any).currentFaviconUrl).toBe('data:image/png;second');

        manager.disable();
    });

    it('does not apply an in-flight favicon after disable', async () => {
        const manager = new FaviconNowPlaying();
        manager.enable();
        const pending = deferred<Blob | null>();
        vi.spyOn(manager as any, 'fetchImage').mockReturnValue(pending.promise);
        vi.spyOn(manager as any, 'blobToFavicon').mockResolvedValue('data:image/png;late');

        const update = (manager as any).updateFaviconByWorkId('RJ00003');
        manager.disable();
        pending.resolve(new Blob(['late']));
        await update;

        expect((manager as any).currentFaviconUrl).toBeNull();
        expect((document.querySelector('link[rel="icon"]') as HTMLLinkElement).href)
            .toBe('https://original.example/favicon.png');
    });

    it('does not restore a work favicon after navigating away during its fetch', async () => {
        const manager = new FaviconNowPlaying();
        manager.enable();
        const pending = deferred<Blob | null>();
        vi.spyOn(manager as any, 'fetchImage').mockReturnValue(pending.promise);
        vi.spyOn(manager as any, 'blobToFavicon').mockResolvedValue('data:image/png;stale-work');

        const update = (manager as any).updateFaviconByWorkId('RJ00004');
        const routeCallback = mocks.bridge.$watch.mock.calls[0]?.[1] as (route: unknown) => void;
        routeCallback({ path: '/', params: {} });
        pending.resolve(new Blob(['stale']));
        await update;

        expect((manager as any).currentFaviconUrl).not.toBe('data:image/png;stale-work');
        expect((document.querySelector('link[rel="icon"]') as HTMLLinkElement).href)
            .toContain('h1DhlGPW_o.png');
        manager.disable();
    });

    it('registers event and route listeners only once across repeated enable calls', () => {
        const routeCleanup = vi.fn();
        mocks.bridge.$watch.mockReturnValue(routeCleanup);
        const manager = new FaviconNowPlaying();

        manager.enable();
        manager.enable();
        expect(mocks.eventOn).toHaveBeenCalledTimes(2);
        expect(mocks.bridge.$watch).toHaveBeenCalledTimes(1);

        manager.disable();
        manager.disable();
        expect(mocks.eventCleanups).toHaveLength(2);
        expect(mocks.eventCleanups[0]).toHaveBeenCalledTimes(1);
        expect(mocks.eventCleanups[1]).toHaveBeenCalledTimes(1);
        expect(routeCleanup).toHaveBeenCalledTimes(1);
    });
});
