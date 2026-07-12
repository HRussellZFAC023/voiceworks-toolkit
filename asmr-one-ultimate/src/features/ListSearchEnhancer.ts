/**
 * ListSearchEnhancer - Augments Vue data on /tags, /circles, /vas listing pages
 * to enable bilingual search (search by translated English names).
 *
 * Instead of patching DOM text, modifies `item.name` in the host List.vue
 * component's reactive data to include both original and translated text.
 * The existing `filteredItems` computed naturally matches English keywords
 * since `item.name` now contains both languages.
 */

import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { TranslatedTags } from './TranslatedTags';
import { TranslationService } from '../services/TranslationService';
import { Logger, Config } from '../core/Utils';
import { EventBus } from '../core/EventBus';
import type { KikoeruApp } from '../types/store';

/** Shape of items in the host List.vue component */
interface ListItem {
    id: string | number;
    name: string;
    count: number;
    /** Stored by us to track original name before augmentation */
    _origName?: string;
}

/** Minimal shape of the host List.vue component instance */
interface ListVm extends KikoeruApp {
    restrict: string;
    items: ListItem[];
    keyword: string;
}

const LIST_ROUTES = new Set(['/tags', '/circles', '/vas']);
const BATCH_SIZE = 30;
const FIND_RETRY_DELAY = 200;
const FIND_MAX_RETRIES = 3;

export class ListSearchEnhancer {
    private bridge: KikoeruBridge;
    private isEnabled = false;
    private routeUnwatch?: () => void;
    private routeGuardCleanup?: () => void;
    private itemsUnwatch?: () => void;
    private configCleanup?: () => void;
    private langCleanup?: () => void;
    private currentListVm: ListVm | null = null;
    private augmentationToken = 0;

    constructor() {
        this.bridge = KikoeruBridge.getInstance();
    }

    public enable(): void {
        if (this.isEnabled) return;
        this.isEnabled = true;

        this.routeUnwatch = this.bridge.$watch?.(
            () => this.bridge.route?.path,
            () => this.onRouteChange(),
            { immediate: true },
        );

        // Guard: strip English translations that formatPair() added to item.name
        // from $circle:...$ / $va:...$ / $tag:...$ search keywords on ANY page
        const router = this.bridge.router;
        if (router?.beforeEach) {
            this.routeGuardCleanup = router.beforeEach((to, _from, next) => {
                const keyword = to.query?.keyword;
                if (typeof keyword === 'string' && keyword.includes('$')) {
                    const cleaned = this.stripTranslationsFromKeyword(keyword);
                    if (cleaned !== keyword) {
                        Logger.debug('[ListSearchEnhancer] Stripped translation from keyword:', keyword, '→', cleaned);
                        const redirect = { path: to.path, query: { ...to.query, keyword: cleaned } };
                        (next as (loc: typeof redirect) => void)(redirect);
                        return;
                    }
                }
                next();
            });
        }

        this.configCleanup = EventBus.on('config:change', ({ key, value }: { key: string; value: unknown }) => {
            if (key === 'translateMode') {
                if (value) {
                    this.tryAugment();
                } else {
                    this.augmentationToken++;
                    this.restoreOriginalNames();
                }
            }
        });
        this.langCleanup = EventBus.on('lang:change', () => {
            this.augmentationToken++;
            this.restoreOriginalNames();
            this.tryAugment();
        });

        Logger.debug('[ListSearchEnhancer] Enabled');
    }

    public disable(): void {
        if (!this.isEnabled) return;
        this.isEnabled = false;
        this.augmentationToken++;

        this.routeUnwatch?.();
        this.routeUnwatch = undefined;

        this.routeGuardCleanup?.();
        this.routeGuardCleanup = undefined;

        this.itemsUnwatch?.();
        this.itemsUnwatch = undefined;

        this.configCleanup?.();
        this.configCleanup = undefined;
        this.langCleanup?.();
        this.langCleanup = undefined;

        this.restoreOriginalNames();
        this.currentListVm = null;

        Logger.debug('[ListSearchEnhancer] Disabled');
    }

    // -----------------------------------------------------------------------
    // Route handling
    // -----------------------------------------------------------------------

    private isListPage(path?: string): boolean {
        if (!path) return false;
        return LIST_ROUTES.has(path);
    }

    private onRouteChange(): void {
        this.augmentationToken++;
        const path = this.bridge.route?.path;

        // Leaving a list page — restore originals
        if (!this.isListPage(path)) {
            if (this.currentListVm) {
                this.restoreOriginalNames();
                this.itemsUnwatch?.();
                this.itemsUnwatch = undefined;
                this.currentListVm = null;
            }
            return;
        }

        // Entering a list page — find component and augment
        this.tryAugment();
    }

    // -----------------------------------------------------------------------
    // Component discovery
    // -----------------------------------------------------------------------

    private findListComponent(): ListVm | null {
        return this.bridge.findComponent((vm: KikoeruApp) => {
            const v = vm as unknown as ListVm;
            return typeof v.restrict === 'string'
                && Array.isArray(v.items)
                && typeof v.keyword === 'string';
        }) as ListVm | null;
    }

    private async findListComponentWithRetry(): Promise<ListVm | null> {
        for (let attempt = 0; attempt < FIND_MAX_RETRIES; attempt++) {
            const vm = this.findListComponent();
            if (vm) return vm;
            await new Promise(r => setTimeout(r, FIND_RETRY_DELAY));
            if (!this.isEnabled) return null;
        }
        return null;
    }

    // -----------------------------------------------------------------------
    // Augmentation orchestration
    // -----------------------------------------------------------------------

