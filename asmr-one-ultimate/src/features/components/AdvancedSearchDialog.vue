<script setup lang="ts">
/**
 * AdvancedSearchDialog - Vue 3 SFC replacement for imperative AdvancedSearch.
 *
 * Provides tag/VA/circle selection, duration presets, sort order,
 * rating/price/sales filters, age rating, language, and playlist creation.
 *
 * All DOM manipulation from the original class is replaced with Vue reactivity.
 */

import { ref, reactive, computed, watch, onMounted, onUnmounted, shallowRef, triggerRef } from 'vue';
import { GM_getValue, GM_setValue } from '$';
import { useBridge } from '../../composables/useBridge';
import { useI18n } from '../../composables/useI18n';
import { useEventBus } from '../../composables/useEventBus';
import { MetadataApi, PlaylistApi, HistoryApi } from '../../api';
import { getAxios } from '../../api/Client';
import { TranslatedTags } from '../TranslatedTags';
import { TranslationService } from '../../services/TranslationService';
import { AppStore } from '../../store/AppStore';
import { RouteStateSync } from '../RouteStateSync';
import { RadioMode } from '../radio';
import { Logger, I18n } from '../../core/Utils';
import type { TagEntry, VAEntry, CircleEntry, WorkOrder } from '../../types/api';

import TagSelector from './TagSelector.vue';
import EntitySelector from './EntitySelector.vue';
import type { EntityItem } from './EntitySelector.vue';

// ---------------------------------------------------------------------------
// Sort option types and fallback data
// ---------------------------------------------------------------------------

interface SortOption {
    label: string;
    order: string;
    sort: string;
}

interface WorksVmComponent {
    sortOptions?: SortOption[];
    options?: SortOption[];
    sortOption?: SortOption;
    $watch?: (path: string, cb: (val: any) => void, opts?: object) => () => void;
    [key: string]: unknown;
}

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

// ---------------------------------------------------------------------------
// Composables
// ---------------------------------------------------------------------------

const bridge = useBridge();
const { t, format, lang } = useI18n();
const eventBus = useEventBus();

// ---------------------------------------------------------------------------
// Dialog visibility (controlled by parent via v-model)
// ---------------------------------------------------------------------------

const props = defineProps<{
    visible: boolean;
}>();

const emit = defineEmits<{
    'update:visible': [value: boolean];
}>();

const isOpen = computed({
    get: () => props.visible,
    set: (val: boolean) => emit('update:visible', val),
});

// ---------------------------------------------------------------------------
// Reactive form state (replaces captureDialogState / applyDialogState)
// ---------------------------------------------------------------------------

const selectedIncludes = ref<TagEntry[]>([]);
const selectedExcludes = ref<TagEntry[]>([]);
const selectedVA = ref<VAEntry | null>(null);
const selectedCircle = ref<CircleEntry | null>(null);

const minDuration = ref('');
const maxDuration = ref('');
const sortOrder = ref<WorkOrder>('insert_time');
const sortDirection = ref<'desc' | 'asc'>('desc');
const ratingMin = ref('');
const priceMin = ref('');
const salesMin = ref('');
const worksCount = ref('10');
const ageRating = ref('');
const language = ref('');

// ---------------------------------------------------------------------------
// Metadata lists
// ---------------------------------------------------------------------------

// Use shallowRef + triggerRef for large arrays to avoid deep reactivity overhead
const tagList = shallowRef<TagEntry[]>([]);
const vaList = shallowRef<VAEntry[]>([]);
const circleList = shallowRef<CircleEntry[]>([]);

// Translation cache for VA/Circle names (original -> English)
const translationCache = ref(new Map<string, string>());

// ---------------------------------------------------------------------------
// UI state
// ---------------------------------------------------------------------------

const generating = ref(false);
const cancelRequested = ref(false);
const statusText = ref('');
const statusIsError = ref(false);

// ---------------------------------------------------------------------------
// Sort options computation
// ---------------------------------------------------------------------------

// The sort watcher tracks the host Works component
let sortWatcherCleanup: (() => void) | null = null;
let sortWatcherVm: any = null;
let lastHostSortKey = '';

const sortOptions = computed(() => {
    // Access lang.value to re-evaluate when language changes
    void lang.value;
    const hostOptions = getHostSortOptions();
    const orderOptions: Array<{ order: string; label: string }> = [];
    const seen = new Set<string>();

    hostOptions.forEach(opt => {
        if (seen.has(opt.order)) return;
        seen.add(opt.order);
        orderOptions.push({ order: opt.order, label: getOrderLabel(opt.order, opt.label) });
    });

    const fallback = getFallbackSortOptions();
    fallback.forEach(opt => {
        if (opt.order === 'insert_time' && seen.has('create_date')) return;
        if (!seen.has(opt.order)) {
            seen.add(opt.order);
            orderOptions.push(opt);
        }
    });

    return orderOptions.length ? orderOptions : fallback;
});

// Active duration preset
const activePreset = computed(() => {
    if (minDuration.value === '0' && maxDuration.value === '30') return 'short';
    if (minDuration.value === '30' && maxDuration.value === '120') return 'medium';
    if (minDuration.value === '120' && maxDuration.value === '') return 'long';
    return '';
});

// ---------------------------------------------------------------------------
// Sort helpers (ported from imperative class)
// ---------------------------------------------------------------------------

