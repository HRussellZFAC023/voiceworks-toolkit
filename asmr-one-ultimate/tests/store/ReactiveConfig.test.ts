import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks
const { mockGetAllConfig, mockEventBusOn, mockEventBusEmit, listeners } = vi.hoisted(() => {
    const listeners: Array<{ event: string; handler: Function }> = [];
    return {
        mockGetAllConfig: vi.fn(() => ({
            shuffle: false,
            autoProgress: true,
            sfwMode: false,
        })),
        mockEventBusOn: vi.fn((event: string, handler: Function) => {
            listeners.push({ event, handler });
            return () => {
                const idx = listeners.findIndex(l => l.handler === handler);
                if (idx >= 0) listeners.splice(idx, 1);
            };
        }),
        mockEventBusEmit: vi.fn(),
        listeners,
    };
});

vi.mock('../../src/store/AppStore', () => ({
    AppStore: {
        getAllConfig: mockGetAllConfig,
    },
}));

vi.mock('../../src/core/EventBus', () => ({
    EventBus: {
        on: mockEventBusOn,
        emit: mockEventBusEmit,
    },
}));

// Need to use dynamic imports because ReactiveConfig has module-level state
describe('ReactiveConfig', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        listeners.length = 0;
        vi.resetModules();
        // Clear global state
        const g = (typeof global !== 'undefined' ? global : window) as any;
        delete g.__ASMR_REACTIVE_CONFIG__;
        document.body.className = '';
    });

    describe('initReactiveConfig', () => {
        it('should create reactive config from AppStore snapshot', async () => {
            const { initReactiveConfig } = await import('../../src/store/ReactiveConfig');
            const config = initReactiveConfig();
            expect(config.shuffle).toBe(false);
            expect(config.autoProgress).toBe(true);
        });

        it('should register config:change listener on EventBus', async () => {
            const { initReactiveConfig } = await import('../../src/store/ReactiveConfig');
            initReactiveConfig();
            expect(mockEventBusOn).toHaveBeenCalledWith('config:change', expect.any(Function));
        });

        it('should update reactive config when config:change fires', async () => {
            const { initReactiveConfig } = await import('../../src/store/ReactiveConfig');
            const config = initReactiveConfig();

            // Find the config:change listener
            const listener = listeners.find(l => l.event === 'config:change');
            expect(listener).toBeDefined();

            // Simulate config change
            listener!.handler({ key: 'shuffle', value: true });
            expect(config.shuffle).toBe(true);
        });

        it('should apply SFW body class on init if enabled', async () => {
            mockGetAllConfig.mockReturnValueOnce({
                shuffle: false,
                autoProgress: true,
                sfwMode: true,
            });
            const { initReactiveConfig } = await import('../../src/store/ReactiveConfig');
            initReactiveConfig();
            expect(document.body.classList.contains('asmr-sfw-mode')).toBe(true);
        });

        it('should toggle SFW body class on config:change', async () => {
            const { initReactiveConfig } = await import('../../src/store/ReactiveConfig');
            initReactiveConfig();

            const listener = listeners.find(l => l.event === 'config:change');
            listener!.handler({ key: 'sfwMode', value: true });
            expect(document.body.classList.contains('asmr-sfw-mode')).toBe(true);

            listener!.handler({ key: 'sfwMode', value: false });
            expect(document.body.classList.contains('asmr-sfw-mode')).toBe(false);
        });

        it('should return cached instance on second call', async () => {
            const { initReactiveConfig } = await import('../../src/store/ReactiveConfig');
            const first = initReactiveConfig();
            const second = initReactiveConfig();
            expect(first).toBe(second);
            // getAllConfig should only be called once
            expect(mockGetAllConfig).toHaveBeenCalledTimes(1);
        });
    });

    describe('getReactiveConfig', () => {
        it('should throw when not initialized', async () => {
            const { getReactiveConfig } = await import('../../src/store/ReactiveConfig');
            expect(() => getReactiveConfig()).toThrow('ReactiveConfig not initialized');
        });

        it('should return config after initialization', async () => {
            const { initReactiveConfig, getReactiveConfig } = await import('../../src/store/ReactiveConfig');
            initReactiveConfig();
            const config = getReactiveConfig();
            expect(config.shuffle).toBe(false);
        });
    });

    describe('watchConfig', () => {
        it('should call callback when watched key changes', async () => {
            const { initReactiveConfig, watchConfig } = await import('../../src/store/ReactiveConfig');
            initReactiveConfig();

            const callback = vi.fn();
            watchConfig('shuffle', callback);

            // The watchConfig registers another EventBus.on('config:change', ...) listener
            const watchListener = listeners.filter(l => l.event === 'config:change').pop();
            expect(watchListener).toBeDefined();

            // Simulate change to the watched key
            watchListener!.handler({ key: 'shuffle', value: true, oldValue: false });
            expect(callback).toHaveBeenCalledWith(true, false);
        });

        it('should not call callback for different key changes', async () => {
            const { initReactiveConfig, watchConfig } = await import('../../src/store/ReactiveConfig');
            initReactiveConfig();

            const callback = vi.fn();
            watchConfig('shuffle', callback);

            const watchListener = listeners.filter(l => l.event === 'config:change').pop();
            watchListener!.handler({ key: 'autoProgress', value: false, oldValue: true });
            expect(callback).not.toHaveBeenCalled();
        });

        it('should call callback immediately when immediate option is set', async () => {
            const { initReactiveConfig, watchConfig } = await import('../../src/store/ReactiveConfig');
            initReactiveConfig();

            const callback = vi.fn();
            watchConfig('shuffle', callback, { immediate: true });
            // Should be called immediately with current value
            expect(callback).toHaveBeenCalledWith(false, false);
        });

        it('should return unsubscribe function', async () => {
            const { initReactiveConfig, watchConfig } = await import('../../src/store/ReactiveConfig');
            initReactiveConfig();

            const callback = vi.fn();
            const unwatch = watchConfig('shuffle', callback);

            // Count listeners before
            const before = listeners.filter(l => l.event === 'config:change').length;
            unwatch();
            const after = listeners.filter(l => l.event === 'config:change').length;
            expect(after).toBe(before - 1);
        });
    });
});
