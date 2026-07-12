/**
 * Small generation-aware timeout registry for LearnerSubtitles.
 * Cancelling a scope both clears pending timers and invalidates callbacks that
 * have already entered the microtask queue.
 */
export class LearnerTaskScheduler {
    private timers = new Set<number>();
    private generation = 0;

    get token(): number {
        return this.generation;
    }

    get pendingCount(): number {
        return this.timers.size;
    }

    isCurrent(token: number): boolean {
        return token === this.generation;
    }

    schedule(callback: () => void, delayMs: number, guard?: () => boolean): number {
        const token = this.generation;
        const timer = window.setTimeout(() => {
            this.timers.delete(timer);
            if (!this.isCurrent(token) || (guard && !guard())) return;
            callback();
        }, delayMs);
        this.timers.add(timer);
        return timer;
    }

    cancelAll(): void {
        this.generation += 1;
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
    }
}

export interface TranslationLaneResult {
    inputs: string[];
    results: string[];
}

/** Every requested item must have a non-source result before a lane is complete. */
export function translationLaneSucceeded({ inputs, results }: TranslationLaneResult): boolean {
    return results.length === inputs.length
        && results.every((result, index) => !!result && result !== inputs[index]);
}

/** No requested lanes is success; otherwise every requested lane must succeed. */
export function allTranslationLanesSucceeded(lanes: TranslationLaneResult[]): boolean {
    return lanes.every(translationLaneSucceeded);
}
