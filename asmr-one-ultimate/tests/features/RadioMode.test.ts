import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RadioMode } from '../../src/features/radio';
import { Config } from '../../src/core/Utils';

vi.mock('../../src/core/Utils', async () => {
    return {
        Config: { get: vi.fn(), set: vi.fn() },
        Logger: { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        SafeUtils: { delay: vi.fn() }
    };
});

vi.mock('../../src/infrastructure/KikoeruBridge', () => ({
    KikoeruBridge: {
        getInstance: vi.fn(() => ({
            store: { watch: vi.fn() },
            app: { $watch: vi.fn() },
            player: {
                currentTrack: null,
                currentPlayingFile: null,
                queue: [],
                playlist: [],
                queueIndex: 0
            }
        }))
    }
}));



describe('RadioMode', () => {
    beforeEach(() => {
        (Config.get as any).mockReset();
        (RadioMode as any)._instance = null; // Reset singleton
    });

    it('is singleton', () => {
        const instance1 = RadioMode.getInstance();
        const instance2 = RadioMode.getInstance();
        expect(instance1).toBe(instance2);
    });

    it('starts inactive', () => {
        expect(RadioMode.isActive).toBe(false);
    });

    it('enable sets active state', () => {
        const instance = RadioMode.getInstance();
        instance.enable();
        expect(RadioMode.isActive).toBe(true);
    });

    it('disable sets inactive state', () => {
        const instance = RadioMode.getInstance();
        instance.enable();
        instance.disable();
        expect(RadioMode.isActive).toBe(false);
    });
    it('calls skipToNext if queue is empty on enable', () => {
        const instance = RadioMode.getInstance();

        // Spy on skipToNext
        const skipSpy = vi.spyOn(instance, 'skipToNext').mockImplementation(() => Promise.resolve());

        instance.enable();

        expect(skipSpy).toHaveBeenCalled();
        expect(RadioMode.isActive).toBe(true);
    });
});

