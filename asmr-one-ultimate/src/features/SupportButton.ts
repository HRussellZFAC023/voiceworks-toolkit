import { HeaderActions } from '../ui/HeaderActions';
import { I18n, SafeUtils } from '../core/Utils';
import { CentralObserver } from '../core/CentralObserver';

export class SupportButton {
    private button: HTMLElement | null = null;
    private enabled = false;
    private lifecycleGeneration = 0;
    // Link from P2-04 task
    private readonly link = 'https://paypal.me/HenryRussell163';

    public async enable(): Promise<void> {
        if (this.enabled) return;
        this.enabled = true;
        const generation = ++this.lifecycleGeneration;

        // Initial wait
        await SafeUtils.waitFor(() => !!HeaderActions.ensure(), 30000);
        if (!this.enabled || generation !== this.lifecycleGeneration) return;
        this.inject();

        // Re-inject when Vue re-renders the header (detected by CentralObserver)
        CentralObserver.register('support-button', () => {
            if (!this.enabled || generation !== this.lifecycleGeneration) return;
            if (this.button && !this.button.isConnected) {
                this.button = null;
                this.inject();
            }
        }, 500);
    }

    public disable(): void {
        this.enabled = false;
        this.lifecycleGeneration++;
        CentralObserver.unregister('support-button');
        if (this.button) {
            this.button.remove();
            this.button = null;
        }
    }

    private inject(): void {
        if (!this.enabled) return;
        const container = HeaderActions.ensure();
        if (!container) return;

        // Check if button exists and is still attached
        if (this.button && this.button.isConnected) return;

        // Create the button
        const btn = document.createElement('a');
        btn.href = this.link;
        btn.target = '_blank';
        btn.rel = 'noopener noreferrer';
        // Quasar button classes for a flat button with icon and text
        btn.className = 'q-btn q-btn-flat q-btn-dense asmr-support-btn text-white';
        const label = I18n.t('donateLabel');
        btn.title = label;
        btn.ariaLabel = label;

        btn.innerHTML = '<span class="q-btn__content"><i class="q-icon material-icons" aria-hidden="true" role="presentation">health_and_safety</i></span>';

        // Prepend to container to be prominent? or append?
        // HeaderActions container is usually populated by ensure().
        // If we append, it's on the right.
        container.appendChild(btn);
        this.button = btn;
    }
}
