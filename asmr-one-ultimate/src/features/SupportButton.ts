import { HeaderActions } from '../ui/HeaderActions';
import { SafeUtils } from '../core/Utils';

export class SupportButton {
    private button: HTMLElement | null = null;
    private intervalId: number | null = null;
    // Link from P2-04 task
    private readonly link = 'https://paypal.me/HenryRussell163';

    public async enable(): Promise<void> {
        // Initial wait
        await SafeUtils.waitFor(() => !!HeaderActions.ensure(), 30000);
        this.inject();

        // Simple polling to keep it alive (since Vue might re-render header)
        if (this.intervalId === null) {
            this.intervalId = window.setInterval(() => this.inject(), 2000);
        }
    }

    private inject(): void {
        const container = HeaderActions.ensure();
        if (!container) return;

        // Check if button exists and is still attached
        if (this.button && document.contains(this.button)) return;

        // Create the button
        const btn = document.createElement('a');
        btn.href = this.link;
        btn.target = '_blank';
        btn.rel = 'noopener noreferrer';
        // Quasar button classes for a flat button with icon and text
        btn.className = 'q-btn q-btn-flat q-btn-dense asmr-support-btn text-white';
        btn.title = 'Support Development';

        btn.innerHTML = `
            <span class="q-focus-helper"></span>
            <span class="q-btn__content text-center col items-center q-anchor--skip justify-center row">
                <i class="q-icon material-icons" aria-hidden="true" role="presentation">health_and_safety</i>
            </span>
        `;

        // Prepend to container to be prominent? or append?
        // HeaderActions container is usually populated by ensure(). 
        // If we append, it's on the right.
        container.appendChild(btn);
        this.button = btn;
    }
}
