import { GM_getValue, GM_setValue } from '$';
import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { Logger, I18n } from '../core/Utils';
import { CentralObserver } from '../core/CentralObserver';
import { HeaderActions } from '../ui/HeaderActions';
import { TranslatedTags } from './TranslatedTags';
import { RadioMode } from './radio';
import { MetadataApi, PlaylistApi, WorkOrder, HistoryApi } from '../api';
import { VAEntry, CircleEntry, TagEntry } from '../types/api';
import { EventBus } from '../core/EventBus';
import { TranslationService } from '../services/TranslationService';
import { AppStore } from '../store/AppStore';
import { RouteStateSync } from './RouteStateSync';
import { getAxios } from '../api/Client';

// Sort options for Advanced Search (merged with host options if present)
const FALLBACK_SORT_OPTIONS: { value: WorkOrder; labelKey: string }[] = [
    { value: 'insert_time', labelKey: 'sortNewest' },
    { value: 'release', labelKey: 'sortRelease' },
    { value: 'id', labelKey: 'sortRJCode' },
    { value: 'nsfw', labelKey: 'sortNSFW' },
    { value: 'rate_average_2dp', labelKey: 'sortDlsiteRating' },
    { value: 'dl_count', labelKey: 'sortDownloads' },
    { value: 'rating', labelKey: 'sortRating' },
    { value: 'review_count', labelKey: 'sortReviews' },
    { value: 'price', labelKey: 'sortPrice' },
    { value: 'random', labelKey: 'sortRandom' },
];

const SORT_OPTIONS_CACHE_KEY = 'asmrSortOptions';
const getSortOptionsCacheKey = () => `${SORT_OPTIONS_CACHE_KEY}:${I18n.lang}`;

export class AdvancedSearch {
    private bridge: KikoeruBridge;
    private dialog: HTMLElement | null = null;
    private englishTags: TranslatedTags;

    // Tag selection state
    private selectedIncludes: TagEntry[] = [];
    private selectedExcludes: TagEntry[] = [];

    // VA/Circle selection state
    private selectedVA: VAEntry | null = null;
    private selectedCircle: CircleEntry | null = null;
    private vaList: VAEntry[] = [];
    private circleList: CircleEntry[] = [];

    // Sort state
    private sortOrder: WorkOrder = 'insert_time';
    private sortDirection: 'desc' | 'asc' = 'desc';

    // UI state
    private generating = false;
    private isBuilding = false;
    private cancelRequested = false;
    private statusEl: HTMLElement | null = null;
    private langCleanup: (() => void) | null = null;
    private boundKeyHandler: ((e: KeyboardEvent) => void) | null = null;

    constructor() {
        this.bridge = KikoeruBridge.getInstance();
        this.englishTags = TranslatedTags.getInstance();
    }

    public enable(): void {
        CentralObserver.register('AdvancedSearch', () => this.attachButton(), 500);
        this.attachButton();
        // Pre-fetch metadata in background so it's ready when clicked
        void this.loadMetadataLists();
        if (!this.langCleanup) {
            this.langCleanup = EventBus.on('lang:change', () => this.handleLangChange());
        }
    }

    private attachButton(): void {
        const header = HeaderActions.ensure();
        if (!header || header.querySelector('.asmr-playlist-btn')) return;

        const btn = document.createElement('button');
        btn.className = 'q-btn q-btn-flat q-btn-dense asmr-playlist-btn text-white';
        btn.innerHTML = '<span class="q-btn__content"><i class="q-icon material-icons" aria-hidden="true">playlist_add</i></span>';
        btn.title = I18n.t('advSearchBtn');
        btn.ariaLabel = I18n.t('advSearchBtn');
        btn.onclick = () => this.open();
        header.appendChild(btn);
    }

    public async open(): Promise<void> {
        if (this.isBuilding) return;

        if (!this.dialog) {
            this.isBuilding = true;
            try {
                // buildDialog is now synchronous for UI creation
                this.buildDialogSync();
            } finally {
                this.isBuilding = false;
            }
        }
        if (this.dialog) {
            this.dialog.style.display = 'flex';
            this.refreshSortUi();
            this.renderTags();
            this.renderSelectedVA();
            this.renderSelectedCircle();
        }
    }

    private removeKeyHandler(): void {
        if (this.boundKeyHandler) {
            document.removeEventListener('keydown', this.boundKeyHandler);
            this.boundKeyHandler = null;
        }
    }

    private handleLangChange(): void {
        if (!this.dialog) return;
        const isOpen = this.dialog.style.display !== 'none';
        const snapshot = this.captureDialogState();
        this.removeKeyHandler();
        this.dialog.remove();
        this.dialog = null;
        this.buildDialogSync();
        this.applyDialogState(snapshot);
        const dialog = (this as any).dialog;
        if (dialog) {
            dialog.style.display = isOpen ? 'flex' : 'none';
            if (isOpen) {
                this.renderTags();
                this.renderSelectedVA();
                this.renderSelectedCircle();
            }
        }
    }

    private captureDialogState(): {
        min?: string;
        max?: string;
        rating?: string;
        price?: string;
        sales?: string;
        worksCount?: string;
        includeFilter?: string;
        excludeFilter?: string;
        vaFilter?: string;
        circleFilter?: string;
        language?: string;
    } {
        if (!this.dialog) return {};
        const read = (selector: string) => (this.dialog!.querySelector(selector) as HTMLInputElement | null)?.value;
        const language = (this.dialog.querySelector('.asmr-language') as HTMLSelectElement | null)?.value;
        return {
            min: read('.asmr-min'),
            max: read('.asmr-max'),
            rating: read('.asmr-rate-min'),
            price: read('.asmr-price-min'),
            sales: read('.asmr-sell-min'),
            worksCount: read('.asmr-works-count'),
            includeFilter: read('.asmr-include-filter'),
            excludeFilter: read('.asmr-exclude-filter'),
            vaFilter: read('.asmr-va-filter'),
            circleFilter: read('.asmr-circle-filter'),
            language,
        };
    }

    private applyDialogState(state: {
        min?: string;
        max?: string;
        rating?: string;
        price?: string;
        sales?: string;
        worksCount?: string;
        includeFilter?: string;
        excludeFilter?: string;
        vaFilter?: string;
        circleFilter?: string;
        language?: string;
    }): void {
        if (!this.dialog) return;
        const write = (selector: string, value?: string) => {
            const el = this.dialog!.querySelector(selector) as HTMLInputElement | null;
            if (el && value != null) el.value = value;
        };
        write('.asmr-min', state.min);
        write('.asmr-max', state.max);
        write('.asmr-rate-min', state.rating);
        write('.asmr-price-min', state.price);
        write('.asmr-sell-min', state.sales);
        write('.asmr-works-count', state.worksCount);
        write('.asmr-include-filter', state.includeFilter);
        write('.asmr-exclude-filter', state.excludeFilter);
        write('.asmr-va-filter', state.vaFilter);
        write('.asmr-circle-filter', state.circleFilter);
        const language = this.dialog.querySelector('.asmr-language') as HTMLSelectElement | null;
        if (language && state.language != null) {
            language.value = state.language;
        }
        const card = this.dialog.querySelector('.asmr-advanced-search-dialog') as HTMLElement | null;
        if (card) {
            this.updatePresetButtons(card, state.min || '', state.max || '');
        }
    }

