export interface ToggleableFeature {
    enable(): void | Promise<void>;
    disable(): void;
}

/**
 * Owns the state transition around a dynamically imported feature.
 *
 * The latest requested state wins even if the import resolves later, and a
 * burst of config events can never start duplicate imports or duplicate
 * enable calls.
 */
export class LazyFeatureGate {
    private instance: ToggleableFeature | null = null;
    private loading: Promise<void> | null = null;
    private transition: Promise<void> | null = null;
    private desiredEnabled = false;
    private appliedEnabled = false;
    private failedDesiredState: boolean | null = null;

    constructor(
        private readonly loader: () => Promise<ToggleableFeature>,
        private readonly onError: (error: unknown) => void = () => undefined,
    ) {}

    enable(): void {
        const retryingFailedLoad = this.desiredEnabled
            && !this.instance
            && !this.loading
            && this.failedDesiredState === true;
        if (this.desiredEnabled && !retryingFailedLoad) return;
        this.desiredEnabled = true;
        this.failedDesiredState = null;
        if (this.instance) {
            this.applyDesiredState();
            return;
        }
        if (this.loading) return;

        this.loading = this.loader()
            .then((instance) => {
                this.instance = instance;
                this.applyDesiredState();
            })
            .catch((error) => {
                this.failedDesiredState = true;
                this.onError(error);
            })
            .finally(() => {
                this.loading = null;
            });
    }

    disable(): void {
        if (!this.desiredEnabled) return;
        this.desiredEnabled = false;
        this.failedDesiredState = null;
        this.applyDesiredState();
    }

    private applyDesiredState(): void {
        if (
            !this.instance
            || this.transition
            || this.desiredEnabled === this.appliedEnabled
            || this.failedDesiredState === this.desiredEnabled
        ) return;

        const targetEnabled = this.desiredEnabled;
        try {
            const result = targetEnabled
                ? this.instance.enable()
                : this.instance.disable();

            if (result && typeof (result as Promise<void>).then === 'function') {
                this.transition = Promise.resolve(result)
                    .then(() => {
                        this.appliedEnabled = targetEnabled;
                    })
                    .catch((error) => {
                        this.failedDesiredState = targetEnabled;
                        this.onError(error);
                    })
                    .finally(() => {
                        this.transition = null;
                        this.applyDesiredState();
                    });
                return;
            }

            this.appliedEnabled = targetEnabled;
            this.applyDesiredState();
        } catch (error) {
            this.failedDesiredState = targetEnabled;
            this.onError(error);
        }
    }
}
