import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MenuIconFixer } from '../../src/features/MenuIconFixer';

let observerCallback: MutationCallback | null = null;

class FakeMutationObserver {
    observe = vi.fn();
    disconnect = vi.fn();
    takeRecords = vi.fn(() => []);
    constructor(callback: MutationCallback) {
        observerCallback = callback;
    }
}

describe('MenuIconFixer lifecycle', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div class="q-menu">
                <div class="q-item" id="existing">
                    <div class="q-item__section--avatar"><i class="q-icon">favorite</i></div>
                    <div class="q-item__label">Marked</div>
                </div>
                <div class="q-item" id="missing"><div class="q-item__label">Listening</div></div>
            </div>
        `;
        observerCallback = null;
        vi.stubGlobal('MutationObserver', FakeMutationObserver);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('restores replaced icons and removes injected icon sections on disable', () => {
        const feature = new MenuIconFixer();
        feature.enable();
        expect(document.querySelector('#existing .q-icon')?.textContent).toBe('bookmark');
        expect(document.querySelector('#missing [data-asmr-icon-injected="true"]')).not.toBeNull();

        feature.disable();

        expect(document.querySelector('#existing .q-icon')?.textContent).toBe('favorite');
        expect(document.querySelector('#missing [data-asmr-icon-injected="true"]')).toBeNull();
        expect(document.querySelector('[data-asmr-icon-original]')).toBeNull();
    });

    it('rejects a queued observer callback after disable', () => {
        const feature = new MenuIconFixer();
        feature.enable();
        const queued = observerCallback;
        feature.disable();
        document.body.insertAdjacentHTML('beforeend', `
            <div id="late" class="q-menu"><div class="q-item"><div class="q-item__label">Replay</div></div></div>
        `);
        const late = document.getElementById('late') as HTMLElement;

        queued?.([{ addedNodes: [late] } as unknown as MutationRecord], {} as MutationObserver);

        expect(late.querySelector('.q-icon')).toBeNull();
    });
});