function getVmSortOptions(vm: WorksVmComponent): SortOption[] {
    if (vm && Array.isArray(vm.sortOptions)) return vm.sortOptions;
    if (vm && Array.isArray(vm.options)) return vm.options;
    return [];
}

function findWorksViaDom(): WorksVmComponent | null {
    const inputs = Array.from(document.querySelectorAll('input[role="combobox"]'));
    for (const el of inputs) {
        let current: HTMLElement | null = el as HTMLElement;
        for (let i = 0; i < 20 && current; i++) {
            let vue = (current as any).__vue__ as any | undefined;
            for (let v = 0; v < 5 && vue; v++) {
                if (vue.sortOption && typeof vue.sortOption?.order === 'string' && getVmSortOptions(vue).length > 0) {
                    return vue;
                }
                vue = vue.$parent;
            }
            current = current.parentElement;
        }
    }
    return null;
}

function findWorksComponent(): WorksVmComponent | null {
    return findWorksViaDom() || bridge.findComponent((c: any) =>
        c.sortOption != null && typeof c.sortOption?.order === 'string' && getVmSortOptions(c).length > 0
    );
}

function shouldIgnoreHostLabels(labels: string[]): boolean {
    if (I18n.lang !== 'en') return false;
    return labels.some(label => /[\u3040-\u30ff\u4e00-\u9faf]/.test(label));
}

function resolveHostLabel(label: string): string {
    if (!label) return label;
    try {
        const translated = (bridge as any)?.app?.$t?.(label);
        if (translated && translated !== label) return translated as string;
    } catch { /* ignore */ }
    return I18n.t(label);
}

function getHostSortOptions(): SortOption[] {
    const vm = findWorksComponent();
    if (vm) {
        const options = getVmSortOptions(vm);
        if (!options.length) return readCachedSortOptions();
        if (shouldIgnoreHostLabels(options.map(opt => opt.label))) return [];
        cacheHostSortOptions(options);
        return options;
    }
    return readCachedSortOptions();
}

function cacheHostSortOptions(options: SortOption[]): void {
    try {
        const sanitized = options
            .filter(opt => opt && typeof opt.order === 'string' && typeof opt.label === 'string')
            .map(opt => ({ label: opt.label, order: opt.order, sort: opt.sort }));
        if (sanitized.length) {
            GM_setValue(getSortOptionsCacheKey(), sanitized);
        }
    } catch (e) {
        Logger.warn('[AdvancedSearch] Failed to cache sort options:', e);
    }
}

function readCachedSortOptions(): SortOption[] {
    try {
        const cached = GM_getValue(getSortOptionsCacheKey(), null);
        if (!cached) return [];
        const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
        if (!Array.isArray(parsed)) return [];
        const options = parsed.filter((opt: any) =>
            opt && typeof opt.order === 'string' && typeof opt.label === 'string'
        );
        if (shouldIgnoreHostLabels(options.map((opt: any) => opt.label))) return [];
        return options;
    } catch (e) {
        Logger.warn('[AdvancedSearch] Failed to read cached sort options:', e);
        return [];
    }
}

function getFallbackSortOptions(): Array<{ order: string; label: string }> {
    return FALLBACK_SORT_OPTIONS.map(opt => ({
        order: opt.value,
        label: I18n.t(opt.labelKey),
    }));
}

function getOrderLabel(order: string, hostLabel?: string): string {
    const fallback = FALLBACK_SORT_OPTIONS.find(opt => opt.value === order)
        || (order === 'create_date'
            ? FALLBACK_SORT_OPTIONS.find(opt => opt.value === 'insert_time')
            : undefined);
    if (fallback) return I18n.t(fallback.labelKey);
    return hostLabel ? resolveHostLabel(hostLabel) : order;
}

function resolveSortOrder(order: string, options: Array<{ order: string }>): string {
    if (options.some(o => o.order === order)) return order;
    if (order === 'create_date' && options.some(o => o.order === 'insert_time')) return 'insert_time';
    if (order === 'insert_time' && options.some(o => o.order === 'create_date')) return 'create_date';
    return order;
}

function getSortLabel(order: string, sort?: 'asc' | 'desc'): string {
    const hostOptions = getHostSortOptions();
    if (hostOptions.length) {
        const matched = sort
            ? hostOptions.find(o => o.order === order && o.sort === sort)
            : hostOptions.find(o => o.order === order);
        if (matched) return resolveHostLabel(matched.label);
    }
    const fallback = FALLBACK_SORT_OPTIONS.find(o => o.value === order)
        || (order === 'create_date'
            ? FALLBACK_SORT_OPTIONS.find(o => o.value === 'insert_time')
            : undefined);
    return fallback ? I18n.t(fallback.labelKey) : order;
}

function getSortLabelKey(order: WorkOrder, sort: 'asc' | 'desc'): string {
    const hostOptions = getHostSortOptions();
    const matched = hostOptions.find(o => o.order === order && o.sort === sort)
        || hostOptions.find(o => o.order === order);
    if (matched) return matched.label;
    const fallback = FALLBACK_SORT_OPTIONS.find(o => o.value === order)
        || (order === 'create_date'
            ? FALLBACK_SORT_OPTIONS.find(o => o.value === 'insert_time')
            : undefined);
    return fallback ? I18n.t(fallback.labelKey) : order;
}

