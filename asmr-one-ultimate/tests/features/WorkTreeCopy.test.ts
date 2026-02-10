import { beforeEach, describe, expect, it, vi } from 'vitest';

const notifyMock = vi.fn();
const getVueItemMock = vi.fn();

vi.mock('../../src/core/Utils', () => ({
    Logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    I18n: {
        t: vi.fn((key: string) => {
            if (key === 'copyBtn') return 'Copy';
            if (key === 'fileListHeader') return 'All files';
            return key;
        }),
        format: vi.fn((_key: string, params: Record<string, string>) => `Copied ${params.text}`),
    },
}));

vi.mock('../../src/infrastructure/KikoeruBridge', () => ({
    KikoeruBridge: {
        getInstance: () => ({
            router: { currentRoute: { name: 'work', path: '/work/RJ1' } },
            app: null,
            notify: notifyMock,
        }),
    },
}));

vi.mock('../../src/core/EventBus', () => ({
    EventBus: {
        on: vi.fn(() => vi.fn()),
    },
}));

vi.mock('../../src/core/DomUtils', () => ({
    getCleanText: (el: Element) => el.textContent?.trim() || '',
    getVueItem: (el: Element) => getVueItemMock(el),
}));

import { WorkTreeCopy } from '../../src/features/WorkTreeCopy';

describe('WorkTreeCopy', () => {
    beforeEach(() => {
        notifyMock.mockReset();
        getVueItemMock.mockReset();
    });

    it('removes stale copy button when row should be skipped as root folder', () => {
        const feature = new WorkTreeCopy();
        const container = document.createElement('div');
        const row = document.createElement('div');
        row.setAttribute('role', 'listitem');
        row.className = 'q-item';
        row.innerHTML = `
            <span class="q-item__label">All files</span>
            <button data-xxcopy="true"></button>
        `;
        container.appendChild(row);

        getVueItemMock.mockReturnValue({ type: 'folder' });
        (feature as any).injectButtons(container, false);

        expect(row.querySelector('[data-xxcopy]')).toBeNull();
    });

    it('updates existing copy button state instead of keeping stale metadata', () => {
        const feature = new WorkTreeCopy();
        const copySpy = vi.fn();
        (feature as any).copyToClipboard = copySpy;

        const container = document.createElement('div');
        const row = document.createElement('div');
        row.setAttribute('role', 'listitem');
        row.className = 'q-item';
        row.innerHTML = `
            <span class="q-item__label">new.mp3</span>
            <button data-xxcopy="true" data-copy-title="old.mp3" aria-label="Copy old.mp3">
                <span class="q-btn__content">Copy</span>
            </button>
        `;
        container.appendChild(row);
        const existingButton = row.querySelector('[data-xxcopy]') as HTMLElement;

        getVueItemMock.mockReturnValue({ type: 'audio', hash: 'h1', title: 'new.mp3' });
        (feature as any).injectButtons(container, false);

        const currentButton = row.querySelector('[data-xxcopy]') as HTMLElement;
        expect(currentButton).toBe(existingButton);
        expect(currentButton.dataset.copyTitle).toBe('new.mp3');
        expect(currentButton.ariaLabel).toBe('Copy new.mp3');
        expect(row.querySelectorAll('[data-xxcopy]')).toHaveLength(1);

        currentButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(copySpy).toHaveBeenCalledWith('new.mp3');
    });

    it('removes injected copy buttons when feature is disabled', () => {
        const feature = new WorkTreeCopy() as unknown as { enabled: boolean; disable: () => void };
        feature.enabled = true;

        const button = document.createElement('button');
        button.dataset.xxcopy = 'true';
        document.body.appendChild(button);
        expect(document.querySelector('[data-xxcopy]')).not.toBeNull();

        feature.disable();

        expect(document.querySelector('[data-xxcopy]')).toBeNull();
    });
});
