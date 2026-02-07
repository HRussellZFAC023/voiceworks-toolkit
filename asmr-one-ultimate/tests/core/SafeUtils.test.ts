import { describe, it, expect, vi, afterEach } from 'vitest';
import { SafeUtils, DialogStyles } from '../../src/core/Utils';

describe('SafeUtils', () => {
    afterEach(() => {
        vi.useRealTimers();
        document.body.innerHTML = '';
        document.head.innerHTML = '';
    });

    describe('waitFor', () => {
        it('should resolve true immediately if predicate is already true', async () => {
            const result = await SafeUtils.waitFor(() => true);
            expect(result).toBe(true);
        });

        it('should resolve true when predicate becomes true', async () => {
            let ready = false;
            const promise = SafeUtils.waitFor(() => ready, 2000, 50);
            setTimeout(() => { ready = true; }, 100);
            expect(await promise).toBe(true);
        });

        it('should resolve false on timeout', async () => {
            vi.useFakeTimers();
            const promise = SafeUtils.waitFor(() => false, 500, 100);
            vi.advanceTimersByTime(600);
            expect(await promise).toBe(false);
        });

        it('should accept truthy values (not just boolean true)', async () => {
            const result = await SafeUtils.waitFor(() => 'non-empty string');
            expect(result).toBe(true);
        });
    });

    describe('waitForElement', () => {
        it('should resolve with element when found', async () => {
            document.body.innerHTML = '<div id="target">Found</div>';
            const el = await SafeUtils.waitForElement('#target', 1000);
            expect(el).not.toBeNull();
        });

        it('should resolve null when element not found before timeout', async () => {
            vi.useFakeTimers();
            const promise = SafeUtils.waitForElement('#missing', 500);
            vi.advanceTimersByTime(600);
            const el = await promise;
            expect(el).toBeNull();
        });
    });

    describe('debounce', () => {
        it('should delay function execution', () => {
            vi.useFakeTimers();
            const fn = vi.fn();
            const debounced = SafeUtils.debounce(fn, 200);

            debounced();
            expect(fn).not.toHaveBeenCalled();

            vi.advanceTimersByTime(200);
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('should reset delay on subsequent calls', () => {
            vi.useFakeTimers();
            const fn = vi.fn();
            const debounced = SafeUtils.debounce(fn, 200);

            debounced();
            vi.advanceTimersByTime(100);
            debounced(); // Reset timer
            vi.advanceTimersByTime(100);
            expect(fn).not.toHaveBeenCalled();

            vi.advanceTimersByTime(100);
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('should pass arguments to the original function', () => {
            vi.useFakeTimers();
            const fn = vi.fn();
            const debounced = SafeUtils.debounce(fn, 100);

            debounced('arg1', 'arg2');
            vi.advanceTimersByTime(100);
            expect(fn).toHaveBeenCalledWith('arg1', 'arg2');
        });

        it('should use latest arguments when debounced', () => {
            vi.useFakeTimers();
            const fn = vi.fn();
            const debounced = SafeUtils.debounce(fn, 100);

            debounced('first');
            debounced('second');
            vi.advanceTimersByTime(100);
            expect(fn).toHaveBeenCalledTimes(1);
            expect(fn).toHaveBeenCalledWith('second');
        });
    });
});

describe('DialogStyles', () => {
    afterEach(() => {
        document.head.innerHTML = '';
    });

    describe('injectSizing', () => {
        it('should inject dialog sizing styles', () => {
            DialogStyles.injectSizing();
            const style = document.getElementById('asmr-dialog-sizing-style');
            expect(style).not.toBeNull();
            expect(style!.textContent).toContain('60vw');
            expect(style!.textContent).toContain('55vh');
        });

        it('should not duplicate styles on repeated calls', () => {
            DialogStyles.injectSizing();
            DialogStyles.injectSizing();
            const styles = document.querySelectorAll('#asmr-dialog-sizing-style');
            expect(styles).toHaveLength(1);
        });
    });
});