    private syncHostSortOption(): void {
        const hostOptions = this.getHostSortOptions();
        const availableOptions = hostOptions.length
            ? hostOptions
            : this.getFallbackSortOptions();
        const resolvedOrder = this.resolveSortOrder(this.sortOrder, availableOptions);

        // Update local state
        this.sortOrder = resolvedOrder as WorkOrder;

        // Use AppStore for search state - source of truth for RouteStateSync
        AppStore.setSearchState({
            pendingOrder: resolvedOrder,
            pendingSort: this.sortDirection
        });

        // Persist for legacy compatibility
        const newSortOption = { label: this.getSortLabel(resolvedOrder), order: resolvedOrder, sort: this.sortDirection };
        try { localStorage.setItem('sortOption', JSON.stringify(newSortOption)); } catch { /* ignore */ }

        // Immediately update visual display for the host background dropdown
        try {
            const sync = RouteStateSync.getInstance();
            sync.syncDisplayToHost(sync.getSortLabel(resolvedOrder, this.sortDirection));
        } catch (e) {
            Logger.warn('[AdvancedSearch] Failed to sync host display:', e);
        }

        // Apply to current component if we are already on the works page
        const worksVm = this.findWorksComponent();
        if (worksVm) {
            this.applySortToWorksVm(worksVm, newSortOption);
        }
    }

    private close(): void {
        if (this.dialog) this.dialog.style.display = 'none';
    }

    private buildDialogSync(): void {
        const overlay = document.createElement('div');
        overlay.className = 'q-dialog fullscreen flex-center asmr-dialog-overlay';

        const card = document.createElement('div');
        card.className = 'q-card asmr-advanced-search-dialog';

        card.innerHTML = `
            <!-- Header -->
            <div class="asmr-dialog-header">
                <h2>${I18n.t('advSearch')}</h2>
                <button class="q-btn q-btn-flat q-btn-round q-btn-dense asmr-close-btn text-grey-7" aria-label="${I18n.t('cancel') || 'Close'}">
                    <span class="q-btn__content">
                        <i class="material-icons" aria-hidden="true">close</i>
                    </span>
                </button>
            </div>

            <!-- Body -->
            <div class="asmr-dialog-body">
                <!-- Row 1: Tags (Include/Exclude) -->
                <div class="asmr-form-row">
                    <div class="asmr-form-group">
                        <label class="asmr-form-label" for="adv-include-tags">${I18n.t('advIncludeTags')}</label>
                        <input type="text" id="adv-include-tags" class="asmr-filter-input asmr-include-filter" placeholder="${I18n.t('advFilterTags')}"/>
                        <select multiple size="6" class="asmr-include-select" aria-label="${I18n.t('advIncludeTags')}"></select>
                        <div class="asmr-chips-container asmr-chips-include" aria-live="polite"></div>
                    </div>
                    <div class="asmr-form-group">
                        <label class="asmr-form-label" for="adv-exclude-tags">${I18n.t('advExcludeTags')}</label>
                        <input type="text" id="adv-exclude-tags" class="asmr-filter-input asmr-exclude-filter" placeholder="${I18n.t('advFilterTags')}"/>
                        <select multiple size="6" class="asmr-exclude-select" aria-label="${I18n.t('advExcludeTags')}"></select>
                        <div class="asmr-chips-container asmr-chips-exclude" aria-live="polite"></div>
                    </div>
                </div>

                <div class="asmr-separator"></div>

                <!-- Row 2: VA and Circle -->
                <div class="asmr-form-row">
                    <div class="asmr-form-group">
                        <label class="asmr-form-label" for="adv-va-filter">${I18n.t('advVoiceActor')}</label>
                        <input type="text" id="adv-va-filter" class="asmr-filter-input asmr-va-filter" placeholder="${I18n.t('advSearchVA')}"/>
                        <select size="5" class="asmr-va-select" aria-label="${I18n.t('advVoiceActor')}"></select>
                        <div class="asmr-selected-va" aria-live="polite"></div>
                    </div>
                    <div class="asmr-form-group">
                        <label class="asmr-form-label" for="adv-circle-filter">${I18n.t('advCircle')}</label>
                        <input type="text" id="adv-circle-filter" class="asmr-filter-input asmr-circle-filter" placeholder="${I18n.t('advSearchCircle')}"/>
                        <select size="5" class="asmr-circle-select" aria-label="${I18n.t('advCircle')}"></select>
                        <div class="asmr-selected-circle" aria-live="polite"></div>
                    </div>
                </div>

                <div class="asmr-separator"></div>

                <!-- Row 3: Duration and Sort -->
                <div class="asmr-form-row">
                    <div class="asmr-form-group">
                        <label class="asmr-form-label" for="adv-min-duration">${I18n.t('advDuration')}</label>
                        <div class="asmr-duration-row">
                            <input type="number" id="adv-min-duration" class="asmr-filter-input asmr-min" placeholder="${I18n.t('advMinPlaceholder')}" min="0" aria-label="${I18n.t('advMinDurationAria')}"/>
                            <span class="asmr-duration-separator" aria-hidden="true">-</span>
                            <input type="number" class="asmr-filter-input asmr-max" placeholder="${I18n.t('advMaxPlaceholder')}" min="0" aria-label="${I18n.t('advMaxDurationAria')}"/>
                            <div class="asmr-presets-group">
                                <button class="asmr-preset-btn asmr-preset-short" title="${I18n.t('advPresetShortTitle')}" aria-label="${I18n.t('advPresetShortAria')}">${I18n.t('advShort')}</button>
                                <button class="asmr-preset-btn asmr-preset-medium" title="${I18n.t('advPresetMediumTitle')}" aria-label="${I18n.t('advPresetMediumAria')}">${I18n.t('advMedium')}</button>
                                <button class="asmr-preset-btn asmr-preset-long" title="${I18n.t('advPresetLongTitle')}" aria-label="${I18n.t('advPresetLongAria')}">${I18n.t('advLong')}</button>
                            </div>
                        </div>
                    </div>
                    <div class="asmr-form-group">
                        <label class="asmr-form-label" for="adv-sort-order">${I18n.t('advSortBy')}</label>
                        <select id="adv-sort-order" class="asmr-sort-select asmr-sort-order"></select>
                        <div class="asmr-sort-direction">
                            <button class="asmr-sort-dir-btn asmr-sort-desc active" aria-label="${I18n.t('advSortDescAria')}">${I18n.t('advDesc')}</button>
                            <button class="asmr-sort-dir-btn asmr-sort-asc" aria-label="${I18n.t('advSortAscAria')}">${I18n.t('advAsc')}</button>
                        </div>
                    </div>
                </div>

                <div class="asmr-separator"></div>

                <!-- Row 4: Rating, Price, Sales -->
                <div class="asmr-form-row asmr-form-row-3">
                    <div class="asmr-form-group">
                        <label class="asmr-form-label" for="adv-min-rating">${I18n.t('advMinRating')}</label>
                        <input type="number" id="adv-min-rating" class="asmr-filter-input asmr-rate-min" placeholder="${I18n.t('advMinRatingPlaceholder')}" min="0" max="5" step="0.1"/>
                    </div>
                    <div class="asmr-form-group">
                        <label class="asmr-form-label" for="adv-min-price">${I18n.t('advMinPrice')}</label>
                        <input type="number" id="adv-min-price" class="asmr-filter-input asmr-price-min" placeholder="${I18n.t('advMinPricePlaceholder')}" min="0"/>
                    </div>
                    <div class="asmr-form-group">
                        <label class="asmr-form-label" for="adv-min-sales">${I18n.t('advMinSales')}</label>
                        <input type="number" id="adv-min-sales" class="asmr-filter-input asmr-sell-min" placeholder="${I18n.t('advMinSalesPlaceholder')}" min="0"/>
                    </div>
                </div>

                <div class="asmr-separator"></div>

                <!-- Row 5: Age Rating and Language -->
                <div class="asmr-form-row">
                    <div class="asmr-form-group">
                        <label class="asmr-form-label" for="adv-age-rating">${I18n.t('advAgeRating')}</label>
                        <select id="adv-age-rating" class="asmr-sort-select asmr-age-rating">
                            <option value="">${I18n.t('advAny')}</option>
                            <option value="general">${I18n.t('advAllAges')}</option>
                            <option value="r15">R-15</option>
                            <option value="adult">${I18n.t('advAdult')}</option>
                        </select>
                    </div>
                    <div class="asmr-form-group">
                        <label class="asmr-form-label" for="adv-language">${I18n.t('advLanguage')}</label>
                        <select id="adv-language" class="asmr-sort-select asmr-language">
                            <option value="">${I18n.t('advAny')}</option>
                            <option value="ja">${I18n.t('advLangJa')}</option>
                            <option value="en">${I18n.t('advLangEn')}</option>
                            <option value="ko">${I18n.t('advLangKo')}</option>
                            <option value="zh-cn">${I18n.t('advLangZhCn')}</option>
                            <option value="zh-tw">${I18n.t('advLangZhTw')}</option>
                        </select>
                    </div>
                </div>

                <!-- Results Container (hidden by default) -->
                <div class="asmr-results-container asmr-vector-result-list" style="display: none;"></div>
            </div>

            <!-- Footer -->
            <div class="asmr-dialog-footer">
                <div class="asmr-status-text" aria-live="polite"></div>
                <div class="asmr-actions">
                    <div class="asmr-works-count-group">
                        <label for="adv-works-count">${I18n.t('advWorks')}</label>
                        <input type="number" id="adv-works-count" class="asmr-filter-input asmr-works-count" value="10" min="1" max="100"/>
                    </div>
                    <button class="asmr-btn asmr-btn-primary asmr-search-btn">${I18n.t('advSearchAction')}</button>
                    <button class="asmr-btn asmr-btn-secondary asmr-create-playlist-btn">${I18n.t('advCreatePlaylist')}</button>
                </div>
            </div>
        `;

        overlay.appendChild(card);
        document.body.appendChild(overlay);
        this.dialog = overlay;
        this.statusEl = card.querySelector('.asmr-status-text') as HTMLElement | null;

        this.refreshSortUi(card);

        // Bind Events
        this.bindEvents(card);

        // Load metadata if not already loaded
        void this.loadMetadataLists().then(() => {
            this.repopulateTagSelects();
            this.repopulateVASelect();
            this.repopulateCircleSelect();
        });
    }

