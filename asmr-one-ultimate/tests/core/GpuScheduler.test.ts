import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../src/core/EventBus';
import { GpuScheduler, isExplicitGpuDeviceLoss } from '../../src/core/GpuScheduler';

describe('GpuScheduler device-loss classification', () => {
    afterEach(() => {
        EventBus.removeAllListeners('gpu:device-lost');
        EventBus.removeAllListeners('gpu:device-lost-broadcast');
        GpuScheduler.onGpuSuccess();
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it.each([
        'device-lost-event',
        'GPU device lost during OrtRun',
    ])('recognizes %s as explicit device loss', (reason) => {
        expect(isExplicitGpuDeviceLoss(reason)).toBe(true);
    });

    it('broadcasts the worker event contract as device loss', () => {
        vi.useFakeTimers();
        const broadcast = vi.fn();
        EventBus.on('gpu:device-lost-broadcast', broadcast);
        GpuScheduler.initialize();

        EventBus.emit('gpu:device-lost', { worker: 'whisper' });

        expect(broadcast).toHaveBeenCalledWith({ source: 'whisper' });
    });
});
