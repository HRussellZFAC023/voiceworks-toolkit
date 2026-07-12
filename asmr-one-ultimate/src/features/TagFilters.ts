import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { I18n } from '../core/Utils';
import { hasPlayerBar } from '../core/DomUtils';
import type { VueRoute } from '../types/store';

export class TagFilters {
    private bridge: KikoeruBridge;
    private activeFilters = new Map<string, string>();
    private overlay: HTMLElement | null = null;
    private boundHandler: (e: MouseEvent) => void;
    private storageKey = 'asmr-ult:tag-filters';
    private lastRouteTags = '';

    constructor() {
        this.bridge = KikoeruBridge.getInstance();
        this.boundHandler = (e: MouseEvent) => this.handleClick(e);
    }

    private routeUnwatch: (() => void) | null = null;

    public enable(): void {
        if (this.overlay) return; // Already enabled
        document.body.addEventListener('click', this.boundHandler as unknown as EventListener, true);
        this.injectFilterBar();
        this.restoreFilters();
        this.observeRoute();
    }

    public disable(): void {
        document.body.removeEventListener('click', this.boundHandler as unknown as EventListener, true);
        if (this.overlay) {
            this.overlay.remove();
            this.overlay = null;
        }
        this.routeUnwatch?.();
        this.routeUnwatch = null;
    }

    private handleClick(e: MouseEvent): void {
        const target = e.target as HTMLElement;
        if (!target.closest('.q-page-container')) return;

        const anchor = target.closest('a[href*="/tags/"]') as HTMLAnchorElement | null;
        const chip = target.closest('.q-chip') as HTMLElement | null;

        const tagInfo = this.extractTagInfo(anchor, chip);
        if (!tagInfo) return;

        e.preventDefault();
        e.stopPropagation();
        this.addFilter(tagInfo.id, tagInfo.label);
    }

    private extractTagInfo(anchor: HTMLAnchorElement | null, chip: HTMLElement | null): { id: string; label: string } | null {
        const href = anchor?.getAttribute('href') || '';
        const match = href.match(/\/tags\/(\d+)/);
        if (match) {
            return { id: match[1], label: (anchor?.textContent || chip?.textContent || `Tag ${match[1]}`).trim() };
        }

        if (chip) {
            const dataId = chip.getAttribute('data-tag-id') || chip.getAttribute('data-id');
            if (dataId) {
                return { id: dataId, label: (chip.textContent || `Tag ${dataId}`).trim() };
            }
        }

        return null;
    }

    private addFilter(tagId: string, label: string): void {
        if (this.activeFilters.has(tagId)) return;
        this.activeFilters.set(tagId, label);
        this.updateSearch();
        this.renderUI();
        this.persistFilters();
    }

    public removeFilter(tagId: string): void {
        this.activeFilters.delete(tagId);
        this.updateSearch();
        this.renderUI();
        this.persistFilters();
    }

    private updateSearch(): void {
        const store = this.bridge.store;
        const tags = Array.from(this.activeFilters.keys());
        const router = this.bridge.router;
        const currentRoute = router?.currentRoute;

        if (router) {
            const query = { ...(currentRoute?.query || {}) } as Record<string, string | string[] | undefined>;
            if (tags.length) {
                query.tags = tags.join(',');
            } else {
                delete query.tags;
            }

            const onWorks = currentRoute?.path === '/works';
            const tagsMatch = String(currentRoute?.query?.tags || '') === String(query.tags || '');
            if (!onWorks || !tagsMatch) {
                router.push({ path: '/works', query }).catch(() => undefined);
            }
        }

        if (store?.dispatch) {
            const existing = store.state?.Works?.searchParams || {};
            const payload: Record<string, unknown> = { ...existing, tags };
            if (tags.length === 1) {
                payload.tag_id = tags[0];
            } else if ('tag_id' in payload) {
                delete payload.tag_id;
            }
            store.dispatch('Works/search', payload);
        }
    }

