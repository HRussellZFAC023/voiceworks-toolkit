import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    LearnerTaskScheduler,
    allTranslationLanesSucceeded,
    translationLaneSucceeded,
} from '../../src/features/learnerTaskScheduler';

describe('LearnerTaskScheduler', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('cancels delayed work and invalidates the captured generation', () => {
        vi.useFakeTimers();
        const scheduler = new LearnerTaskScheduler();
        const callback = vi.fn();
        const token = scheduler.token;

        scheduler.schedule(callback, 100);
        expect(scheduler.pendingCount).toBe(1);
        scheduler.cancelAll();
        vi.advanceTimersByTime(200);

        expect(callback).not.toHaveBeenCalled();
        expect(scheduler.pendingCount).toBe(0);
        expect(scheduler.isCurrent(token)).toBe(false);
    });

    it('checks a track/context guard before running delayed work', () => {
        vi.useFakeTimers();
        const scheduler = new LearnerTaskScheduler();
        const callback = vi.fn();
        let current = true;
        scheduler.schedule(callback, 20, () => current);
        current = false;

        vi.advanceTimersByTime(20);

        expect(callback).not.toHaveBeenCalled();
    });
});

describe('learner translation lane completion', () => {
    it('requires every requested item to differ from its source', () => {
        expect(translationLaneSucceeded({
            inputs: ['一', '二'],
            results: ['one', '二'],
        })).toBe(false);
        expect(translationLaneSucceeded({
            inputs: ['一', '二'],
            results: ['one', 'two'],
        })).toBe(true);
    });

    it('does not let target success hide a failed CN-to-JA lane', () => {
        expect(allTranslationLanesSucceeded([
            { inputs: ['你好'], results: ['hello'] },
            { inputs: ['你好'], results: ['你好'] },
        ])).toBe(false);
    });
});
