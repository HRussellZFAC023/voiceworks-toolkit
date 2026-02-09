import { Logger, I18n } from '../core/Utils';
import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { EventBus } from '../core/EventBus';
import { getVueItem } from '../core/DomUtils';

export class WorkTreeCopy {
    private bridge: KikoeruBridge;
    private copyBtnTemplate: HTMLButtonElement;
    private flatObserver: MutationObserver | null = null;
    private cleanups: (() => void)[] = [];

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
        contentSpan.textContent = I18n.t('copyBtn');
        this.copyBtnTemplate.appendChild(contentSpan);
        this.copyBtnTemplate.ariaLabel = I18n.t('copyBtn');

        this.copyBtnTemplate.setAttribute('data-xxcopy', 'true');
    }

    public enable(): void {
        Logger.log('[WorkTreeCopy] Enabling feature');

        // Inject on fresh renders via worktree:enhanced (fired by WorkTreeManager after every Vue render)
        this.cleanups.push(EventBus.on('worktree:enhanced', (data: { workTree: HTMLElement }) => {
            const listContainer = data.workTree.querySelector('.q-card')?.children?.[0];
            if (listContainer) this.injectButtons(listContainer as Element);
        }));

        // Route change: initial injection for when the page first loads
        const app = this.bridge.app;
        if (app && typeof (app as any).$watch === 'function') {
            (app as any).$watch('$route', () => {
                if (this.isWorkPage()) {
                    setTimeout(() => {
                        const wt = document.getElementById('work-tree');
                        const lc = wt?.querySelector('.q-card')?.children?.[0];
                        if (lc) this.injectButtons(lc as Element);
                    }, 500);
                }
            });
        }

        // Listen for flat panel open/close to inject copy buttons there too
        this.cleanups.push(EventBus.on('flatview:toggle', (data: { active: boolean }) => {
            if (data.active) {
                setTimeout(() => this.observeFlatPanel(), 500);
            } else {
                this.flatObserver?.disconnect();
                this.flatObserver = null;
            }
        }));

        // Initial injection for current page
        if (this.isWorkPage()) {
            setTimeout(() => {
                const wt = document.getElementById('work-tree');
                const lc = wt?.querySelector('.q-card')?.children?.[0];
                if (lc) this.injectButtons(lc as Element);
            }, 500);
        }
    }

    private isWorkPage(): boolean {
        const route = this.bridge.router?.currentRoute;
        return route?.name === 'work' || route?.path?.startsWith('/work/');
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
        this.flatObserver?.disconnect();
        this.flatObserver = null;
    }
}
