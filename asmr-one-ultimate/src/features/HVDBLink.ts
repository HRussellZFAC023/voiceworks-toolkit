import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { CentralObserver } from '../core/CentralObserver';
import { Logger } from '../core/Utils';

export class HVDBLink {
    private bridge: KikoeruBridge;

    constructor() {
        this.bridge = KikoeruBridge.getInstance();
    }

    public enable(): void {
        Logger.debug('[HVDBLink] Enabling...');

        // Use bridge to watch for work changes
        this.bridge.watch(
            (state) => state.AudioPlayer?.work?.id,
            (newId) => {
                if (newId) {
                    Logger.debug('[HVDBLink] Work changed, scheduling injection');
                    this.scheduleInjection();
                }
            }
        );

        // Also watch for route changes (important for SPA navigation)
        this.bridge.$watch('$route', () => {
            Logger.debug('[HVDBLink] Route changed, scheduling injection');
            this.scheduleInjection();
        });

        // Register with CentralObserver for active polling/fixing
        CentralObserver.register('HVDBLink', () => this.inject(), 1000);

        // Immediate first check
        this.scheduleInjection();
    }

    private scheduleInjection() {
        // Since Vue might render with a delay, we try a few times
        let attempts = 0;
        const interval = setInterval(() => {
            this.inject();
            attempts++;
            if (attempts > 5) clearInterval(interval);
        }, 500);
    }

    private inject(): void {
        const currentWork = this.bridge.currentWork;
        const currentWorkId = this.bridge.currentWorkId;

        if (!currentWorkId) return;

        // Find the DLsite link container
        // Based on user snippet: <div class="col-auto q-pl-sm">...<a ...>DLsite</a></div>
        // Let's find any link that contains DLsite and is within a col-auto
        const links = Array.from(document.querySelectorAll('a'));
        const dlsiteLink = links.find(a =>
            a.href.includes('dlsite.com') && a.closest('.col-auto')
        );

        if (!dlsiteLink) {
            // Logger.debug('[HVDBLink] DLsite link not found yet');
            return;
        }

        const container = dlsiteLink.closest('.row.items-center.q-gutter-xs');
        if (!container) {
            // Logger.debug('[HVDBLink] Row container not found');
            return;
        }

        // Check if already injected
        if (container.querySelector('.asmr-hvdb-link')) return;

        // Try to get RJ code from work object first, then from ID
        let rjCode = '';
        const sourceId = String(currentWork?.source_id || currentWork?.sourceId || '').trim();
        
        if (sourceId) {
            // Check if it already has RJ prefix
            if (/^RJ\d{6,8}$/i.test(sourceId)) {
                rjCode = sourceId.toUpperCase();
            } else if (/^\d{6,8}$/.test(sourceId)) {
                // Numeric only - add RJ prefix
                rjCode = 'RJ' + sourceId;
            }
        }
        
        // Fallback to currentWorkId if sourceId didn't work
        if (!rjCode) {
            const cleanId = String(currentWorkId).trim();
            if (/^RJ\d{6,8}$/i.test(cleanId)) {
                rjCode = cleanId.toUpperCase();
            } else if (/^\d{6,8}$/.test(cleanId)) {
                rjCode = 'RJ' + cleanId;
            }
        }

        if (!rjCode) {
            Logger.debug(`[HVDBLink] Could not extract RJ code from id: ${currentWorkId}`);
            return;
        }

        // Generate HVDB ID
        const hvdbId = rjCode.replace(/^RJ/i, '');
        const hvdbUrl = `https://hvdb.me/Dashboard/Add?id=${hvdbId}`;

        // Create the HVDB link element
        const hvdbEl = document.createElement('div');
        hvdbEl.className = 'col-auto q-pl-sm asmr-hvdb-link';
        hvdbEl.innerHTML = `
            <i aria-hidden="true" role="presentation" class="q-icon notranslate material-icons" style="font-size: 18px;">launch</i>
            <a rel="noreferrer noopener" target="_blank" class="text-blue" href="${hvdbUrl}" style="margin-left: 4px;">HVDB</a>
        `;

        // Create the Chobit link element
        const chobitUrl = `https://chobit.cc/s/?f_category=all&q_keyword=${rjCode}`;
        const chobitEl = document.createElement('div');
        chobitEl.className = 'col-auto q-pl-sm asmr-chobit-link';
        chobitEl.innerHTML = `
            <i aria-hidden="true" role="presentation" class="q-icon notranslate material-icons" style="font-size: 18px;">search</i>
            <a rel="noreferrer noopener" target="_blank" class="text-blue" href="${chobitUrl}" style="margin-left: 4px;">Chobit</a>
        `;

        // Append to the row container
        container.appendChild(hvdbEl);
        container.appendChild(chobitEl);

        Logger.debug(`[HVDBLink] Successfully injected HVDB and Chobit links for ${rjCode}`);
    }
}
