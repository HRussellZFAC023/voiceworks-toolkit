import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Disposable } from '../../src/core/Disposable';

// Subclass to expose protected methods for testing
class TestDisposable extends Disposable {
    public doCleanup(fn: () => void) { this.onCleanup(fn); }
    public doAddDomListener(
        target: EventTarget,
        event: string,
        handler: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
    ) {
        this.addDomListener(target, event, handler, options);
    }
    public doAddInterval(handler: () => void, ms: number) {
        this.addInterval(handler, ms);
    }
    public doAddTimeout(handler: () => void, ms: number) {
        return this.addTimeout(handler, ms);
    }
}

describe('Disposable', () => {
    let disposable: TestDisposable;

    beforeEach(() => {
        vi.useFakeTimers();
        disposable = new TestDisposable();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('onCleanup', () => {
        it('should call cleanup functions on dispose', () => {
            const fn1 = vi.fn();
            const fn2 = vi.fn();
            disposable.doCleanup(fn1);
            disposable.doCleanup(fn2);

            disposable.dispose();

            expect(fn1).toHaveBeenCalledTimes(1);
            expect(fn2).toHaveBeenCalledTimes(1);
        });

        it('should continue calling cleanups even if one throws', () => {
            const fn1 = vi.fn(() => { throw new Error('fail'); });
            const fn2 = vi.fn();
            disposable.doCleanup(fn1);
            disposable.doCleanup(fn2);

            disposable.dispose();

            expect(fn1).toHaveBeenCalled();
            expect(fn2).toHaveBeenCalled();
        });

        it('should clear cleanups after dispose (safe to call multiple times)', () => {
            const fn = vi.fn();
            disposable.doCleanup(fn);

            disposable.dispose();
            disposable.dispose();

            expect(fn).toHaveBeenCalledTimes(1);
        });
    });

    describe('addDomListener', () => {
        it('should add and remove event listener on dispose', () => {
            const target = new EventTarget();
            const handler = vi.fn();

            const addSpy = vi.spyOn(target, 'addEventListener');
            const removeSpy = vi.spyOn(target, 'removeEventListener');

            disposable.doAddDomListener(target, 'click', handler);
            expect(addSpy).toHaveBeenCalledWith('click', handler, undefined);

            disposable.dispose();
            expect(removeSpy).toHaveBeenCalledWith('click', handler, undefined);
        });

        it('should pass options through to addEventListener/removeEventListener', () => {
            const target = new EventTarget();
            const handler = vi.fn();
            const options = { capture: true };

            const addSpy = vi.spyOn(target, 'addEventListener');
            const removeSpy = vi.spyOn(target, 'removeEventListener');

            disposable.doAddDomListener(target, 'scroll', handler, options);
            expect(addSpy).toHaveBeenCalledWith('scroll', handler, options);

            disposable.dispose();
            expect(removeSpy).toHaveBeenCalledWith('scroll', handler, options);
        });
    });

    describe('addInterval', () => {
        it('should start an interval that fires repeatedly', () => {
            const handler = vi.fn();
            disposable.doAddInterval(handler, 100);

            vi.advanceTimersByTime(350);
            expect(handler).toHaveBeenCalledTimes(3);
        });

        it('should clear the interval on dispose', () => {
            const handler = vi.fn();
            disposable.doAddInterval(handler, 100);

            vi.advanceTimersByTime(250);
            expect(handler).toHaveBeenCalledTimes(2);

            disposable.dispose();

            vi.advanceTimersByTime(500);
            expect(handler).toHaveBeenCalledTimes(2); // no more calls
        });
    });

    describe('addTimeout', () => {
        it('should fire the timeout callback', () => {
            const handler = vi.fn();
            disposable.doAddTimeout(handler, 200);

            vi.advanceTimersByTime(200);
            expect(handler).toHaveBeenCalledTimes(1);
        });

        it('should clear the timeout on dispose before it fires', () => {
            const handler = vi.fn();
            disposable.doAddTimeout(handler, 200);

            vi.advanceTimersByTime(100);
            disposable.dispose();

            vi.advanceTimersByTime(200);
            expect(handler).not.toHaveBeenCalled();
        });

        it('should return the timeout id', () => {
            const id = disposable.doAddTimeout(vi.fn(), 100);
            expect(id).toBeDefined();
        });
    });

    describe('multiple resource types', () => {
        it('should clean up all resource types on a single dispose call', () => {
            const cleanupFn = vi.fn();
            const intervalHandler = vi.fn();
            const timeoutHandler = vi.fn();
            const target = new EventTarget();
            const eventHandler = vi.fn();
            const removeSpy = vi.spyOn(target, 'removeEventListener');

            disposable.doCleanup(cleanupFn);
            disposable.doAddInterval(intervalHandler, 100);
            disposable.doAddTimeout(timeoutHandler, 500);
            disposable.doAddDomListener(target, 'test', eventHandler);

            // Let interval fire once
            vi.advanceTimersByTime(100);
            expect(intervalHandler).toHaveBeenCalledTimes(1);

            disposable.dispose();

            // Verify all cleaned up
            expect(cleanupFn).toHaveBeenCalled();
            expect(removeSpy).toHaveBeenCalled();

            // Interval and timeout should not fire anymore
            vi.advanceTimersByTime(1000);
            expect(intervalHandler).toHaveBeenCalledTimes(1);
            expect(timeoutHandler).not.toHaveBeenCalled();
        });
    });
});
