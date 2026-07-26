import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTranslationRefreshScheduler } from '../../src/features/translationRefresh';

describe('createTranslationRefreshScheduler', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('runs once per burst instead of once per signal', () => {
        const run = vi.fn();
        const scheduler = createTranslationRefreshScheduler(run, 250);

        scheduler.schedule();
        scheduler.schedule();
        scheduler.schedule();
        expect(run).not.toHaveBeenCalled();

        vi.advanceTimersByTime(250);
        expect(run).toHaveBeenCalledTimes(1);
    });

    /**
     * The defect this replaces: CentralObserver skips a callback inside its
     * debounce window and never re-queues it, so a burst that ends inside the
     * window is silently lost and the newest DOM stays untranslated forever.
     */
    it('never drops a signal that arrives while a run is already queued', () => {
        const run = vi.fn();
        const scheduler = createTranslationRefreshScheduler(run, 250);

        scheduler.schedule();
        vi.advanceTimersByTime(240);
        scheduler.schedule();
        vi.advanceTimersByTime(10);
        expect(run).toHaveBeenCalledTimes(1);

        // The late signal is covered by the run it landed in, and the scheduler
        // is armed again for whatever comes next.
        scheduler.schedule();
        vi.advanceTimersByTime(250);
        expect(run).toHaveBeenCalledTimes(2);
    });

    it('does not let a continuous mutation stream postpone the run', () => {
        const run = vi.fn();
        const scheduler = createTranslationRefreshScheduler(run, 100);

        for (let elapsed = 0; elapsed < 100; elapsed += 10) {
            scheduler.schedule();
            vi.advanceTimersByTime(10);
        }

        expect(run).toHaveBeenCalledTimes(1);
    });

    it('reports pending state and drops the queued run on cancel', () => {
        const run = vi.fn();
        const scheduler = createTranslationRefreshScheduler(run, 250);

        expect(scheduler.pending).toBe(false);
        scheduler.schedule();
        expect(scheduler.pending).toBe(true);

        scheduler.cancel();
        expect(scheduler.pending).toBe(false);
        vi.advanceTimersByTime(1000);
        expect(run).not.toHaveBeenCalled();
    });

    it('flush runs immediately and consumes the queued run', () => {
        const run = vi.fn();
        const scheduler = createTranslationRefreshScheduler(run, 250);

        scheduler.schedule();
        scheduler.flush();
        expect(run).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(1000);
        expect(run).toHaveBeenCalledTimes(1);
    });
});