    private renderUI(): void {
        if (!this.overlay) return;

        if (this.activeFilters.size === 0) {
            this.overlay.style.display = 'none';
            return;
        }

        this.overlay.style.display = 'flex';
        this.overlay.innerHTML = '';

        const playerBarVisible = hasPlayerBar();
        this.overlay.style.bottom = playerBarVisible ? '72px' : '12px';

        const label = document.createElement('div');
        label.className = 'text-caption q-mr-sm self-center';
        label.textContent = I18n.format('filtersLabel', { count: this.activeFilters.size });
        this.overlay.appendChild(label);

        for (const [id, name] of this.activeFilters.entries()) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'q-chip row inline no-wrap items-center q-chip--dense bg-primary text-white';
            chip.ariaLabel = I18n.format('filtersRemove', { name }) || `Remove filter: ${name}`;
            const content = document.createElement('span');
            content.className = 'q-chip__content col row no-wrap items-center';
            content.textContent = name;
            const icon = document.createElement('i');
            icon.className = 'q-icon material-icons q-chip__icon q-chip__icon--remove';
            icon.setAttribute('aria-hidden', 'true');
            icon.textContent = 'cancel';
            chip.append(content, icon);
            chip.addEventListener('click', () => this.removeFilter(id));
            this.overlay.appendChild(chip);
        }

        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'q-btn q-btn-dense q-btn-flat text-negative';
        clearBtn.ariaLabel = I18n.t('filtersClear');
        clearBtn.textContent = I18n.t('filtersClear');
        clearBtn.addEventListener('click', () => {
            this.activeFilters.clear();
            this.updateSearch();
            this.renderUI();
            this.persistFilters();
        });
        this.overlay.appendChild(clearBtn);
    }

    private injectFilterBar(): void {
        if (this.overlay) return;
        const div = document.createElement('div');
        div.className = 'asmr-filter-overlay q-banner row items-center q-gutter-sm shadow-2';
        document.body.appendChild(div);
        this.overlay = div;
    }

    private persistFilters(): void {
        try {
            const payload = Array.from(this.activeFilters.entries()).map(([id, label]) => ({ id, label }));
            sessionStorage.setItem(this.storageKey, JSON.stringify(payload));
        } catch {
            // Ignore storage errors.
        }
    }

    private restoreFilters(): void {
        const stored = this.loadStoredFilters();
        const route = this.bridge.router?.currentRoute;
        const routeTags = this.parseRouteTags(route?.query?.tags);
        if (routeTags.length) {
            this.activeFilters.clear();
            routeTags.forEach((id) => {
                const label = stored.get(id) || `Tag ${id}`;
                this.activeFilters.set(id, label);
            });
            this.lastRouteTags = routeTags.join(',');
        } else if (stored.size) {
            this.activeFilters = stored;
        }

        if (this.activeFilters.size) {
            this.renderUI();
        }
    }

    private observeRoute(): void {
        const app = this.bridge.app;
        if (!app?.$watch) return;
        this.routeUnwatch = app.$watch('$route', (to: VueRoute) => this.syncFromRoute(to));
        this.syncFromRoute(app.$route);
    }

    private syncFromRoute(route: VueRoute | undefined): void {
        const tags = this.parseRouteTags(route?.query?.tags);
        const signature = tags.join(',');
        if (signature === this.lastRouteTags) return;
        this.lastRouteTags = signature;

        if (tags.length === 0) {
            if (this.activeFilters.size > 0) {
                this.activeFilters.clear();
                this.renderUI();
                this.persistFilters();
            }
            return;
        }

        const stored = this.loadStoredFilters();
        this.activeFilters.clear();
        tags.forEach((id) => {
            const label = stored.get(id) || `Tag ${id}`;
            this.activeFilters.set(id, label);
        });
        this.renderUI();
        this.persistFilters();
    }

    private loadStoredFilters(): Map<string, string> {
        try {
            const raw = sessionStorage.getItem(this.storageKey) || '[]';
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return new Map();
            const map = new Map<string, string>();
            parsed.forEach((entry: { id?: string; label?: string }) => {
                if (!entry?.id) return;
                map.set(String(entry.id), String(entry.label || `Tag ${entry.id}`));
            });
            return map;
        } catch {
            return new Map();
        }
    }

    private parseRouteTags(tagsParam: string | string[] | undefined): string[] {
        const raw = typeof tagsParam === 'string' ? tagsParam : (Array.isArray(tagsParam) ? tagsParam[0] || '' : '');
        if (!raw) return [];
        return raw.split(',').map((t) => t.trim()).filter(Boolean);
    }
}
