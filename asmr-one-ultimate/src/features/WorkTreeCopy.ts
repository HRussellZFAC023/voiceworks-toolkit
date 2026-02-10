import { Logger, I18n } from '../core/Utils';
import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { EventBus } from '../core/EventBus';
import { getCleanText, getVueItem } from '../core/DomUtils';
import {
    applyCopyButtonPresentation,
    sanitizeCopyText,
    shouldSkipRootFolderItem,
    getCopyTargetItems,
    removeInjectedCopyButtons,
} from './workTreeCopyUtils';

export class WorkTreeCopy {
    private bridge: KikoeruBridge;
    private copyBtnTemplate: HTMLButtonElement;
    private flatObserver: MutationObserver | null = null;
    private cleanups: (() => void)[] = [];
    private timeoutIds = new Set<number>();
    private enabled = false;

    constructor() {
        this.bridge = KikoeruBridge.getInstance();

        // Pre-build the button template
        this.copyBtnTemplate = document.createElement('button');
        this.copyBtnTemplate.style.border = 'none';
        this.copyBtnTemplate.style.alignSelf = 'center';
        this.copyBtnTemplate.classList.add(
            ...'q-btn q-btn-item non-selectable no-outline q-btn--standard q-btn--rectangle bg-cyan shadow-4 q-mx-xs q-px-sm text-white q-btn--actionable q-btn--wrap q-btn--dense'.split(' ')
        );

        const contentSpan = document.createElement('span');
        contentSpan.className = 'q-btn__content text-center col items-center q-anchor--skip justify-center row';
        this.copyBtnTemplate.appendChild(contentSpan);

        this.copyBtnTemplate.setAttribute('data-xxcopy', 'true');
        this.refreshCopyTemplateLabel();
    }

    public enable(): void {
        if (this.enabled) return;
        this.enabled = true;
        Logger.log('[WorkTreeCopy] Enabling feature');

        // Inject on fresh renders via worktree:enhanced (fired by WorkTreeManager after every Vue render)
        this.cleanups.push(EventBus.on('worktree:enhanced', (data: { workTree: HTMLElement }) => {
            const listContainer = data.workTree.querySelector('.q-card')?.children?.[0];
            if (listContainer) this.injectButtons(listContainer as Element);
        }));

        this.cleanups.push(EventBus.on('lang:change', () => {
            this.refreshCopyTemplateLabel();
            this.refreshInjectedButtonLabels();
        }));

        // Route change: initial injection for when the page first loads
        const app = this.bridge.app;
        if (app && typeof app.$watch === 'function') {
            const unwatch = app.$watch('$route', () => {
                if (this.isWorkPage()) {
                    this.schedule(500, () => {
                        const wt = document.getElementById('work-tree');
                        const lc = wt?.querySelector('.q-card')?.children?.[0];
                        if (lc) this.injectButtons(lc as Element);
                    });
                }
            });
            this.cleanups.push(unwatch);
        }

        // Listen for flat panel open/close to inject copy buttons there too
        this.cleanups.push(EventBus.on('flatview:toggle', (data: { active: boolean }) => {
            if (data.active) {
                this.schedule(500, () => this.observeFlatPanel());
            } else {
                this.flatObserver?.disconnect();
                this.flatObserver = null;
            }
        }));

        // Initial injection for current page
        if (this.isWorkPage()) {
            this.schedule(500, () => {
                const wt = document.getElementById('work-tree');
                const lc = wt?.querySelector('.q-card')?.children?.[0];
                if (lc) this.injectButtons(lc as Element);
            });
        }
    }

    private isWorkPage(): boolean {
        const route = this.bridge.router?.currentRoute;
        return route?.name === 'work' || route?.path?.startsWith('/work/');
    }

    private injectButtons(container: Element, isFlatPanel = false): void {
        // Pause the flat-panel MutationObserver while we modify the DOM.
        // applyCopyButtonPresentation sets textContent which is a childList
        // mutation — without pausing, the observer re-fires injectButtons
        // in an infinite loop.
        const obs = this.flatObserver;
        if (obs) obs.disconnect();

        try {
            const items = getCopyTargetItems(container);
            const copyLabel = I18n.t('copyBtn');
            const allFilesLabel = I18n.t('fileListHeader');

            items.forEach((li, index) => {
                const existingButton = li.querySelector<HTMLElement>('[data-xxcopy]');

                const vueData = getVueItem(li) as Record<string, unknown> | null;
                const itemType = (vueData?.type as string | undefined) || li.dataset.itemType;
                const hash = (vueData?.hash as string | undefined) || li.dataset.asmrHash;
                const labelText = getCleanText(li.querySelector('.q-item__label') || li);

                if (shouldSkipRootFolderItem(isFlatPanel, index, itemType, !!hash, labelText, allFilesLabel)) {
                    existingButton?.remove();
                    return;
                }

                const itemTitle = this.getItemTitle(li, isFlatPanel);
                const button = existingButton || (this.copyBtnTemplate.cloneNode(true) as HTMLElement);
                applyCopyButtonPresentation(button, copyLabel, itemTitle);
                this.bindCopyHandler(button, li, isFlatPanel);

                if (!existingButton) {
                    li.appendChild(button);
                }
            });
        } finally {
            // Re-observe after our DOM mutations are done
            if (obs) {
                const body = document.querySelector('.asmr-flat-panel__body');
                if (body) obs.observe(body, { childList: true, subtree: true });
            }
        }
    }