function resolveSortSelection(order: WorkOrder, sort: 'asc' | 'desc'): { order: WorkOrder; sort: 'asc' | 'desc'; label: string } {
    const hostOptions = getHostSortOptions();
    const available = hostOptions.length ? hostOptions : getFallbackSortOptions();
    const resolvedOrder = resolveSortOrder(order, available);
    const matchedExact = hostOptions.find(o => o.order === resolvedOrder && o.sort === sort);
    const matchedOrder = matchedExact || hostOptions.find(o => o.order === resolvedOrder);
    const label = matchedOrder?.label || getSortLabelKey(resolvedOrder as WorkOrder, sort);
    return { order: resolvedOrder as WorkOrder, sort, label };
}

function readStoredSortOption(): { order: WorkOrder; sort: 'asc' | 'desc' } | null {
    try {
        const stored = localStorage.getItem('sortOption');
        if (!stored) return null;
        const parsed = JSON.parse(stored);
        if (parsed?.order && parsed?.sort) {
            return { order: parsed.order as WorkOrder, sort: parsed.sort as 'asc' | 'desc' };
        }
    } catch (e) {
        Logger.warn('[AdvancedSearch] Malformed sortOption in localStorage:', e);
    }
    return null;
}

function syncSortStateFromHost(): void {
    // Priority 1: AppStore (active search session)
    const searchState = AppStore.state.search;
    if (searchState.pendingOrder) {
        sortOrder.value = searchState.pendingOrder as WorkOrder;
        if (searchState.pendingSort) sortDirection.value = searchState.pendingSort as 'asc' | 'desc';
        return;
    }

    // Priority 2: Stored option
    const stored = readStoredSortOption();
    if (stored?.order) {
        sortOrder.value = stored.order;
        sortDirection.value = stored.sort;
        return;
    }

    // Priority 3: Host component
    const vm = findWorksComponent();
    const current = vm?.sortOption as { order?: WorkOrder; sort?: 'asc' | 'desc' } | undefined;
    if (current?.order) {
        sortOrder.value = current.order;
        if (current.sort) sortDirection.value = current.sort;
    }
}

function refreshSortUi(): void {
    I18n.syncFromHost();
    syncSortStateFromHost();
    const resolved = resolveSortSelection(sortOrder.value, sortDirection.value);
    sortOrder.value = resolved.order;
    sortDirection.value = resolved.sort;
}

function syncHostSortOption(): void {
    const resolved = resolveSortSelection(sortOrder.value, sortDirection.value);
    sortOrder.value = resolved.order;
    sortDirection.value = resolved.sort;

    // Use AppStore for search state - source of truth for RouteStateSync
    AppStore.setSearchState({
        pendingOrder: resolved.order,
        pendingSort: resolved.sort
    });

    // Persist for legacy compatibility
    const newSortOption = {
        label: resolved.label,
        order: resolved.order,
        sort: resolved.sort
    };
    try { localStorage.setItem('sortOption', JSON.stringify(newSortOption)); } catch (e) { Logger.warn('[AdvancedSearch] Failed to persist sortOption:', e); }

    // Immediately update visual display for the host background dropdown
    try {
        const sync = RouteStateSync.getInstance();
        sync.syncDisplayToHost(sync.getSortLabel(resolved.order, resolved.sort));
    } catch (e) {
        Logger.warn('[AdvancedSearch] Failed to sync host display:', e);
    }

    // Apply to current component if we are already on the works page
    const worksVm = findWorksComponent();
    if (worksVm) {
        applySortToWorksVm(worksVm, newSortOption);
    }
}

function applySortToWorksVm(vm: WorksVmComponent, sortOpt: SortOption): boolean {
    if (!vm) return false;
    const options = getVmSortOptions(vm);
    const resolvedOrd = options.length
        ? resolveSortOrder(sortOpt.order, options)
        : sortOpt.order;
    const resolvedSort = sortOpt.sort;

    const matched = options.find(opt => opt.order === resolvedOrd && opt.sort === resolvedSort)
        || options.find(opt => opt.order === resolvedOrd);
    if (matched) {
        vm.sortOption = matched;
        return true;
    }

    const injected = {
        label: sortOpt.label || getSortLabelKey(resolvedOrd as WorkOrder, resolvedSort as 'asc' | 'desc'),
        order: resolvedOrd,
        sort: resolvedSort,
    };
    if (options.length) {
        options.push(injected);
    }
    vm.sortOption = injected;
    return true;
}

// ---------------------------------------------------------------------------
// Host sort watcher (keeps our sort state in sync with host changes)
// ---------------------------------------------------------------------------

function ensureHostSortWatcher(): void {
    const vm = findWorksComponent();
    if (!vm || vm === sortWatcherVm) return;

    if (sortWatcherCleanup) {
        sortWatcherCleanup();
        sortWatcherCleanup = null;
    }

    if (typeof vm.$watch === 'function') {
        sortWatcherVm = vm;
        sortWatcherCleanup = vm.$watch(
            'sortOption',
            (next: { order?: WorkOrder; sort?: 'asc' | 'desc' } | undefined) => {
                if (!next?.order) return;
                const order = next.order as WorkOrder;
                const sort = (next.sort || 'desc') as 'asc' | 'desc';
                const key = `${order}:${sort}`;
                if (key === lastHostSortKey) return;
                lastHostSortKey = key;
                sortOrder.value = order;
                sortDirection.value = sort;
            },
            { deep: true, immediate: true }
        );
    }
}

