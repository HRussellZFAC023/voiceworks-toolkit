import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mocks to ensure they're available before imports
const { mockStorage, emitMock } = vi.hoisted(() => {
    // Clear persisted store and event bus from other tests
    const g = (typeof global !== 'undefined' ? global : window) as any;
    delete g.__ASMR_APP_STORE__;
    delete g.__ASMR_EVENT_BUS__;

    return {
        mockStorage: {} as Record<string, unknown>,
        emitMock: vi.fn(),
    };
});

// Mock GM functions
vi.mock('$', () => ({
    GM_getValue: vi.fn((key: string, defaultValue: unknown) => mockStorage[key] ?? defaultValue),
    GM_setValue: vi.fn((key: string, value: unknown) => {
        mockStorage[key] = value;
    }),
}));

// Mock EventBus
vi.mock('../../src/core/EventBus', () => ({
    EventBus: {
        emit: emitMock,
        on: vi.fn(),
        off: vi.fn(),
    },
}));

describe('AppStore', () => {
    let AppStore: any;
    let Config: any;

    beforeEach(async () => {
        // Clear mock storage
        Object.keys(mockStorage).forEach(key => delete mockStorage[key]);
        vi.clearAllMocks();
        
        // Reset modules to force fresh evaluation of AppStore
        vi.resetModules();
        const g = (typeof global !== 'undefined' ? global : window) as any;
        delete g.__ASMR_APP_STORE__;
        delete g.__ASMR_EVENT_BUS__;

        const module = await import('../../src/store/AppStore');
        AppStore = module.AppStore;
        Config = module.Config;
    });

    describe('Configuration', () => {
        it('should get config with default value', () => {
            const value = AppStore.getConfig('shuffle');
            expect(value).toBe(false);
        });

        it('should set and get config value', () => {
            AppStore.setConfig('shuffle', true);
            expect(AppStore.getConfig('shuffle')).toBe(true);
        });

        it('should emit config:change event', () => {
            AppStore.setConfig('shuffle', true);
            expect(emitMock).toHaveBeenCalledWith('config:change', {
                key: 'shuffle',
                value: true,
                oldValue: false,
            });
        });

        it('should return default for missing config', () => {
            const defaultValue = AppStore.getConfigDefault('shuffle');
            expect(defaultValue).toBe(false);
        });

        it('should get all config values', () => {
            const config = AppStore.getAllConfig();
            expect(config).toHaveProperty('shuffle');
            expect(config).toHaveProperty('autoProgress');
        });
    });

    describe('State Management', () => {
        it('should return initial state', () => {
            const state = AppStore.state;
            expect(state.isInitialized).toBe(false);
            expect(state.radio.isActive).toBe(false);
        });

        it('should update state with object', () => {
            AppStore.setState({ isInitialized: true });
            expect(AppStore.state.isInitialized).toBe(true);
        });

        it('should update state with function', () => {
            AppStore.setState((state: any) => ({ isInitialized: !state.isInitialized }));
            expect(AppStore.state.isInitialized).toBe(true);
        });

        it('should update radio state', () => {
            AppStore.setRadioState({ isActive: true, state: 'playing' });
            expect(AppStore.state.radio.isActive).toBe(true);
            expect(AppStore.state.radio.state).toBe('playing');
        });

        it('should emit radio:toggle when isActive changes', () => {
            AppStore.setRadioState({ isActive: true });
            expect(emitMock).toHaveBeenCalledWith('radio:toggle', { isActive: true });
        });

        it('should update learner state', () => {
            AppStore.setLearnerState({ isActive: true });
            expect(AppStore.state.learner.isActive).toBe(true);
        });

        it('should update whisper state', () => {
            AppStore.setWhisperState({ isTranscribing: true, progress: 50 });
            expect(AppStore.state.whisper.isTranscribing).toBe(true);
            expect(AppStore.state.whisper.progress).toBe(50);
        });
    });

    describe('Host Store', () => {
        it('should throw if host not set', () => {
            expect(() => AppStore.host).toThrow('Host store not initialized');
        });

        it('should set host store', () => {
            const mockStore = {
                state: {
                    AudioPlayer: { playing: true, currentTime: 0, duration: 100 },
                    User: {},
                },
            };
            AppStore.setHostStore(mockStore as any);
            expect(AppStore.host).toBe(mockStore);
        });

        it('should access player state', () => {
            const mockStore = {
                state: {
                    AudioPlayer: {
                        playing: true,
                        currentTime: 30,
                        duration: 100,
                        currentTrack: { title: 'Test' },
                    },
                    User: {},
                },
            };
            AppStore.setHostStore(mockStore as any);
            expect(AppStore.player.playing).toBe(true);
            expect(AppStore.currentTrack?.title).toBe('Test');
        });
    });

    describe('Legacy Config Export', () => {
        it('should work with Config.get', () => {
            const value = Config.get('shuffle');
            expect(value).toBe(false);
        });

        it('should work with Config.set', () => {
            Config.set('shuffle', true);
            expect(Config.get('shuffle')).toBe(true);
        });
    });
});