    private bindCopyHandler(button: HTMLElement, li: HTMLElement, isFlatPanel: boolean): void {
        if (button.dataset.copyBound === '1') return;
        button.dataset.copyBound = '1';

        button.addEventListener('click', (ev) => {
            ev.stopPropagation();
            ev.preventDefault();

            const copyLabel = I18n.t('copyBtn');
            const storedTitle = button.dataset.copyTitle;
            let textToCopy = storedTitle || this.getItemTitle(li, isFlatPanel);

            if (textToCopy) {
                textToCopy = sanitizeCopyText(textToCopy, copyLabel);
                void this.copyToClipboard(textToCopy);
            }
        });
    }

    /** Extract item title - from Vue data (native tree) or DOM text (flat panel) */
    private getItemTitle(li: Element, isFlatPanel: boolean): string {
        if (!isFlatPanel) {
            // Prefer Vue component data for native tree items
            const itemData = getVueItem(li) as Record<string, unknown> | null;
            const title = (itemData?.title || itemData?.name || '') as string;
            if (title) return title;
        }

        // DOM fallback (always used for flat panel items)
        const mainLabel = li.querySelector('.q-item__label');
        const mainSection = mainLabel || li.querySelector('.q-item__section--main') || li;
        return getCleanText(mainSection);
    }

    private observeFlatPanel(): void {
        const body = document.querySelector('.asmr-flat-panel__body');
        if (!body) return;

        this.injectButtons(body, true);

        // Observe for re-renders (flat list rebuilds on work change)
        this.flatObserver?.disconnect();
        this.flatObserver = new MutationObserver(() => {
            this.injectButtons(body, true);
        });
        this.flatObserver.observe(body, { childList: true, subtree: true });
        Logger.debug('[WorkTreeCopy] Observing flat panel');
    }

    private async copyToClipboard(text: string): Promise<void> {
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
            } else if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
                const type = 'text/plain';
                const blob = new Blob([text], { type });
                const data = [new ClipboardItem({ [type]: blob })];
                await navigator.clipboard.write(data);
            } else {
                const textarea = document.createElement('textarea');
                textarea.value = text;
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                textarea.style.pointerEvents = 'none';
                document.body.appendChild(textarea);
                textarea.focus();
                textarea.select();
                const success = document.execCommand('copy');
                document.body.removeChild(textarea);
                if (!success) {
                    throw new Error('execCommand copy failed');
                }
            }

            Logger.debug('[WorkTreeCopy] Copied to clipboard:', text);
            this.bridge.notify(I18n.format('copiedNotify', { text }), 'positive');
        } catch (err) {
            Logger.error('[WorkTreeCopy] Copy failed', err);
        }
    }

    public disable(): void {
        if (!this.enabled) return;
        this.enabled = false;
        this.cleanups.forEach(fn => fn());
        this.cleanups = [];
        this.clearScheduledTasks();
        this.flatObserver?.disconnect();
        this.flatObserver = null;
        removeInjectedCopyButtons(document);
    }

    private schedule(ms: number, fn: () => void): void {
        const timeoutId = window.setTimeout(() => {
            this.timeoutIds.delete(timeoutId);
            fn();
        }, ms);
        this.timeoutIds.add(timeoutId);
    }

    private clearScheduledTasks(): void {
        for (const timeoutId of this.timeoutIds) {
            clearTimeout(timeoutId);
        }
        this.timeoutIds.clear();
    }

    private refreshCopyTemplateLabel(): void {
        const copyLabel = I18n.t('copyBtn');
        applyCopyButtonPresentation(this.copyBtnTemplate, copyLabel);
    }

    private refreshInjectedButtonLabels(): void {
        const copyLabel = I18n.t('copyBtn');
        document.querySelectorAll<HTMLElement>('[data-xxcopy]').forEach((button) => {
            const itemTitle = button.dataset.copyTitle;
            applyCopyButtonPresentation(button, copyLabel, itemTitle);
        });
    }
}