// ---------------------------------------------------------------------------
// Metadata loading
// ---------------------------------------------------------------------------

let metadataLoadingPromise: Promise<void> | null = null;

function looksTranslatable(text: string): boolean {
    return /[\u3040-\u30ff\u4e00-\u9faf\uac00-\ud7af]/.test(text);
}

async function translateInBackground<T extends { name?: string; ja?: string }>(
    items: T[],
    applyFn: (item: T, en: string) => void,
    refreshFn: () => void,
): Promise<void> {
    const BATCH_SIZE = 30;
    const batches: T[][] = [];
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
            } catch (e) { Logger.warn('[AdvancedSearch] Background translation failed for:', text, e); }
        }));

        // Refresh UI after each batch if dialog is open
        if (isOpen.value) {
            refreshFn();
        }
    }
}

async function loadMetadataLists(): Promise<void> {
    if (metadataLoadingPromise) return metadataLoadingPromise;

    metadataLoadingPromise = (async () => {
        try {
            const englishTags = TranslatedTags.getInstance();
            const [vas, circles, apiTags] = await Promise.all([
                MetadataApi.getVAList(),
                MetadataApi.getCircleList(),
                MetadataApi.getTagList(),
            ]);

            const vaArray = Array.isArray(vas) ? vas : [];
            const circlesArray = Array.isArray(circles) ? circles : [];
            const apiTagsArray = Array.isArray(apiTags) ? apiTags : [];

            // Sort by count (popularity) descending
            vaList.value = vaArray.sort((a, b) => (b.count || 0) - (a.count || 0));
            circleList.value = circlesArray.sort((a, b) => (b.count || 0) - (a.count || 0));

            // Build translation map from TranslatedTags
            const englishTagsList = englishTags.getTagList();
            const enMap = new Map<number, string>();
            englishTagsList.forEach(t => {
                if (t.en) enMap.set(t.id, t.en);
            });

            // Use API tags as base, merge English translations
            tagList.value = apiTagsArray.map(t => {
                const id = typeof t.id === 'string' ? parseInt(t.id as unknown as string, 10) : (t.id as number);
                return {
                    id,
                    name: t.name,
                    ja: t.name,
                    en: enMap.get(id) || '',
                    count: t.count || 0,
                };
            }).sort((a, b) => (b.count || 0) - (a.count || 0));

            Logger.debug('[AdvancedSearch] Metadata loaded:', vaArray.length, 'VAs,', circlesArray.length, 'circles, and', tagList.value.length, 'tags');

            // Start background translation for tags without translations
            translateInBackground(
                tagList.value.filter(t => !t.en && looksTranslatable(t.ja || t.name)),
                (item, en) => { item.en = en; },
                () => { triggerRef(tagList); }
            );

            // Background translation for VAs and Circles
            translateInBackground(
                vaList.value.filter(v => looksTranslatable(v.name)),
                (item, en) => { translationCache.value.set(item.name, en); },
                () => { translationCache.value = new Map(translationCache.value); }
            );
            translateInBackground(
                circleList.value.filter(c => looksTranslatable(c.name)),
                (item, en) => { translationCache.value.set(item.name, en); },
                () => { translationCache.value = new Map(translationCache.value); }
            );
        } catch (e) {
            Logger.warn('[AdvancedSearch] Failed to load metadata lists:', e);
            metadataLoadingPromise = null; // Allow retry on failure
        }
    })();

    return metadataLoadingPromise;
}

// ---------------------------------------------------------------------------
// Duration presets
// ---------------------------------------------------------------------------

function setDuration(min: string, max: string): void {
    minDuration.value = min;
    maxDuration.value = max;
}

// ---------------------------------------------------------------------------
// Sort direction
// ---------------------------------------------------------------------------

function setSortDirection(dir: 'asc' | 'desc'): void {
    sortDirection.value = dir;
    syncHostSortOption();
}

function onSortOrderChange(): void {
    syncHostSortOption();
}

// ---------------------------------------------------------------------------
// Tag selection handlers
// ---------------------------------------------------------------------------

function onIncludeTagSelect(tag: TagEntry): void {
    if (!selectedIncludes.value.find(s => s.id === tag.id)) {
        selectedIncludes.value = [...selectedIncludes.value, tag];
    }
}

function onExcludeTagSelect(tag: TagEntry): void {
    if (!selectedExcludes.value.find(s => s.id === tag.id)) {
        selectedExcludes.value = [...selectedExcludes.value, tag];
    }
}

function onIncludeTagRemove(tagId: number): void {
    selectedIncludes.value = selectedIncludes.value.filter(t => t.id !== tagId);
}

function onExcludeTagRemove(tagId: number): void {
    selectedExcludes.value = selectedExcludes.value.filter(t => t.id !== tagId);
}

// ---------------------------------------------------------------------------
// VA / Circle selection handlers
// ---------------------------------------------------------------------------

function onVASelect(item: EntityItem): void {
    selectedVA.value = item as VAEntry;
}

function onCircleSelect(item: EntityItem): void {
    selectedCircle.value = item as CircleEntry;
}

// ---------------------------------------------------------------------------
// Status display
// ---------------------------------------------------------------------------

