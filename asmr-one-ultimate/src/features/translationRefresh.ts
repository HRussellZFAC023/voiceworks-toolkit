/**
 * Trailing-edge refresh scheduling for translation features.
 *
 * `CentralObserver` drops a registered callback whose per-feature debounce
 * window has not elapsed yet — it never re-schedules the skipped run. A
 * mutation burst that ends inside that window therefore leaves the newest DOM
 * permanently untranslated: paginated/infinite-scroll pages, recycled cards and
 * host re-renders all settle within a few hundred milliseconds and then stop
 * mutating, so no later batch ever arrives to make up for the dropped run.
 *
 * Translation features register with a zero debounce and funnel every signal
 * through this scheduler instead. The contract is deliberately simple:
 * **any `schedule()` results in exactly one `run()` within `delayMs`.**
 */
export interface TranslationRefreshScheduler {
    /** Request a run. Coalesces with any run already queued. */
    schedule(): void;
    /** Run immediately, cancelling a queued run. */
    flush(): void;
    /** Drop a queued run without executing it. */
    cancel(): void;
    /** True while a run is queued. */
    readonly pending: boolean;
}

export function createTranslationRefreshScheduler(
    run: () => void,
    delayMs: number,
): TranslationRefreshScheduler {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clear = (): void => {
        if (timer === null) return;
        clearTimeout(timer);
        timer = null;
    };

    return {
        get pending(): boolean {
            return timer !== null;
        },
        schedule(): void {
            // Throttle with a guaranteed trailing edge: never restart the timer,
            // so a continuous mutation stream cannot postpone the run forever.
            if (timer !== null) return;
            timer = setTimeout(() => {
                timer = null;
                run();
            }, delayMs);
        },
        flush(): void {
            clear();
            run();
        },
        cancel(): void {
            clear();
        },
    };
}
