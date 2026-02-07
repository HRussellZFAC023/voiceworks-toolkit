import { Logger, I18n } from '../core/Utils';
import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { CentralObserver } from '../core/CentralObserver';
import { EventBus } from '../core/EventBus';
import { getVueItem } from '../core/DomUtils';

export class WorkTreeCopy {
    private bridge: KikoeruBridge;
    private copyBtnTemplate: HTMLButtonElement;
    private observer: MutationObserver | null = null;
    private observedContainer: Element | null = null;
    private isObserving = false;
    private flatObserver: MutationObserver | null = null;
    private cleanups: (() => void)[] = [];

    constructor() {
        this.bridge = KikoeruBridge.getInstance();

        // Pre-build the button template
        this.copyBtnTemplate = document.createElement('button');
        this.copyBtnTemplate.style.border = 'none';
        // q-btn-dense makes it smaller to fit nicely in the list
        this.copyBtnTemplate.classList.add(
            ...'q-btn q-btn-item non-selectable no-outline q-btn--standard q-btn--rectangle bg-cyan shadow-4 q-mx-xs q-px-sm text-white q-btn--actionable q-btn--wrap q-btn--dense'.split(' ')
        );

        const contentSpan = document.createElement('span');
        contentSpan.className = 'q-btn__content text-center col items-center q-anchor--skip justify-center row';
        contentSpan.textContent = I18n.t('copyBtn');
        this.copyBtnTemplate.appendChild(contentSpan);
        this.copyBtnTemplate.ariaLabel = I18n.t('copyBtn');

        this.copyBtnTemplate.setAttribute('data-xxcopy', 'true');
    }

    public enable(): void {
        Logger.log('[WorkTreeCopy] Enabling feature');

        // Watch for route changes to re-initialize observation when entering a work page
        const app = this.bridge.app;
        if (app && typeof (app as any).$watch === 'function') {
            (app as any).$watch('$route', () => this.checkRoute());
        }

        // Also register with CentralObserver to catch re-renders
        CentralObserver.register('WorkTreeCopy', () => {
            if (this.isWorkPage()) {
                this.initObserver();
            }
        }, 1000);

        // Listen for flat panel open/close to inject copy buttons there too
        this.cleanups.push(EventBus.on('flatview:toggle', (data: { active: boolean }) => {
            if (data.active) {
                setTimeout(() => this.observeFlatPanel(), 500);
            } else {
                this.flatObserver?.disconnect();
                this.flatObserver = null;
            }
        }));

        this.checkRoute();
    }

    private checkRoute(): void {
        if (this.isWorkPage()) {
            // Give a slight delay for the DOM to settle
            setTimeout(() => this.initObserver(), 500);
        } else {
            this.disconnect();
        }
    }

    private isWorkPage(): boolean {
        const route = this.bridge.router?.currentRoute;
        return route?.name === 'work' || route?.path?.startsWith('/work/');
    }

    private initObserver(): void {
        // The user snippet targets: document.getElementById('work-tree').getElementsByClassName('q-card')[0].children[0]
        const workTree = document.getElementById('work-tree');
        if (!workTree) return;

        const card = workTree.getElementsByClassName('q-card')[0];
        if (!card) return;

        const listContainer = card.children[0];
        if (!listContainer) return;

        // Always re-inject buttons (folder navigation replaces DOM nodes)
        this.injectButtons(listContainer as Element);

        // If already observing the same container, skip re-setup
        if (this.isObserving && this.observedContainer === listContainer) return;

        Logger.debug('[WorkTreeCopy] Initializing observer on list container');

        // Disconnect existing if any
        if (this.observer) this.observer.disconnect();

        this.observer = new MutationObserver(() => {
            this.injectButtons(listContainer as Element);
        });

        this.observer.observe(listContainer, { childList: true, subtree: true });
        this.observedContainer = listContainer;
        this.isObserving = true;
    }

    private injectButtons(container: Element, isFlatPanel = false): void {
        const items = container.querySelectorAll('[role="listitem"]');

        items.forEach((li, index) => {
            // Check if we already injected
            if (li.querySelector('[data-xxcopy]')) return;

            if (!isFlatPanel) {
                // Skip "All files" root item: detect by Vue data or first-item heuristic
                const vueData = getVueItem(li) as Record<string, unknown> | null;
                if (vueData?.type === 'folder' && index === 0 && !vueData?.hash) {
                    return;
                }
                // Fallback: check label text for any language variant
                const label = li.querySelector('.q-item__label');
                if (index === 0 && label && /^All files$/i.test(label.textContent?.trim() || '')) {
                    return;
                }
            }

            const btnEle = this.copyBtnTemplate.cloneNode(true) as HTMLElement;

            // Set specific aria-label if we can determine the title
            const itemTitle = this.getItemTitle(li, isFlatPanel);
            if (itemTitle) {
                btnEle.ariaLabel = `${I18n.t('copyBtn')} ${itemTitle}`;
            }

            li.appendChild(btnEle);

            btnEle.addEventListener('click', (ev) => {
                ev.stopPropagation();
                ev.preventDefault();

                let textToCopy = this.getItemTitle(li, isFlatPanel);

                if (textToCopy) {
                    textToCopy = textToCopy.replace(I18n.t('copyBtn'), '').trim();
                    void this.copyToClipboard(textToCopy);
                }
            });
        });
    }

    /** Extract item title - from Vue data (native tree) or DOM text (flat panel) */
    private getItemTitle(li: Element, isFlatPanel: boolean): string {
        if (!isFlatPanel) {
            // Prefer Vue component data for native tree items
            const itemData = getVueItem(li) as Record<string, any> | null;
            const title = (itemData?.title || itemData?.name || '') as string;
            if (title) return title;
        }

        // DOM fallback (always used for flat panel items)
        const mainLabel = li.querySelector('.q-item__label');
        const mainSection = mainLabel || li.querySelector('.q-item__section--main');
        return mainSection?.textContent?.trim() || '';
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
        this.cleanups.forEach(fn => fn());
        this.cleanups = [];
        CentralObserver.unregister('WorkTreeCopy');
        this.disconnect();
        this.flatObserver?.disconnect();
        this.flatObserver = null;
    }

    private disconnect(): void {
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
        this.observedContainer = null;
        this.isObserving = false;
    }
}