function setStatus(message: string, busy = false): void {
    statusText.value = message;
    statusIsError.value = !busy && message.toLowerCase().includes('fail');
}

// ---------------------------------------------------------------------------
// Close / Keyboard
// ---------------------------------------------------------------------------

function close(): void {
    if (generating.value) {
        cancelRequested.value = true;
    }
    isOpen.value = false;
}

function onOverlayClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) close();
}

function onKeydown(event: KeyboardEvent): void {
    if (!isOpen.value) return;

    if (event.key === 'Escape') {
        event.preventDefault();
        close();
    } else if (event.key === 'Enter') {
        const target = event.target as HTMLElement;
        if (target.tagName !== 'TEXTAREA' && target.tagName !== 'SELECT') {
            event.preventDefault();
            performSearch();
        }
    }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

async function performSearch(): Promise<void> {
    Logger.debug('[AdvancedSearch] performSearch called', {
        includeTags: selectedIncludes.value.map(t => t.ja),
        excludeTags: selectedExcludes.value.map(t => t.ja),
        va: selectedVA.value?.name,
        circle: selectedCircle.value?.name,
        sort: sortOrder.value,
        direction: sortDirection.value,
    });

    const keywordParts: string[] = [];

    // Tags
    selectedIncludes.value.forEach(tag => {
        keywordParts.push(`$tag:${tag.ja}$`);
    });
    selectedExcludes.value.forEach(tag => {
        keywordParts.push(`-$tag:${tag.ja}$`);
    });

    // VA / Circle
    if (selectedVA.value) {
        keywordParts.push(`$va:${selectedVA.value.name}$`);
    }
    if (selectedCircle.value) {
        keywordParts.push(`$circle:${selectedCircle.value.name}$`);
    }

    // Duration
    if (minDuration.value) keywordParts.push(`$duration:${minDuration.value}$`);
    if (maxDuration.value) keywordParts.push(`$-duration:${maxDuration.value}$`);

    // Rating / Price / Sales
    if (ratingMin.value) keywordParts.push(`$rate:${ratingMin.value}$`);
    if (priceMin.value) keywordParts.push(`$price:${priceMin.value}$`);
    if (salesMin.value) keywordParts.push(`$sell:${salesMin.value}$`);

    // Age rating / Language
    if (ageRating.value) keywordParts.push(`$age:${ageRating.value}$`);
    if (language.value) keywordParts.push(`$lang:${language.value}$`);

    // Pre-set localStorage so the Works component picks up the correct sort
    const worksVm = findWorksComponent();
    const resolved = resolveSortSelection(sortOrder.value, sortDirection.value);
    sortOrder.value = resolved.order;
    sortDirection.value = resolved.sort;

    const newSortOption = { label: resolved.label, order: resolved.order, sort: resolved.sort };
    try { localStorage.setItem('sortOption', JSON.stringify(newSortOption)); } catch (e) { Logger.warn('[AdvancedSearch] Failed to persist sortOption:', e); }

    AppStore.setSearchState({
        pendingOrder: resolved.order,
        pendingSort: resolved.sort,
    });

    // Navigate to works page with search params
    const params = new URLSearchParams();
    if (keywordParts.length > 0) {
        params.set('keyword', keywordParts.join(' '));
    }
    params.set('order', resolved.order);
    params.set('sort', resolved.sort);

    const searchUrl = `/works?${params.toString()}`;
    Logger.debug('[AdvancedSearch] Navigating to:', searchUrl, 'with pending sort:', sortOrder.value, sortDirection.value);

    close();

    if (worksVm) {
        applySortToWorksVm(worksVm, newSortOption);
    }

    bridge.router.push(searchUrl).catch((err: any) => {
        if (err?.name !== 'NavigationDuplicated') {
            Logger.warn('[AdvancedSearch] Navigation error:', err);
        }
    });
}

// ---------------------------------------------------------------------------
// Create Playlist
// ---------------------------------------------------------------------------

function shuffleArray<T>(array: T[]): T[] {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function generatePlaylistName(): string {
    const parts: string[] = [];
    if (selectedIncludes.value.length > 0) {
        parts.push(selectedIncludes.value.slice(0, 2).map(t => t.en || t.ja).join(', '));
    }
    if (selectedVA.value) parts.push(selectedVA.value.name);
    if (selectedCircle.value) parts.push(selectedCircle.value.name);
    if (parts.length === 0) parts.push('Mixed');
    const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${parts.join(' + ')} - ${date}`;
}

function generatePlaylistDescription(requestedCount: number, poolSize: number): string {
    const params: string[] = [];

    if (selectedIncludes.value.length > 0) {
        params.push(`${t('advIncludeTags')}: ${selectedIncludes.value.map(t => t.en || t.ja || t.name).join(', ')}`);
    }
    if (selectedExcludes.value.length > 0) {
        params.push(`${t('advExcludeTags')}: ${selectedExcludes.value.map(t => t.en || t.ja || t.name).join(', ')}`);
    }
    if (selectedVA.value) params.push(`${t('advVoiceActor')}: ${selectedVA.value.name}`);
    if (selectedCircle.value) params.push(`${t('advCircle')}: ${selectedCircle.value.name}`);

    if (minDuration.value || maxDuration.value) {
        params.push(`${t('advDuration')}: ${minDuration.value || 0}-${maxDuration.value || '\u221e'} min`);
    }

    const sortLbl = getSortLabel(sortOrder.value, sortDirection.value);
    if (sortLbl) {
        params.push(`${t('advSortBy')}: ${sortLbl} (${sortDirection.value === 'desc' ? t('advDesc') : t('advAsc')})`);
    }

    if (ratingMin.value) params.push(`${t('advMinRating')}: ${ratingMin.value}\u2605+`);
    if (priceMin.value) params.push(`${t('advMinPrice')}: \u00a5${priceMin.value}+`);
    if (salesMin.value) params.push(`${t('advMinSales')}: ${salesMin.value}+`);

    if (ageRating.value) {
        const ageLabel = ageRating.value === 'general' ? t('advAllAges') : ageRating.value === 'adult' ? t('advAdult') : ageRating.value.toUpperCase();
        params.push(`${t('advAgeRating')}: ${ageLabel}`);
    }

    if (language.value) {
        const langLabel: Record<string, string> = {
            ja: 'Japanese',
            en: 'English',
            ko: 'Korean',
            'zh-cn': 'Chinese Simplified',
            'zh-tw': 'Chinese Traditional'
        };
        params.push(`${t('advLanguage')}: ${langLabel[language.value] || language.value}`);
    }

    const summary = format('advPlaylistDesc', { count: requestedCount, pool: poolSize });
    const parametersStr = params.length > 0 ? `\n\n${t('advPlaylistParams')}: ${params.join(' | ')}` : '';
    return `${summary}${parametersStr}`;
}

async function fetchWorks(maxWorks: number): Promise<any[]> {
    const results: any[] = [];
    let page = 1;
    const MAX_PAGES = 10;

    const minDurationSec = minDuration.value ? Number(minDuration.value) * 60 : 0;
    const maxDurationSec = maxDuration.value ? Number(maxDuration.value) * 60 : 0;

    const axios = getAxios();

    while (results.length < maxWorks && page <= MAX_PAGES) {
        if (cancelRequested.value) break;

        setStatus(format('advFetching', { page, max: MAX_PAGES }), true);

        let works: any[] = [];

        try {
            Logger.debug(`[AdvancedSearch] Fetching page ${page}, have ${results.length}/${maxWorks} works so far`);
            const resolved = resolveSortSelection(sortOrder.value, sortDirection.value);
            sortOrder.value = resolved.order;
            sortDirection.value = resolved.sort;

            const isRandomOrder = resolved.order === 'random' || resolved.order === 'betterRandom';
            const useCircleOrVA = !!(selectedVA.value || selectedCircle.value);
            const effectiveOrder = (isRandomOrder && useCircleOrVA) ? 'release' : resolved.order;

            const baseParams: Record<string, any> = {
                page,
                order: effectiveOrder,
                sort: resolved.sort,
            };

            const tagIds = selectedIncludes.value.map(t => String(t.id)).join(',');
            const excludeTagIds = selectedExcludes.value.map(t => String(t.id)).join(',');
            if (tagIds) baseParams.tags = tagIds;
            if (excludeTagIds) baseParams.exclude_tags = excludeTagIds;

            let url: string;
            if (selectedVA.value) {
                url = `/api/vas/${selectedVA.value.id}/works`;
            } else if (selectedCircle.value) {
                url = `/api/circles/${selectedCircle.value.id}/works`;
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

        for (const work of works) {
            if (cancelRequested.value) break;
            if (results.length >= maxWorks) break;

            const duration = work.duration || 0;
            if (minDurationSec > 0 && duration < minDurationSec) continue;
            if (maxDurationSec > 0 && duration > maxDurationSec) continue;

            results.push(work);
        }

        page++;
    }

    return results;
}

async function createPlaylist(): Promise<void> {
    if (generating.value) return;

    generating.value = true;
    cancelRequested.value = false;

    const requestedCount = parseInt(worksCount.value || '10') || 10;
    Logger.debug('[AdvancedSearch] Creating smart playlist', { requestedCount });

    setStatus(t('advFindingWorks'), true);

    try {
        const historyPromise = HistoryApi.getRecent().catch(() => []);
        const poolSize = Math.max(requestedCount * 4, 60);
        const worksPromise = fetchWorks(poolSize);

        const [history, works] = await Promise.all([historyPromise, worksPromise]);

        if (cancelRequested.value) {
            setStatus(t('advCancelled'), false);
            return;
        }

        if (works.length === 0) {
            setStatus(t('advNoWorksPlaylist'), false);
            return;
        }

        const recentIds = new Set(history.map(h => h.work_id));
        let candidates = works.filter(w => !recentIds.has(w.id || w.source_id));

        if (candidates.length === 0) {
            candidates = works;
        }

        const ordered = sortOrder.value === 'random' || sortOrder.value === 'betterRandom'
            ? shuffleArray(candidates)
            : candidates;
        const finalWorks = ordered.slice(0, requestedCount);

        setStatus(t('advCreatingPlaylist'), true);

        const workIds = finalWorks.map(w => {
            const id = w.id || w.source_id;
            return typeof id === 'number' ? `RJ${String(id).padStart(6, '0')}` : id;
        }).filter(Boolean);

        const playlistName = generatePlaylistName();
        const playlistDesc = generatePlaylistDescription(workIds.length, works.length);
        const result = await PlaylistApi.createPlaylist({
            name: playlistName,
            description: playlistDesc,
            privacy: 0,
            works: workIds,
        });

        Logger.debug('[AdvancedSearch] Created playlist:', result);
        setStatus(t('advPlaylistCreated'), false);

        // Disable Radio Mode if active
        const radio = RadioMode.getInstance();
        if (radio && radio.isActive) {
            Logger.debug('[AdvancedSearch] Disabling Radio Mode for playlist.');
            radio.disable();
        }

        eventBus.emit('playlist:active', { isActive: true, workIds, playlistId: result.id });

        setTimeout(() => {
            bridge.router.push('/playlists');
            close();
        }, 1000);
    } catch (e) {
        Logger.error('[AdvancedSearch] Create playlist failed:', e);
        setStatus(t('advPlaylistFailed'), false);
    } finally {
        generating.value = false;
    }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// Refresh sort UI every time dialog opens
watch(isOpen, (open) => {
    if (open) {
        refreshSortUi();
        ensureHostSortWatcher();
    }
});

// When the dialog first mounts, start loading metadata in background
onMounted(() => {
    void loadMetadataLists();
    ensureHostSortWatcher();
    document.addEventListener('keydown', onKeydown);
});

onUnmounted(() => {
    document.removeEventListener('keydown', onKeydown);
    if (sortWatcherCleanup) {
        sortWatcherCleanup();
        sortWatcherCleanup = null;
    }
});
</script>

<template>
    <Teleport to="body">
        <div
            v-if="isOpen"
            class="q-dialog fullscreen flex-center asmr-dialog-overlay"
            @click="onOverlayClick"
        >
            <div class="q-card asmr-advanced-search-dialog" @click.stop>
                <!-- Header -->
                <div class="asmr-dialog-header">
                    <h2>{{ t('advSearch') }}</h2>
                    <button
                        class="q-btn q-btn-flat q-btn-round q-btn-dense asmr-close-btn text-grey-7"
                        :aria-label="t('cancel') || 'Close'"
                        @click="close"
                    >
                        <span class="q-btn__content">
                            <i class="material-icons" aria-hidden="true">close</i>
                        </span>
                    </button>
                </div>

                <!-- Body -->
                <div class="asmr-dialog-body">
                    <!-- Row 1: Tags (Include/Exclude) -->
                    <div class="asmr-form-row">
                        <TagSelector
                            :label="t('advIncludeTags')"
                            :filter-placeholder="t('advFilterTags')"
                            :tags="tagList"
                            :selected="selectedIncludes"
                            :empty-message="t('advLoadingTags')"
                            @select="onIncludeTagSelect"
                            @remove="onIncludeTagRemove"
                        />
                        <TagSelector
                            :label="t('advExcludeTags')"
                            :filter-placeholder="t('advFilterTags')"
                            :tags="tagList"
                            :selected="selectedExcludes"
                            :empty-message="t('advLoadingTags')"
                            @select="onExcludeTagSelect"
                            @remove="onExcludeTagRemove"
                        />
                    </div>

                    <div class="asmr-separator"></div>

                    <!-- Row 2: VA and Circle -->
                    <div class="asmr-form-row">
                        <EntitySelector
                            :label="t('advVoiceActor')"
                            :filter-placeholder="t('advSearchVA')"
                            :items="(vaList as EntityItem[])"
                            :selected="(selectedVA as EntityItem | null)"
                            :translation-cache="translationCache"
                            :empty-message="t('advLoadingVA')"
                            :remove-aria-label="selectedVA ? format('advRemoveVA', { name: selectedVA.name }) : ''"
                            @select="onVASelect"
                            @clear="selectedVA = null"
                        />
                        <EntitySelector
                            :label="t('advCircle')"
                            :filter-placeholder="t('advSearchCircle')"
                            :items="(circleList as EntityItem[])"
                            :selected="(selectedCircle as EntityItem | null)"
                            :translation-cache="translationCache"
                            :empty-message="t('advLoadingCircles')"
                            :remove-aria-label="selectedCircle ? format('advRemoveCircle', { name: selectedCircle.name }) : ''"
                            @select="onCircleSelect"
                            @clear="selectedCircle = null"
                        />
                    </div>

                    <div class="asmr-separator"></div>

                    <!-- Row 3: Duration and Sort -->
                    <div class="asmr-form-row">
                        <div class="asmr-form-group">
                            <label class="asmr-form-label">{{ t('advDuration') }}</label>
                            <div class="asmr-duration-row">
                                <input
                                    type="number"
                                    class="asmr-filter-input asmr-min"
                                    :placeholder="t('advMinPlaceholder')"
                                    min="0"
                                    :aria-label="t('advMinDurationAria')"
                                    v-model="minDuration"
                                />
                                <span class="asmr-duration-separator" aria-hidden="true">-</span>
                                <input
                                    type="number"
                                    class="asmr-filter-input asmr-max"
                                    :placeholder="t('advMaxPlaceholder')"
                                    min="0"
                                    :aria-label="t('advMaxDurationAria')"
                                    v-model="maxDuration"
                                />
                                <div class="asmr-presets-group">
                                    <button
                                        class="asmr-preset-btn"
                                        :class="{ active: activePreset === 'short' }"
                                        :title="t('advPresetShortTitle')"
                                        :aria-label="t('advPresetShortAria')"
                                        :disabled="generating"
                                        @click="setDuration('0', '30')"
                                    >{{ t('advShort') }}</button>
                                    <button
                                        class="asmr-preset-btn"
                                        :class="{ active: activePreset === 'medium' }"
                                        :title="t('advPresetMediumTitle')"
                                        :aria-label="t('advPresetMediumAria')"
                                        :disabled="generating"
                                        @click="setDuration('30', '120')"
                                    >{{ t('advMedium') }}</button>
                                    <button
                                        class="asmr-preset-btn"
                                        :class="{ active: activePreset === 'long' }"
                                        :title="t('advPresetLongTitle')"
                                        :aria-label="t('advPresetLongAria')"
                                        :disabled="generating"
                                        @click="setDuration('120', '')"
                                    >{{ t('advLong') }}</button>
                                </div>
                            </div>
                        </div>
                        <div class="asmr-form-group">
                            <label class="asmr-form-label">{{ t('advSortBy') }}</label>
                            <select
                                class="asmr-sort-select asmr-sort-order"
                                v-model="sortOrder"
                                @change="onSortOrderChange"
                            >
                                <option
                                    v-for="opt in sortOptions"
                                    :key="opt.order"
                                    :value="opt.order"
                                >{{ opt.label }}</option>
                            </select>
                            <div class="asmr-sort-direction">
                                <button
                                    class="asmr-sort-dir-btn"
                                    :class="{ active: sortDirection === 'desc' }"
                                    :aria-label="t('advSortDescAria')"
                                    @click="setSortDirection('desc')"
                                >{{ t('advDesc') }}</button>
                                <button
                                    class="asmr-sort-dir-btn"
                                    :class="{ active: sortDirection === 'asc' }"
                                    :aria-label="t('advSortAscAria')"
                                    @click="setSortDirection('asc')"
                                >{{ t('advAsc') }}</button>
                            </div>
                        </div>
                    </div>

                    <div class="asmr-separator"></div>

                    <!-- Row 4: Rating, Price, Sales -->
                    <div class="asmr-form-row asmr-form-row-3">
                        <div class="asmr-form-group">
                            <label class="asmr-form-label">{{ t('advMinRating') }}</label>
                            <input
                                type="number"
                                class="asmr-filter-input asmr-rate-min"
                                :placeholder="t('advMinRatingPlaceholder')"
                                min="0" max="5" step="0.1"
                                v-model="ratingMin"
                            />
                        </div>
                        <div class="asmr-form-group">
                            <label class="asmr-form-label">{{ t('advMinPrice') }}</label>
                            <input
                                type="number"
                                class="asmr-filter-input asmr-price-min"
                                :placeholder="t('advMinPricePlaceholder')"
                                min="0"
                                v-model="priceMin"
                            />
                        </div>
                        <div class="asmr-form-group">
                            <label class="asmr-form-label">{{ t('advMinSales') }}</label>
                            <input
                                type="number"
                                class="asmr-filter-input asmr-sell-min"
                                :placeholder="t('advMinSalesPlaceholder')"
                                min="0"
                                v-model="salesMin"
                            />
                        </div>
                    </div>

                    <div class="asmr-separator"></div>

                    <!-- Row 5: Age Rating and Language -->
                    <div class="asmr-form-row">
                        <div class="asmr-form-group">
                            <label class="asmr-form-label">{{ t('advAgeRating') }}</label>
                            <select class="asmr-sort-select asmr-age-rating" v-model="ageRating">
                                <option value="">{{ t('advAny') }}</option>
                                <option value="general">{{ t('advAllAges') }}</option>
                                <option value="r15">R-15</option>
                                <option value="adult">{{ t('advAdult') }}</option>
                            </select>
                        </div>
                        <div class="asmr-form-group">
                            <label class="asmr-form-label">{{ t('advLanguage') }}</label>
                            <select class="asmr-sort-select asmr-language" v-model="language">
                                <option value="">{{ t('advAny') }}</option>
                                <option value="ja">{{ t('advLangJa') }}</option>
                                <option value="en">{{ t('advLangEn') }}</option>
                                <option value="ko">{{ t('advLangKo') }}</option>
                                <option value="zh-cn">{{ t('advLangZhCn') }}</option>
                                <option value="zh-tw">{{ t('advLangZhTw') }}</option>
                            </select>
                        </div>
                    </div>
                </div>

                <!-- Footer -->
                <div class="asmr-dialog-footer">
                    <div
                        class="asmr-status-text"
                        :class="{ error: statusIsError }"
                        aria-live="polite"
                    >{{ statusText }}</div>
                    <div class="asmr-actions">
                        <div class="asmr-works-count-group">
                            <label>{{ t('advWorks') }}</label>
                            <input
                                type="number"
                                class="asmr-filter-input asmr-works-count"
                                v-model="worksCount"
                                min="1" max="100"
                            />
                        </div>
                        <button
                            class="asmr-btn asmr-btn-primary asmr-search-btn"
                            :disabled="generating"
                            @click="performSearch"
                        >{{ t('advSearchAction') }}</button>
                        <button
                            class="asmr-btn asmr-btn-secondary asmr-create-playlist-btn"
                            :disabled="generating"
                            @click="createPlaylist"
                        >{{ t('advCreatePlaylist') }}</button>
                    </div>
                </div>
            </div>
        </div>
    </Teleport>
</template>