    private bindEvents(card: HTMLElement): void {
        // Close button
        card.querySelector('.asmr-close-btn')?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            Logger.log('[AdvancedSearch] Close button clicked');
            if (this.generating) {
                Logger.log('[AdvancedSearch] Cancelling generation');
                this.cancelRequested = true;
            }
            this.close();
        });

        // Overlay click to close
        this.dialog?.addEventListener('click', (e) => {
            if (e.target === this.dialog) this.close();
        });

        // Enter key to search, Escape to close
        this.removeKeyHandler();
        this.boundKeyHandler = (e: KeyboardEvent) => {
            if (this.dialog?.style.display === 'none') return;

            if (e.key === 'Escape') {
                e.preventDefault();
                if (this.generating) {
                    this.cancelRequested = true;
                }
                this.close();
            } else if (e.key === 'Enter') {
                // Only trigger search if not in a textarea or if ctrl is pressed
                const target = e.target as HTMLElement;
                if (target.tagName !== 'TEXTAREA' && target.tagName !== 'SELECT') {
                    e.preventDefault();
                    this.performSearch();
                }
            }
        };
        document.addEventListener('keydown', this.boundKeyHandler);

        // Tag selects
        this.bindTagSelects(card);

        // VA select
        this.bindVASelect(card);

        // Circle select
        this.bindCircleSelect(card);

        // Duration presets
        const setDuration = (min: string, max: string) => {
            (card.querySelector('.asmr-min') as HTMLInputElement).value = min;
            (card.querySelector('.asmr-max') as HTMLInputElement).value = max;
            this.updatePresetButtons(card, min, max);
        };

        card.querySelector('.asmr-preset-short')?.addEventListener('click', () => setDuration('0', '30'));
        card.querySelector('.asmr-preset-medium')?.addEventListener('click', () => setDuration('30', '120'));
        card.querySelector('.asmr-preset-long')?.addEventListener('click', () => setDuration('120', ''));

        // Sort order
        card.querySelector('.asmr-sort-order')?.addEventListener('change', (e) => {
            this.sortOrder = (e.target as HTMLSelectElement).value as WorkOrder;
            this.syncHostSortOption();
        });

        // Sort direction
        card.querySelector('.asmr-sort-desc')?.addEventListener('click', () => {
            this.sortDirection = 'desc';
            card.querySelector('.asmr-sort-desc')?.classList.add('active');
            card.querySelector('.asmr-sort-asc')?.classList.remove('active');
            this.syncHostSortOption();
        });
        card.querySelector('.asmr-sort-asc')?.addEventListener('click', () => {
            this.sortDirection = 'asc';
            card.querySelector('.asmr-sort-asc')?.classList.add('active');
            card.querySelector('.asmr-sort-desc')?.classList.remove('active');
            this.syncHostSortOption();
        });

        // Action buttons
        card.querySelector('.asmr-search-btn')?.addEventListener('click', () => this.performSearch());
        card.querySelector('.asmr-create-playlist-btn')?.addEventListener('click', () => this.createPlaylist());
    }

    private updatePresetButtons(card: HTMLElement, min: string, max: string): void {
        const buttons = card.querySelectorAll('.asmr-preset-btn');
        buttons.forEach(btn => btn.classList.remove('active'));

        if (min === '0' && max === '30') {
            card.querySelector('.asmr-preset-short')?.classList.add('active');
        } else if (min === '30' && max === '120') {
            card.querySelector('.asmr-preset-medium')?.classList.add('active');
        } else if (min === '120' && max === '') {
            card.querySelector('.asmr-preset-long')?.classList.add('active');
        }
    }

    private refreshSortUi(card?: HTMLElement): void {
        I18n.syncFromHost();
        const targetCard = card || (this.dialog?.querySelector('.asmr-advanced-search-dialog') as HTMLElement | null);
        if (!targetCard) return;
        this.syncSortStateFromHost();
        this.populateSortOptions(targetCard);
        this.applySortDirectionUi(targetCard);
    }

    private syncSortStateFromHost(): void {
        // Priority 1: AppStore (active search session)
        const searchState = AppStore.state.search;
        if (searchState.pendingOrder) {
            this.sortOrder = searchState.pendingOrder as WorkOrder;
            if (searchState.pendingSort) this.sortDirection = searchState.pendingSort;
            return;
        }

        // Priority 2: Stored option
        const stored = this.readStoredSortOption();
        if (stored?.order) {
            this.sortOrder = stored.order as WorkOrder;
            this.sortDirection = stored.sort;
            return;
        }

        // Priority 3: Host component
        const vm = this.findWorksComponent();
        const current = vm?.sortOption as { order?: WorkOrder; sort?: 'asc' | 'desc' } | undefined;
        if (current?.order) {
            this.sortOrder = current.order;
            if (current.sort) this.sortDirection = current.sort;
        }
    }

    private readStoredSortOption(): { order: WorkOrder; sort: 'asc' | 'desc' } | null {
        try {
            const stored = localStorage.getItem('sortOption');
            if (!stored) return null;
            const parsed = JSON.parse(stored);
            if (parsed?.order && parsed?.sort) {
                return { order: parsed.order as WorkOrder, sort: parsed.sort as 'asc' | 'desc' };
            }
        } catch {
            // Ignore malformed storage
        }
        return null;
    }

    private findWorksComponent(): any | null {
        return this.findWorksViaDom() || this.bridge.findComponent((c: any) =>
            c.sortOption != null && typeof c.sortOption?.order === 'string' && Array.isArray(c.options)
        );
    }

    private findWorksViaDom(): any | null {
        const inputs = Array.from(document.querySelectorAll('input[role="combobox"]'));
        for (const el of inputs) {
            let current: HTMLElement | null = el as HTMLElement;
            for (let i = 0; i < 20 && current; i++) {
                let vue = (current as any).__vue__ as any | undefined;
                for (let v = 0; v < 5 && vue; v++) {
                    if (vue.sortOption && typeof vue.sortOption?.order === 'string' && Array.isArray(vue.options)) {
                        return vue;
                    }
                    vue = vue.$parent;
                }
                current = current.parentElement;
            }
        }
        return null;
    }

    private getHostSortOptions(): Array<{ label: string; order: string; sort: string }> {
        const vm = this.findWorksComponent();
        if (vm && Array.isArray(vm.options)) {
            const options = vm.options as Array<{ label: string; order: string; sort: string }>;
            if (this.shouldIgnoreHostLabels(options.map(opt => opt.label))) {
                return [];
            }
            this.cacheHostSortOptions(options);
            return options;
        }
        return this.readCachedSortOptions();
    }

    private cacheHostSortOptions(options: Array<{ label: string; order: string; sort: string }>): void {
        try {
            const sanitized = options
                .filter(opt => opt && typeof opt.order === 'string' && typeof opt.label === 'string')
                .map(opt => ({ label: opt.label, order: opt.order, sort: opt.sort }));
            if (sanitized.length) {
                GM_setValue(getSortOptionsCacheKey(), sanitized);
            }
        } catch {
            // Ignore storage issues
        }
    }

    private readCachedSortOptions(): Array<{ label: string; order: string; sort: string }> {
        try {
            const cached = GM_getValue(getSortOptionsCacheKey(), null);
            if (!cached) return [];
            const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
            if (!Array.isArray(parsed)) return [];
            const options = parsed.filter((opt: any) =>
                opt && typeof opt.order === 'string' && typeof opt.label === 'string'
            );
            if (this.shouldIgnoreHostLabels(options.map((opt: any) => opt.label))) {
                return [];
            }
            return options;
        } catch {
            return [];
        }
    }

    private shouldIgnoreHostLabels(labels: string[]): boolean {
        if (I18n.lang !== 'en') return false;
        return labels.some(label => /[\u3040-\u30ff\u4e00-\u9faf]/.test(label));
    }

    private getFallbackSortOptions(): Array<{ label: string; order: string }> {
        return FALLBACK_SORT_OPTIONS.map(opt => ({
            order: opt.value,
            label: I18n.t(opt.labelKey),
        }));
    }

    private resolveSortOrder(order: string, options: Array<{ order: string }>): string {
        if (options.some(o => o.order === order)) return order;
        if (order === 'create_date' && options.some(o => o.order === 'insert_time')) return 'insert_time';
        if (order === 'insert_time' && options.some(o => o.order === 'create_date')) return 'create_date';
        return order;
    }

    private getSortLabel(order: string): string {
        const hostOptions = this.getHostSortOptions();
        if (hostOptions.length) {
            return hostOptions.find(o => o.order === order)?.label || order;
        }
        const fallback = FALLBACK_SORT_OPTIONS.find(o => o.value === order);
        return fallback ? I18n.t(fallback.labelKey) : order;
    }

    private populateSortOptions(card: HTMLElement): void {
        const select = card.querySelector('.asmr-sort-order') as HTMLSelectElement | null;
        if (!select) return;
        const hostOptions = this.getHostSortOptions();
        const mergedOptions = hostOptions.length
            ? hostOptions.map(opt => ({ order: opt.order, label: opt.label }))
            : [];
        const fallbackOptions = this.getFallbackSortOptions();
        fallbackOptions.forEach(opt => {
            if (!mergedOptions.some(existing => existing.order === opt.order)) {
                mergedOptions.push(opt);
            }
        });
        const options = mergedOptions.length ? mergedOptions : fallbackOptions;

        select.innerHTML = options.map(opt => `<option value="${opt.order}">${opt.label}</option>`).join('');
        const resolvedOrder = this.resolveSortOrder(this.sortOrder, options);
        this.sortOrder = resolvedOrder as WorkOrder;
        select.value = resolvedOrder;
    }

    private applySortDirectionUi(card: HTMLElement): void {
        const descBtn = card.querySelector('.asmr-sort-desc');
        const ascBtn = card.querySelector('.asmr-sort-asc');
        if (!descBtn || !ascBtn) return;
        if (this.sortDirection === 'asc') {
            ascBtn.classList.add('active');
            descBtn.classList.remove('active');
        } else {
            descBtn.classList.add('active');
            ascBtn.classList.remove('active');
        }
    }

    // Translation cache for VAs/Circles (name → English)
    private translationCache = new Map<string, string>();

    private looksTranslatable(text: string): boolean {
        return /[\u3040-\u30ff\u4e00-\u9faf\uac00-\ud7af]/.test(text);
    }

    private metadataLoadingPromise: Promise<void> | null = null;

    private async loadMetadataLists(): Promise<void> {
        if (this.metadataLoadingPromise) return this.metadataLoadingPromise;

        this.metadataLoadingPromise = (async () => {
            try {
                const [vas, circles, apiTags] = await Promise.all([
                    MetadataApi.getVAList(),
                    MetadataApi.getCircleList(),
                    MetadataApi.getTagList(),
                ]);

                // Ensure we have arrays before sorting
                const vaArray = Array.isArray(vas) ? vas : [];
                const circlesArray = Array.isArray(circles) ? circles : [];
                const apiTagsArray = Array.isArray(apiTags) ? apiTags : [];

                // Sort VAs/Circles by count (popularity) descending
                this.vaList = vaArray.sort((a, b) => (b.count || 0) - (a.count || 0));
                this.circleList = circlesArray.sort((a, b) => (b.count || 0) - (a.count || 0));

                // === TAGS ===
                // Always use API tags as primary source (has the complete list with counts).
                // Merge translations from TranslatedTags when available.
                let englishTagsList = this.englishTags.getTagList();

                // Build translation map from TranslatedTags (id → en)
                const enMap = new Map<number, string>();
                englishTagsList.forEach(t => {
                    if (t.en) enMap.set(t.id, t.en);
                });

                // Use API tags as base, merge English translations
                this.tagList = apiTagsArray.map(t => {
                    const id = typeof t.id === 'string' ? parseInt(t.id, 10) : (t.id as number);
                    return {
                        id,
                        name: t.name,
                        ja: t.name,
                        en: enMap.get(id) || '',
                        count: t.count || 0,
                    };
                }).sort((a, b) => (b.count || 0) - (a.count || 0));

                // Start background translation for tags without translations
                this.translateInBackground(
                    this.tagList.filter(t => !t.en && this.looksTranslatable(t.ja || t.name)),
                    (item, en) => { item.en = en; },
                    () => this.repopulateTagSelects()
                );

                // Start background translation for VAs and Circles
                this.translateInBackground(
                    this.vaList.filter(v => this.looksTranslatable(v.name)),
                    (item, en) => { this.translationCache.set(item.name, en); },
                    () => this.repopulateVASelect()
                );
                this.translateInBackground(
                    this.circleList.filter(c => this.looksTranslatable(c.name)),
                    (item, en) => { this.translationCache.set(item.name, en); },
                    () => this.repopulateCircleSelect()
                );

                Logger.log('[AdvancedSearch] Metadata loaded:', vaArray.length, 'VAs,', circlesArray.length, 'circles, and', this.tagList.length, 'tags');
            } catch (e) {
                Logger.warn('[AdvancedSearch] Failed to load metadata lists:', e);
                this.metadataLoadingPromise = null; // Allow retry on failure
            }
        })();

        return this.metadataLoadingPromise;
    }

    private async translateInBackground<T extends { name?: string; ja?: string }>(
        items: T[],
        applyFn: (item: T, en: string) => void,
        refreshFn: () => void,
    ): Promise<void> {
        const BATCH_SIZE = 30;
        const batches = [];
        for (let i = 0; i < Math.min(items.length, 200); i += BATCH_SIZE) {
            batches.push(items.slice(i, i + BATCH_SIZE));
        }

        for (const batch of batches) {
            await Promise.all(batch.map(async (item) => {
                const text = (item as any).ja || (item as any).name || '';
                if (!text) return;
                try {
                    const en = await TranslationService.translate(text, 'en');
                    if (en && en !== text) {
                        applyFn(item, en);
                    }
                } catch { /* ignore */ }
            }));

            // Refresh UI after each batch if dialog is open
            if (this.dialog?.style.display !== 'none') {
                refreshFn();
            }
        }
    }

    private repopulateTagSelects(): void {
        if (!this.dialog) return;
        const includeFilter = this.dialog.querySelector('.asmr-include-filter') as HTMLInputElement;
        const excludeFilter = this.dialog.querySelector('.asmr-exclude-filter') as HTMLInputElement;
        const includeSelect = this.dialog.querySelector('.asmr-include-select') as HTMLSelectElement;
        const excludeSelect = this.dialog.querySelector('.asmr-exclude-select') as HTMLSelectElement;
        if (includeSelect) this.populateTagSelect(includeSelect, includeFilter?.value || '', this.selectedIncludes);
        if (excludeSelect) this.populateTagSelect(excludeSelect, excludeFilter?.value || '', this.selectedExcludes);
    }

    private repopulateVASelect(): void {
        if (!this.dialog) return;
        const filter = this.dialog.querySelector('.asmr-va-filter') as HTMLInputElement;
        const select = this.dialog.querySelector('.asmr-va-select') as HTMLSelectElement;
        if (select) this.populateVAOptions(select, filter?.value || '');
    }

    private repopulateCircleSelect(): void {
        if (!this.dialog) return;
        const filter = this.dialog.querySelector('.asmr-circle-filter') as HTMLInputElement;
        const select = this.dialog.querySelector('.asmr-circle-select') as HTMLSelectElement;
        if (select) this.populateCircleOptions(select, filter?.value || '');
    }

    // =========================================================================
    // Tag Selection
    // =========================================================================

    // Class-level tag storage
    private tagList: TagEntry[] = [];

    private populateTagSelect(select: HTMLSelectElement, filterValue: string, selected: TagEntry[]): void {
        select.innerHTML = '';
        const needle = filterValue.trim().toLowerCase();
        const rows = needle
            ? this.tagList.filter(t => (t.en || t.ja || t.name).toLowerCase().includes(needle) || (t.ja || t.name).toLowerCase().includes(needle))
            : this.tagList.slice(0, 100);

        rows.forEach(tag => {
            const opt = document.createElement('option');
            opt.value = String(tag.id);
            const label = tag.en ? `${tag.ja || tag.name} (${tag.en})` : (tag.ja || tag.name);
            const count = (tag as any).count;
            opt.textContent = count ? `${label} (${count})` : label;
            opt.selected = !!selected.find(t => t.id === tag.id);
            select.appendChild(opt);
        });

        if (rows.length === 0) {
            const opt = document.createElement('option');
            opt.disabled = true;
            opt.textContent = needle ? I18n.t('advNoResults') : I18n.t('advLoadingTags');
            select.appendChild(opt);
        }
    }

    private bindTagSelects(card: HTMLElement): void {
        const includeFilter = card.querySelector('.asmr-include-filter') as HTMLInputElement | null;
        const excludeFilter = card.querySelector('.asmr-exclude-filter') as HTMLInputElement | null;
        const includeSelect = card.querySelector('.asmr-include-select') as HTMLSelectElement | null;
        const excludeSelect = card.querySelector('.asmr-exclude-select') as HTMLSelectElement | null;
        if (!includeSelect || !excludeSelect) return;

        // Multi-select: Toggle selection on click instead of replacing
        const handleTagClick = (select: HTMLSelectElement, selected: TagEntry[], assign: (list: TagEntry[]) => void) => {
            const chosenIds = Array.from(select.selectedOptions).map(o => Number(o.value));
            const newTags = this.tagList.filter(t => chosenIds.includes(t.id) && !selected.find(s => s.id === t.id));
            if (newTags.length > 0) {
                assign([...selected, ...newTags]);
            }
            this.renderTags();
        };

        includeFilter?.addEventListener('input', () => this.populateTagSelect(includeSelect, includeFilter.value, this.selectedIncludes));
        excludeFilter?.addEventListener('input', () => this.populateTagSelect(excludeSelect, excludeFilter.value, this.selectedExcludes));

        includeFilter?.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                includeFilter.value = '';
                includeFilter.blur();
                this.populateTagSelect(includeSelect, '', this.selectedIncludes);
            }
        });
        excludeFilter?.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                excludeFilter.value = '';
                excludeFilter.blur();
                this.populateTagSelect(excludeSelect, '', this.selectedExcludes);
            }
        });

        includeSelect.addEventListener('change', () => handleTagClick(includeSelect, this.selectedIncludes, (list) => { this.selectedIncludes = list; }));
        excludeSelect.addEventListener('change', () => handleTagClick(excludeSelect, this.selectedExcludes, (list) => { this.selectedExcludes = list; }));

        this.populateTagSelect(includeSelect, '', this.selectedIncludes);
        this.populateTagSelect(excludeSelect, '', this.selectedExcludes);
    }

    private renderTags(): void {
        if (!this.dialog) return;

        const render = (containerClass: string, list: TagEntry[], removeFn: (id: number) => void) => {
            const container = this.dialog!.querySelector(containerClass);
            if (!container) return;
            container.innerHTML = '';
            list.forEach(tag => {
                const chip = document.createElement('div');
                chip.className = 'asmr-filter-chip';
                // Display: original (translated) format - show original first
                const displayText = tag.en ? `${tag.ja || tag.name} (${tag.en})` : (tag.ja || tag.name);
                chip.innerHTML = `
                    <span class="chip-text">${displayText}</span>
                    <button class="chip-remove" aria-label="${I18n.format('advRemoveTag', { tag: displayText })}"><i class="material-icons" aria-hidden="true">close</i></button>
                `;
                chip.querySelector('.chip-remove')?.addEventListener('click', () => removeFn(tag.id));
                container.appendChild(chip);
            });
        };

        render('.asmr-chips-include', this.selectedIncludes, (id) => {
            this.selectedIncludes = this.selectedIncludes.filter(t => t.id !== id);
            this.renderTags();
        });
        render('.asmr-chips-exclude', this.selectedExcludes, (id) => {
            this.selectedExcludes = this.selectedExcludes.filter(t => t.id !== id);
            this.renderTags();
        });
    }

    // =========================================================================
    // VA Selection
    // =========================================================================

    private getTranslatedName(name: string): string {
        const en = this.translationCache.get(name);
        if (en && en !== name) return `${name} (${en})`;
        return name;
    }

    private populateVAOptions(select: HTMLSelectElement, filterValue: string): void {
        select.innerHTML = '';
        const needle = filterValue.trim().toLowerCase();
        const filtered = needle
            ? this.vaList.filter(v => {
                const name = v.name.toLowerCase();
                const en = (this.translationCache.get(v.name) || '').toLowerCase();
                return name.includes(needle) || en.includes(needle);
            })
            : this.vaList.slice(0, 100);

        filtered.forEach(va => {
            const opt = document.createElement('option');
            opt.value = String(va.id);
            const displayName = this.getTranslatedName(va.name);
            opt.textContent = `${displayName}${va.count ? ` (${va.count})` : ''}`;
            select.appendChild(opt);
        });

        if (filtered.length === 0) {
            const opt = document.createElement('option');
            opt.disabled = true;
            opt.textContent = needle ? I18n.t('advNoResults') : I18n.t('advLoadingVA');
            select.appendChild(opt);
        }
    }

    private bindVASelect(card: HTMLElement): void {
        const filter = card.querySelector('.asmr-va-filter') as HTMLInputElement | null;
        const select = card.querySelector('.asmr-va-select') as HTMLSelectElement | null;
        if (!filter || !select) return;

        filter.addEventListener('input', () => this.populateVAOptions(select, filter.value));

        filter.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                filter.value = '';
                filter.blur();
                this.populateVAOptions(select, '');
            }
        });

        select.addEventListener('change', () => {
            const selectedId = select.value;
            const va = this.vaList.find(v => String(v.id) === selectedId);
            if (va) {
                this.selectedVA = va;
                this.renderSelectedVA();
                filter.value = '';
                this.populateVAOptions(select, '');
            }
        });

        this.populateVAOptions(select, '');
    }

    private renderSelectedVA(): void {
        const container = this.dialog?.querySelector('.asmr-selected-va');
        if (!container) return;

        if (this.selectedVA) {
            const displayName = this.getTranslatedName(this.selectedVA.name);
            container.innerHTML = `
                <div class="asmr-selected-chip">
                    <span>${displayName}</span>
                    <button class="chip-remove" aria-label="${I18n.format('advRemoveVA', { name: displayName })}"><i class="material-icons" aria-hidden="true">close</i></button>
                </div>
            `;
            container.querySelector('.chip-remove')?.addEventListener('click', () => {
                this.selectedVA = null;
                this.renderSelectedVA();
            });
        } else {
            container.innerHTML = '';
        }
    }

    // =========================================================================
    // Circle Selection
    // =========================================================================

    private populateCircleOptions(select: HTMLSelectElement, filterValue: string): void {
        select.innerHTML = '';
        const needle = filterValue.trim().toLowerCase();
        const filtered = needle
            ? this.circleList.filter(c => {
                const name = c.name.toLowerCase();
                const en = (this.translationCache.get(c.name) || '').toLowerCase();
                return name.includes(needle) || en.includes(needle);
            })
            : this.circleList.slice(0, 100);

        filtered.forEach(circle => {
            const opt = document.createElement('option');
            opt.value = String(circle.id);
            const displayName = this.getTranslatedName(circle.name);
            opt.textContent = `${displayName}${circle.count ? ` (${circle.count})` : ''}`;
            select.appendChild(opt);
        });

        if (filtered.length === 0) {
            const opt = document.createElement('option');
            opt.disabled = true;
            opt.textContent = needle ? I18n.t('advNoResults') : I18n.t('advLoadingCircles');
            select.appendChild(opt);
        }
    }

    private bindCircleSelect(card: HTMLElement): void {
        const filter = card.querySelector('.asmr-circle-filter') as HTMLInputElement | null;
        const select = card.querySelector('.asmr-circle-select') as HTMLSelectElement | null;
        if (!filter || !select) return;

        filter.addEventListener('input', () => this.populateCircleOptions(select, filter.value));

        filter.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                filter.value = '';
                filter.blur();
                this.populateCircleOptions(select, '');
            }
        });

        select.addEventListener('change', () => {
            const selectedId = select.value;
            const circle = this.circleList.find(c => String(c.id) === selectedId);
            if (circle) {
                this.selectedCircle = circle;
                this.renderSelectedCircle();
                filter.value = '';
                this.populateCircleOptions(select, '');
            }
        });

        this.populateCircleOptions(select, '');
    }

    private renderSelectedCircle(): void {
        const container = this.dialog?.querySelector('.asmr-selected-circle');
        if (!container) return;

        if (this.selectedCircle) {
            const displayName = this.getTranslatedName(this.selectedCircle.name);
            container.innerHTML = `
                <div class="asmr-selected-chip">
                    <span>${displayName}</span>
                    <button class="chip-remove" aria-label="${I18n.format('advRemoveCircle', { name: displayName })}"><i class="material-icons" aria-hidden="true">close</i></button>
                </div>
            `;
            container.querySelector('.chip-remove')?.addEventListener('click', () => {
                this.selectedCircle = null;
                this.renderSelectedCircle();
            });
        } else {
            container.innerHTML = '';
        }
    }

    // =========================================================================
    // Search & Results
    // =========================================================================

    private setStatus(message: string, busy = false): void {
        if (!this.statusEl) return;
        this.statusEl.textContent = message;
        this.statusEl.classList.toggle('error', !busy && message.toLowerCase().includes('fail'));
    }

    private async performSearch(): Promise<void> {
        if (!this.dialog) return;
        Logger.log('[AdvancedSearch] performSearch called', {
            includeTags: this.selectedIncludes.map(t => t.ja),
            excludeTags: this.selectedExcludes.map(t => t.ja),
            va: this.selectedVA?.name,
            circle: this.selectedCircle?.name,
            sort: this.sortOrder,
            direction: this.sortDirection,
        });

        // Build Kikoeru search keyword using $field:value$ syntax
        const keywordParts: string[] = [];

        // Add selected tags
        this.selectedIncludes.forEach(tag => {
            keywordParts.push(`$tag:${tag.ja}$`);
        });

        // Add excluded tags (Kikoeru uses -$tag:name$ for exclusion)
        this.selectedExcludes.forEach(tag => {
            keywordParts.push(`-$tag:${tag.ja}$`);
        });

        // Add VA filter
        if (this.selectedVA) {
            keywordParts.push(`$va:${this.selectedVA.name}$`);
        }

        // Add Circle filter
        if (this.selectedCircle) {
            keywordParts.push(`$circle:${this.selectedCircle.name}$`);
        }

        // Get duration values
        const minVal = (this.dialog.querySelector('.asmr-min') as HTMLInputElement)?.value;
        const maxVal = (this.dialog.querySelector('.asmr-max') as HTMLInputElement)?.value;

        // Add duration filters using Kikoeru syntax
        if (minVal) {
            keywordParts.push(`$duration:${minVal}$`);
        }
        if (maxVal) {
            keywordParts.push(`$-duration:${maxVal}$`);
        }

        // Get rating filter
        const rateMin = (this.dialog.querySelector('.asmr-rate-min') as HTMLInputElement)?.value;
        if (rateMin) {
            keywordParts.push(`$rate:${rateMin}$`);
        }

        // Get price filter
        const priceMin = (this.dialog.querySelector('.asmr-price-min') as HTMLInputElement)?.value;
        if (priceMin) {
            keywordParts.push(`$price:${priceMin}$`);
        }

        // Get sales filter
        const sellMin = (this.dialog.querySelector('.asmr-sell-min') as HTMLInputElement)?.value;
        if (sellMin) {
            keywordParts.push(`$sell:${sellMin}$`);
        }

        // Get age rating filter
        const ageRating = (this.dialog.querySelector('.asmr-age-rating') as HTMLSelectElement)?.value;
        if (ageRating) {
            keywordParts.push(`$age:${ageRating}$`);
        }

        // Get language filter
        const language = (this.dialog.querySelector('.asmr-language') as HTMLSelectElement)?.value;
        if (language) {
            keywordParts.push(`$lang:${language}$`);
        }

        // Pre-set localStorage so the Works component picks up the correct sort
        // on creation (cross-page navigation) or via RouteStateSync (same-page).
        const worksVm = this.bridge.findComponent((vm: any) =>
            vm.sortOption != null && typeof vm.sortOption?.order === 'string' &&
            Array.isArray(vm.options)
        );

        const hostOptions = this.getHostSortOptions();
        const availableOptions = hostOptions.length
            ? hostOptions
            : this.getFallbackSortOptions();
        const resolvedOrder = this.resolveSortOrder(this.sortOrder, availableOptions);
        this.sortOrder = resolvedOrder as WorkOrder;
        const sortLabel = this.getSortLabel(resolvedOrder);

        const newSortOption = { label: sortLabel, order: resolvedOrder, sort: this.sortDirection };
        try { localStorage.setItem('sortOption', JSON.stringify(newSortOption)); } catch { /* ignore */ }

        // Set pending sort in AppStore so the RouteStateSync interceptor can
        // inject the correct order/sort into the host's first API request.
        AppStore.setSearchState({
            pendingOrder: resolvedOrder,
            pendingSort: this.sortDirection,
        });

        // Navigate to works page with search params
        const params = new URLSearchParams();
        if (keywordParts.length > 0) {
            params.set('keyword', keywordParts.join(' '));
        }
        // Include order/sort in URL for bookmarkability and as RouteStateSync fallback
        params.set('order', resolvedOrder);
        params.set('sort', this.sortDirection);

        const searchUrl = `/works?${params.toString()}`;
        Logger.log('[AdvancedSearch] Navigating to:', searchUrl, 'with pending sort:', this.sortOrder, this.sortDirection);

        this.close();

        // If the Works component is already mounted, update sortOption directly
        // to ensure it's correct even before RouteStateSync's observer picks up the navigation.
        if (worksVm) {
            this.applySortToWorksVm(worksVm, newSortOption);
        }

        // Navigate — RouteStateSync will handle the pending sort on mount/update
        this.bridge.router.push(searchUrl).catch((err: any) => {
            if (err?.name !== 'NavigationDuplicated') {
                Logger.warn('[AdvancedSearch] Navigation error:', err);
            }
        });
    }

    /**
     * After navigation, poll for the Works component and ensure its sortOption
     * matches what we requested. Handles cases where the component remounts
     * or where the direct assignment was overridden by the route change.
     */
    private applySortAfterNavigation(newSortOption: { label: string; order: string; sort: string }): void {
        let attempts = 0;
        const maxAttempts = 60;

        const tryApply = () => {
            attempts++;
            const vm = this.findWorksComponent();

            if (vm) {
                const current = vm.sortOption as { order: string; sort: string };
                const applied = this.applySortToWorksVm(vm, newSortOption);
                if (applied && (current.order !== newSortOption.order || current.sort !== newSortOption.sort)) {
                    Logger.log('[AdvancedSearch] Post-nav sort correction:', current, '→', newSortOption);
                }
                return; // Done
            }

            if (attempts < maxAttempts) {
                setTimeout(tryApply, 150);
            }
        };

        // Start after a short delay to let the navigation settle
        setTimeout(tryApply, 150);
    }

    private applySortToWorksVm(vm: any, sortOption: { label: string; order: string; sort: string }): boolean {
        if (!vm) return false;
        const options = Array.isArray(vm.options)
            ? (vm.options as Array<{ label: string; order: string; sort: string }>)
            : [];
        const resolvedOrder = options.length
            ? this.resolveSortOrder(sortOption.order, options)
            : sortOption.order;
        if (resolvedOrder !== sortOption.order) {
            sortOption.order = resolvedOrder;
            sortOption.label = this.getSortLabel(resolvedOrder);
        }
        const matched = options.find(opt => opt.order === resolvedOrder);
        if (matched) {
            if (matched.sort !== sortOption.sort) matched.sort = sortOption.sort;
            vm.sortOption = matched;
            return true;
        }
        const injected = {
            label: this.getSortLabel(resolvedOrder),
            order: resolvedOrder,
            sort: sortOption.sort,
        };
        if (options.length) {
            options.push(injected);
        }
        vm.sortOption = injected;
        return true;
    }

    private async createPlaylist(): Promise<void> {
        if (!this.dialog || this.generating) return;

        this.generating = true;
        this.cancelRequested = false;

        const worksCountInput = this.dialog.querySelector('.asmr-works-count') as HTMLInputElement;
        const requestedCount = parseInt(worksCountInput?.value || '10') || 10;
        Logger.log('[AdvancedSearch] Creating smart playlist', { requestedCount });

        this.setButtonsDisabled(true);
        this.setStatus(I18n.t('advFindingWorks'), true);

        try {
            // Smart Playlist Logic:
            // 1. Fetch recent history to avoid repeats
            // 2. Fetch a larger pool of candidates (3x requested or min 60)
            // 3. Filter out history
            // 4. Shuffle the candidates
            // 5. Pick the requested amount

            const historyPromise = HistoryApi.getRecent().catch(() => []);

            // Fetch more candidates to ensure variety and allow for filtering
            const poolSize = Math.max(requestedCount * 4, 60);
            const worksPromise = this.fetchWorks(poolSize);

            const [history, works] = await Promise.all([historyPromise, worksPromise]);

            if (this.cancelRequested) {
                this.setStatus(I18n.t('advCancelled'), false);
                return;
            }

            if (works.length === 0) {
                this.setStatus(I18n.t('advNoWorksPlaylist'), false);
                return;
            }

            // Extract recently played IDs
            const recentIds = new Set(history.map(h => h.work_id));

            // Filter candidates: exclude history
            let candidates = works.filter(w => !recentIds.has(w.id || w.source_id));

            // Fallback: If filtering removed too many items (user played everything), 
            // allow some history items back but prioritize new ones.
            // (In this simple implementation, if we have < requestedCount, we just use what we have, 
            // or if 0, we revert to original works)
            if (candidates.length === 0) {
                candidates = works;
            } else if (candidates.length < requestedCount && works.length > candidates.length) {
                // Fill up with some history items if necessary (not implemented here for simplicity, merely utilizing what we found)
            }

            // Only shuffle when random sort is selected; otherwise preserve the
            // server-returned order so the playlist respects the user's sort choice.
            const ordered = this.sortOrder === 'random' || this.sortOrder === 'betterRandom'
                ? this.shuffleArray(candidates)
                : candidates;
            const finalWorks = ordered.slice(0, requestedCount);

            this.setStatus(I18n.t('advCreatingPlaylist'), true);

            // Extract RJ codes
            const workIds = finalWorks.map(w => {
                const id = w.id || w.source_id;
                return typeof id === 'number' ? `RJ${String(id).padStart(6, '0')}` : id;
            }).filter(Boolean);

            // Create playlist via API
            const playlistName = this.generatePlaylistName();
            const playlistDesc = this.generatePlaylistDescription(workIds.length, works.length);
            const result = await PlaylistApi.createPlaylist({
                name: playlistName,
                description: playlistDesc,
                privacy: 0, // Private
                works: workIds,
            });

            Logger.log('[AdvancedSearch] Created playlist:', result);
            this.setStatus(I18n.t('advPlaylistCreated'), false);

            // Disable Radio Mode if active
            const radio = RadioMode.getInstance();
            if (radio && radio.isActive) {
                Logger.log('[AdvancedSearch] Disabling Radio Mode for playlist.');
                radio.disable();
            }

            // Emit playlist active event
            EventBus.emit('playlist:active', { isActive: true, workIds, playlistId: result.id });

            // Navigate to playlists page
            setTimeout(() => {
                this.bridge.router.push('/playlists');
                this.close();
            }, 1000);

        } catch (e) {
            Logger.error('[AdvancedSearch] Create playlist failed:', e);
            this.setStatus(I18n.t('advPlaylistFailed'), false);
        } finally {
            this.setButtonsDisabled(false);
            this.generating = false;
        }
    }

    private shuffleArray<T>(array: T[]): T[] {
        const arr = [...array];
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    private generatePlaylistName(): string {
        const parts: string[] = [];
        if (this.selectedIncludes.length > 0) {
            parts.push(this.selectedIncludes.slice(0, 2).map(t => t.en || t.ja).join(', '));
        }
        if (this.selectedVA) {
            parts.push(this.selectedVA.name);
        }
        if (this.selectedCircle) {
            parts.push(this.selectedCircle.name);
        }
        if (parts.length === 0) {
            parts.push('Mixed');
        }
        const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        return `${parts.join(' + ')} - ${date}`;
    }

    private generatePlaylistDescription(requestedCount: number, poolSize: number): string {
        const params: string[] = [];

        if (this.selectedIncludes.length > 0) {
            params.push(`${I18n.t('advIncludeTags')}: ${this.selectedIncludes.map(t => t.en || t.ja || t.name).join(', ')}`);
        }
        if (this.selectedExcludes.length > 0) {
            params.push(`${I18n.t('advExcludeTags')}: ${this.selectedExcludes.map(t => t.en || t.ja || t.name).join(', ')}`);
        }
        if (this.selectedVA) {
            params.push(`${I18n.t('advVoiceActor')}: ${this.selectedVA.name}`);
        }
        if (this.selectedCircle) {
            params.push(`${I18n.t('advCircle')}: ${this.selectedCircle.name}`);
        }

        // Duration
        const minVal = (this.dialog?.querySelector('.asmr-min') as HTMLInputElement)?.value;
        const maxVal = (this.dialog?.querySelector('.asmr-max') as HTMLInputElement)?.value;
        if (minVal || maxVal) {
            params.push(`${I18n.t('advDuration')}: ${minVal || 0}-${maxVal || '∞'} min`);
        }

        // Sort
        const sortLabel = this.getSortLabel(this.sortOrder);
        if (sortLabel) {
            params.push(`${I18n.t('advSortBy')}: ${sortLabel} (${this.sortDirection === 'desc' ? I18n.t('advDesc') : I18n.t('advAsc')})`);
        }

        // Additional filters
        const rateMin = (this.dialog?.querySelector('.asmr-rate-min') as HTMLInputElement)?.value;
        if (rateMin) params.push(`${I18n.t('advMinRating')}: ${rateMin}★+`);

        const priceMin = (this.dialog?.querySelector('.asmr-price-min') as HTMLInputElement)?.value;
        if (priceMin) params.push(`${I18n.t('advMinPrice')}: ¥${priceMin}+`);

        const sellMin = (this.dialog?.querySelector('.asmr-sell-min') as HTMLInputElement)?.value;
        if (sellMin) params.push(`${I18n.t('advMinSales')}: ${sellMin}+`);

        const ageRating = (this.dialog?.querySelector('.asmr-age-rating') as HTMLSelectElement)?.value;
        if (ageRating) {
            const ageLabel = ageRating === 'general' ? I18n.t('advAllAges') : ageRating === 'adult' ? I18n.t('advAdult') : ageRating.toUpperCase();
            params.push(`${I18n.t('advAgeRating')}: ${ageLabel}`);
        }

        const language = (this.dialog?.querySelector('.asmr-language') as HTMLSelectElement)?.value;
        if (language) {
            const langLabel = {
                ja: 'Japanese',
                en: 'English',
                ko: 'Korean',
                'zh-cn': 'Chinese Simplified',
                'zh-tw': 'Chinese Traditional'
            }[language] || language;
            params.push(`${I18n.t('advLanguage')}: ${langLabel}`);
        }

        const summary = I18n.format('advPlaylistDesc', { count: requestedCount, pool: poolSize });
        const parametersStr = params.length > 0 ? `\n\n${I18n.t('advPlaylistParams')}: ${params.join(' | ')}` : '';

        return `${summary}${parametersStr}`;
    }

    private setButtonsDisabled(disabled: boolean): void {
        if (!this.dialog) return;
        const buttons = this.dialog.querySelectorAll('.asmr-btn, .asmr-preset-btn');
        buttons.forEach(btn => (btn as HTMLButtonElement).disabled = disabled);
    }

    private async fetchWorks(maxWorks: number): Promise<any[]> {
        const results: any[] = [];
        let page = 1;
        const MAX_PAGES = 10;

        // Get filter values
        const minVal = (this.dialog?.querySelector('.asmr-min') as HTMLInputElement)?.value;
        const maxVal = (this.dialog?.querySelector('.asmr-max') as HTMLInputElement)?.value;
        const minDuration = minVal ? Number(minVal) * 60 : 0;
        const maxDuration = maxVal ? Number(maxVal) * 60 : 0;

        // Use the host's authenticated axios so the API respects sort params
        // and returns user-specific data. WorksApi uses HttpClient/GM_xmlhttpRequest
        // which bypasses auth and may cause the server to ignore ordering.
        const axios = getAxios();

        while (results.length < maxWorks && page <= MAX_PAGES) {
            if (this.cancelRequested) break;

            this.setStatus(I18n.format('advFetching', { page, max: MAX_PAGES }), true);

            let works: any[] = [];

            try {
                Logger.debug(`[AdvancedSearch] Fetching page ${page}, have ${results.length}/${maxWorks} works so far`);
                const hostOptions = this.getHostSortOptions();
                const availableOptions = hostOptions.length
                    ? hostOptions
                    : this.getFallbackSortOptions();
                const resolvedOrder = this.resolveSortOrder(this.sortOrder, availableOptions);
                this.sortOrder = resolvedOrder as WorkOrder;

                // Circle/VA endpoints don't support random/betterRandom ordering (returns 500).
                // Use release order as fallback; createPlaylist shuffles client-side anyway.
                const isRandomOrder = resolvedOrder === 'random' || resolvedOrder === 'betterRandom';
                const useCircleOrVA = !!(this.selectedVA || this.selectedCircle);
                const effectiveOrder = (isRandomOrder && useCircleOrVA) ? 'release' : resolvedOrder;

                // Build base params
                const baseParams: Record<string, any> = {
                    page,
                    order: effectiveOrder,
                    sort: this.sortDirection,
                };

                // Add tag filters if selected
                const tagIds = this.selectedIncludes.map(t => String(t.id)).join(',');
                const excludeTagIds = this.selectedExcludes.map(t => String(t.id)).join(',');
                if (tagIds) baseParams.tags = tagIds;
                if (excludeTagIds) baseParams.exclude_tags = excludeTagIds;

                // Use appropriate API endpoint based on filters
                let url: string;
                if (this.selectedVA) {
                    url = `/api/vas/${this.selectedVA.id}/works`;
                } else if (this.selectedCircle) {
                    url = `/api/circles/${this.selectedCircle.id}/works`;
                } else {
                    url = '/api/works';
                }

                const res = await axios.get(url, { params: baseParams }) as { data: { works?: any[] } };
                works = res.data?.works || [];
            } catch (e) {
                Logger.warn('[AdvancedSearch] Fetch failed:', e);
                break;
            }

            if (works.length === 0) break;

            // Filter by duration if specified
            for (const work of works) {
                if (this.cancelRequested) break;
                if (results.length >= maxWorks) break;

                const duration = work.duration || 0;
                if (minDuration > 0 && duration < minDuration) continue;
                if (maxDuration > 0 && duration > maxDuration) continue;

                results.push(work);
            }

            page++;
        }

        return results;
    }

}