    private async tryAugment(): Promise<void> {
        if (!this.isEnabled) return;
        if (!this.isListPage(this.bridge.route?.path)) return;
        if (!Config.get('translateMode')) return;
        const routeToken = this.augmentationToken;

        const vm = await this.findListComponentWithRetry();
        if (!vm || !this.isEnabled || routeToken !== this.augmentationToken) return;

        // Clean up previous watcher
        this.itemsUnwatch?.();

        this.currentListVm = vm;
        const augmentToken = ++this.augmentationToken;

        // Augment current items immediately
        await this.augmentItems(vm, augmentToken);

        // Translation can settle after disable, route/language changes, or a
        // replacement list component. Never install a watcher for stale state.
        if (!this.isEnabled
            || augmentToken !== this.augmentationToken
            || this.currentListVm !== vm
            || !this.isListPage(this.bridge.route?.path)
            || !Config.get('translateMode')) return;

        // Watch for items replacement (e.g. navigating /tags → /circles reuses component)
        this.itemsUnwatch = vm.$watch('items', () => {
            if (!this.isEnabled || this.currentListVm !== vm) return;
            const token = ++this.augmentationToken;
            void this.augmentItems(vm, token);
        }, { deep: false });
    }

    private async augmentItems(vm: ListVm, token: number): Promise<void> {
        if (token !== this.augmentationToken || !this.isEnabled || this.currentListVm !== vm) return;
        if (!vm.items || vm.items.length === 0) return;
        if (!Config.get('translateMode')) return;

        const restrict = vm.restrict;

        if (restrict === 'tags' && TranslationService.getUiTargetLang() === 'en') {
            this.augmentTagItems(vm);
        } else {
            await this.augmentTranslatedItems(vm, token);
        }
    }

    // -----------------------------------------------------------------------
    // Tags: instant augmentation from cached tag data
    // -----------------------------------------------------------------------

    private augmentTagItems(vm: ListVm): void {
        const tagList = TranslatedTags.getInstance().getTagList();
        const enMap = new Map<number, string>();
        for (const tag of tagList) {
            if (tag.en && tag.en !== tag.ja && tag.en !== tag.name) {
                enMap.set(tag.id, tag.en);
            }
        }

        let augmented = 0;
        for (const item of vm.items) {
            if (item._origName) continue; // Already augmented
            const id = typeof item.id === 'string' ? parseInt(item.id, 10) : item.id;
            const en = enMap.get(id);
            if (en) {
                item._origName = item.name;
                item.name = TranslationService.formatPair(item.name, en);
                augmented++;
            }
        }

        if (augmented > 0) {
            Logger.debug(`[ListSearchEnhancer] Augmented ${augmented} tags with English names`);
        }
    }

    // -----------------------------------------------------------------------
    // Circles / VAs: progressive async batch translation
    // -----------------------------------------------------------------------

    private async augmentTranslatedItems(vm: ListVm, token: number): Promise<void> {
        const toTranslate = vm.items
            .filter(item => !item._origName && this.looksJapanese(item.name));

        if (toTranslate.length === 0) return;

        Logger.debug(`[ListSearchEnhancer] Translating ${toTranslate.length} ${vm.restrict} names...`);

        for (let i = 0; i < toTranslate.length; i += BATCH_SIZE) {
            // Bail if navigated away or disabled
            if (token !== this.augmentationToken || !this.isEnabled) return;
            if (this.currentListVm !== vm) return;

            const batch = toTranslate.slice(i, i + BATCH_SIZE);
            const texts = batch.map(item => item.name);

            try {
                const results = await TranslationService.translateBatch(
                    texts,
                    TranslationService.getUiTargetLang(),
                );

                // Re-check after async
                if (token !== this.augmentationToken || !this.isEnabled) return;

                for (let j = 0; j < batch.length; j++) {
                    const item = batch[j];
                    const translated = results[j];
                    // Ensure item hasn't been replaced or already augmented
                    if (translated && translated !== item.name && !item._origName && item.name === texts[j]) {
                        item._origName = item.name;
                        item.name = TranslationService.formatPair(item.name, translated);
                    }
                }
            } catch (e) {
                Logger.warn('[ListSearchEnhancer] Batch translation failed:', e);
            }
        }

        const augmented = toTranslate.filter(i => i._origName).length;
        if (augmented > 0) {
            Logger.debug(`[ListSearchEnhancer] Augmented ${augmented} ${vm.restrict} with translations`);
        }
    }

    // -----------------------------------------------------------------------
    // Restore
    // -----------------------------------------------------------------------

    private restoreOriginalNames(): void {
        const vm = this.currentListVm;
        if (!vm?.items) return;

        let restored = 0;
        for (const item of vm.items) {
            if (item._origName) {
                item.name = item._origName;
                delete item._origName;
                restored++;
            }
        }

        if (restored > 0) {
            Logger.debug(`[ListSearchEnhancer] Restored ${restored} original names`);
        }
    }

    // -----------------------------------------------------------------------
    // Utilities
    // -----------------------------------------------------------------------

    private looksJapanese(text: string): boolean {
        return /[\u3040-\u30ff\u4e00-\u9faf]/.test(text);
    }

    /**
     * Strip translations added by formatPair() from advanced search keywords.
     * e.g. `$circle:テグラユウキ (Tegra Yuki)$` → `$circle:テグラユウキ$`
     */
    private stripTranslationsFromKeyword(keyword: string): string {
        return keyword.replace(
            /(\$(?:circle|va|tag):.*?)\s+\([^$()]+\)(\$)/g,
            '$1$2',
        );
    }
}
