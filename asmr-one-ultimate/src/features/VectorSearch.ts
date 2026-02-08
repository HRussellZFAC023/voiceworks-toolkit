import { openDB, DBSchema } from 'idb';
import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { I18n, Logger, Config } from '../core/Utils';
import { CentralObserver } from '../core/CentralObserver';
import { TranslationService } from '../services/TranslationService';
import { SharedCache } from '../core/Cache';
import { HeaderActions } from '../ui/HeaderActions';
import { WorksApi } from '../api';
import { EventBus } from '../core/EventBus';
import { buildCoverUrl } from '../types/api';

import { gmRequest, retryWithBackoff, HttpError } from '../infrastructure/HttpClient';

const DEFAULT_API_SERVER = 'https://api.asmr-200.com';

/**
 * Get the API base URL from the host app's axios baseURL
 */
function getApiBaseUrl(): string {
    try {
        const bridge = KikoeruBridge.getInstance();
        const baseURL = (bridge.axios as any)?.defaults?.baseURL as string | undefined;
        if (baseURL && baseURL.startsWith('http')) {
            return baseURL.replace(/\/$/, '');
        }
    } catch { /* ignore */ }
    return DEFAULT_API_SERVER;
}

export interface VectorEntry {
    id: string;
    title: string;
    description: string;
    tags: string[];
    cover?: string;
    vector: number[];
}

interface VectorDB extends DBSchema {
    vectors: {
        key: string;
        value: VectorEntry;
    };
}

const EMBED_CONCURRENCY = 2;
const RESULT_LIMIT = 40;

export class VectorSearch {
    private bridge: KikoeruBridge;
    private dbPromise;
    private overlay: HTMLElement | null = null;
    private autoIndexRequested = false;
    private autoIndexRunning = false;
    private autoSeedTimer: number | null = null;
    private autoWatchTimer: number | null = null;
    private autoBatchTimer: number | null = null;
    private autoIndexExhausted = false;
    private bulkIndexCursor = 1;
    // Embeddings cached via SharedCache memory-only (too large for GM_*)
    private embeddingInflight = new Map<string, Promise<number[] | null>>();
    private lastResults: Array<{ entry: VectorEntry; score: number }> = [];
    private currentPage = 1;
    private embeddingMinIntervalMs = 1200;
    private embeddingCooldownUntil = 0;
    private embeddingRateLimited = false;
    private embeddingNextAt = 0;
    private langCleanup: (() => void) | null = null;
    private boundKeyHandler: ((e: KeyboardEvent) => void) | null = null;

    constructor() {
        this.bridge = KikoeruBridge.getInstance();
        this.dbPromise = openDB<VectorDB>('asmr-one-vectors', 1, {
            upgrade(db) {
                db.createObjectStore('vectors', { keyPath: 'id' });
            }
        });
        this.bulkIndexCursor = Math.max(1, Number(Config.get('vectorIndexCursor') || 1));
        this.checkPersistedRateLimit();
    }

    public enable(): void {
        // Register with central observer instead of own MutationObserver
        CentralObserver.register('VectorSearch', () => this.attachButton(), 500);
        this.attachButton();
        this.observeRoute();
        this.scheduleBackgroundIndex();
        if (!this.langCleanup) {
            this.langCleanup = EventBus.on('lang:change', () => this.handleLangChange());
        }
    }

    private attachButton(): void {
        const header = HeaderActions.ensure();
        if (!header || header.querySelector('.asmr-vector-btn')) return;
        const btn = document.createElement('button');
        btn.className = 'q-btn q-btn-flat q-btn-dense asmr-vector-btn text-white';
        btn.innerHTML = '<span class="q-btn__content"><i class="q-icon material-icons" aria-hidden="true">psychology</i></span>';
        btn.title = I18n.t('magicSearchBtn');
        btn.onclick = () => this.openDialog();
        header.appendChild(btn);
    }

    private observeRoute(): void {
        const app = this.bridge.app;
        if (!app?.$watch) return;
        (app as any).$watch('$route', () => this.indexCurrentWork());
        this.indexCurrentWork();
    }

    private scheduleBackgroundIndex(): void {
        if (this.autoSeedTimer) return;
        this.autoSeedTimer = window.setTimeout(async () => {
            if (!Config.get('vectorSearchApiKey')) {
                Logger.warn('[VectorSearch] API key missing, background index skipped.');
                return;
            }
            Logger.log('[VectorSearch] Auto-indexing in background...');
            await this.scheduleAutoIndex();
            this.startIndexWatcher();
        }, 3000);
    }

    private async indexCurrentWork(): Promise<void> {
        const work = (this.bridge.store.state.AudioPlayer?.work as any);
        if (!work?.id) return;
        if (!Config.get('vectorSearchApiKey')) return;
        const id = String(work.id);

        const db = await this.dbPromise;
        const existing = await db.get('vectors', id);
        if (existing) return;

        const title = work.title || work.name || '';
        const description = work.description || work.summary || '';
        const tags = (work.tags || []).map((t: any) => t.name || t.title || '').filter(Boolean);
        const payload = [title, description, tags.join(', ')].filter(Boolean).join('\n');
        if (!payload) return;

        const vector = await this.getEmbedding(payload);
        if (!vector) return;

        const cover = this.resolveCoverUrl(work, id) || undefined;
        await db.put('vectors', { id, title, description, tags, cover, vector });
        Logger.log('[VectorSearch] Indexed work:', id, title);
    }

    private openDialog(): void {
        if (!this.overlay) {
            this.buildDialog();
        }
        if (this.overlay) {
            this.overlay.style.display = 'flex';
            const input = this.overlay.querySelector('input');
            if (input) setTimeout(() => input.focus(), 100);
        }
        void this.ensureAutoIndexOnOpen();
    }

    private closeDialog(): void {
        if (this.overlay) this.overlay.style.display = 'none';
    }

    private removeKeyHandler(): void {
        if (this.boundKeyHandler) {
            document.removeEventListener('keydown', this.boundKeyHandler);
            this.boundKeyHandler = null;
        }
    }

    private handleLangChange(): void {
        if (!this.overlay) return;
        const isOpen = this.overlay.style.display !== 'none';
        const state = this.captureDialogState();
        this.removeKeyHandler();
        this.overlay.remove();
        this.overlay = null;
        this.buildDialog();
        this.applyDialogState(state);
        if (this.overlay) {
            (this.overlay as HTMLElement).style.display = isOpen ? 'flex' : 'none';
            if (this.lastResults.length > 0) {
                this.renderPage(this.currentPage);
            }
        }
    }

    private captureDialogState(): { query?: string; key?: string } {
        if (!this.overlay) return {};
        const query = (this.overlay.querySelector('.asmr-vector-input') as HTMLInputElement | null)?.value;
        const key = (this.overlay.querySelector('.asmr-vector-key') as HTMLInputElement | null)?.value;
        return { query, key };
    }

    private applyDialogState(state: { query?: string; key?: string }): void {
        if (!this.overlay) return;
        const queryInput = this.overlay.querySelector('.asmr-vector-input') as HTMLInputElement | null;
        if (queryInput && state.query != null) queryInput.value = state.query;
        const keyInput = this.overlay.querySelector('.asmr-vector-key') as HTMLInputElement | null;
        if (keyInput && state.key != null) keyInput.value = state.key;
        this.updateIndexCount();
    }

    private buildDialog(): void {
        const overlay = document.createElement('div');
        overlay.className = 'q-dialog fullscreen flex-center asmr-dialog-overlay';

        const card = document.createElement('div');
        card.className = 'q-card q-pa-md asmr-vector-dialog asmr-dialog-card column no-wrap';

        const hasKey = !!Config.get('vectorSearchApiKey');
        const keyWarning = hasKey ? '' : `<div class="text-caption text-negative q-mb-md">${I18n.t('magicSearchKeyMissing')}</div>`;
        const keyInput = hasKey ? '' : `
            <input class="q-input q-pa-sm rounded-borders full-width q-mb-xs asmr-vector-key" placeholder="${I18n.t('magicSearchKeyPlaceholder')}" />
            <div class="text-caption text-grey-7 q-mb-md asmr-settings-hint-text">
                ${I18n.t('magicSearchKeyHint')} <a href="https://jina.ai/" target="_blank" rel="noopener noreferrer" class="text-primary asmr-settings-link">jina.ai</a>
            </div>
        `;

        card.innerHTML = `
            <div class="row items-center justify-between q-mb-lg">
                <div class="text-h6 text-weight-bold asmr-dialog-title">${I18n.t('magicSearch')}</div>
                <button class="q-btn q-btn-flat q-btn-round q-btn-dense asmr-vector-close asmr-close-btn text-grey-7" aria-label="${I18n.t('cancel') || 'Close'}">
                    <span class="q-btn__content">
                        <i class="material-icons" aria-hidden="true">close</i>
                    </span>
                </button>
            </div>
            ${keyWarning}
            ${keyInput}
            <div class="row no-wrap items-center q-mb-sm rounded-borders asmr-search-bar">
                <i class="material-icons q-mx-sm text-grey">search</i>
                <input class="q-input full-width asmr-vector-input col text-body1" placeholder="${I18n.t('magicSearchPlaceholder')}" />
                <button class="q-btn q-btn-unelevated q-px-lg text-white asmr-vector-go q-mr-xs shadow-1" title="${I18n.t('magicSearchGo')}">
                    <span class="q-btn__content">${I18n.t('magicSearchGo')}</span>
                </button>
            </div>
            <div class="row items-center justify-between q-mb-sm asmr-vector-meta">
                <div class="asmr-vector-count text-caption text-grey"></div>
                <div class="asmr-vector-status text-caption text-grey"></div>
            </div>
            <div class="asmr-vector-result-list q-list q-list--separator is-empty" style="min-height: 150px; display: none;"></div>
            <div class="row items-center justify-between q-mt-sm asmr-vector-pagination" style="display: none;">
                <button class="q-btn q-btn-flat q-btn-dense text-primary asmr-vector-prev">${I18n.t('magicSearchPrev')}</button>
                <div class="asmr-vector-page text-caption text-grey"></div>
                <button class="q-btn q-btn-flat q-btn-dense text-primary asmr-vector-next">${I18n.t('magicSearchNext')}</button>
            </div>
        `;

        overlay.appendChild(card);
        document.body.appendChild(overlay);
        this.overlay = overlay;

        const closeBtn = card.querySelector('.asmr-vector-close');
        const input = card.querySelector('.asmr-vector-input') as HTMLInputElement;
        const keyField = card.querySelector('.asmr-vector-key') as HTMLInputElement | null;
        const searchBtn = card.querySelector('.asmr-vector-go');

        closeBtn?.addEventListener('click', () => this.closeDialog());
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) this.closeDialog();
        });

        const doSearch = () => {
            const val = input.value.trim();
            if (keyField && keyField.value.trim()) {
                Config.set('vectorSearchApiKey', keyField.value.trim());
            }
            if (val) this.search(val);
        };

        searchBtn?.addEventListener('click', doSearch);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') doSearch();
        });
        this.removeKeyHandler();
        this.boundKeyHandler = (e: KeyboardEvent) => {
            if (this.overlay?.style.display === 'none') return;
            if (e.key === 'Escape') {
                e.preventDefault();
                this.closeDialog();
            }
        };
        document.addEventListener('keydown', this.boundKeyHandler);

        const prevBtn = card.querySelector('.asmr-vector-prev') as HTMLButtonElement | null;
        const nextBtn = card.querySelector('.asmr-vector-next') as HTMLButtonElement | null;
        prevBtn?.addEventListener('click', () => this.goToPage(this.currentPage - 1));
        nextBtn?.addEventListener('click', () => this.goToPage(this.currentPage + 1));

        this.updateIndexCount();
        this.setStatus(I18n.t('magicSearchReady'), false);
    }

    private async updateIndexCount() {
        if (!this.overlay) return;
        const count = await this.countIndex();
        const countEl = this.overlay.querySelector('.asmr-vector-count');
        if (countEl) countEl.textContent = I18n.format('magicSearchWorksIndexed', { count });
    }

    private async bulkIndex(opts?: { maxPages?: number; maxWorks?: number; order?: string; sort?: string; startPage?: number }) {
        if (this.autoIndexRunning) return;
        if (!Config.get('vectorSearchApiKey')) {
            this.renderStatus(I18n.t('magicSearchKeyMissingSettings'), false);
            return;
        }
        this.autoIndexRunning = true;
        this.setStatus(I18n.t('magicSearchFetchingLatest'), true);
        try {
            const maxPages = opts?.maxPages ?? 5;
            const maxWorks = opts?.maxWorks ?? 200;
            const order = opts?.order ?? 'release';
            const sort = opts?.sort ?? 'desc';
            const startPage = Math.max(1, opts?.startPage ?? this.bulkIndexCursor);
            const endPage = startPage + maxPages - 1;
            let indexed = 0;
            let lastPage = startPage - 1;
            let exhausted = false;
            let firstWorkId: string | null = null;
            for (let page = startPage; page <= endPage; page++) {
                // Delay between page fetches to avoid rate limiting
                if (page > startPage) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
                this.setStatus(I18n.format('magicSearchFetchingPage', { page, end: endPage }), true);
                let res;
                try {
                    res = await WorksApi.getWorks({ order: order as any, sort: sort as any, page });
                } catch (fetchErr) {
                    if (fetchErr instanceof HttpError && fetchErr.status === 429) {
                        Logger.warn('[VectorSearch] Works API rate limited (429). Rescheduling.');
                        this.setStatus(I18n.t('magicSearchWorksRateLimited'), false);
                        this.scheduleNextBatch(120_000);
                        return;
                    }
                    throw fetchErr;
                }
                // Validate response structure - GM_xmlhttpRequest injection may return empty objects
                if (!res || typeof res !== 'object') {
                    Logger.warn('[VectorSearch] Invalid response from Works API (null or not an object):', res);
                    this.setStatus(I18n.t('magicSearchBulkIndexFailed'), false);
                    this.scheduleNextBatch(60_000);
                    return;
                }
                const works = res.works || [];
                if (works.length === 0) {
                    Logger.warn('[VectorSearch] Bulk index found no works on page', page);
                    exhausted = true;
                    break;
                }
                if (page === 1 && works[0]?.id) {
                    firstWorkId = String(works[0].id);
                }
                lastPage = page;
                const remaining = maxWorks - indexed;
                const pageWorks = works.slice(0, remaining);
                this.setStatus(I18n.format('magicSearchIndexingPage', { page, count: pageWorks.length }), true);
                indexed += await this.indexWorks(pageWorks);
                if (this.embeddingRateLimited) {
                    this.embeddingRateLimited = false;
                    this.autoIndexExhausted = false;
                    const delay = Math.max(0, this.embeddingCooldownUntil - Date.now());
                    this.setStatus(I18n.t('magicSearchRateLimitedJinaCooldown'), false);
                    this.scheduleNextBatch(delay || 60000);
                    return;
                }
                if (indexed >= maxWorks) break;
            }
            if (exhausted) {
                this.bulkIndexCursor = 1;
                this.autoIndexExhausted = true;
            } else if (lastPage >= startPage) {
                this.bulkIndexCursor = lastPage + 1;
                this.autoIndexExhausted = false;
            }
            Config.set('vectorIndexCursor', this.bulkIndexCursor);
            if (firstWorkId) Config.set('vectorIndexLatestWorkId', firstWorkId);
            await this.updateIndexCount();
            const total = await this.countIndex();
            if (!this.autoIndexExhausted) {
                const batchDelay = 60;
                this.setStatus(I18n.format('magicSearchIndexingContinue', { indexed, cursor: this.bulkIndexCursor, total, delay: batchDelay }), false);
                this.scheduleNextBatch(batchDelay * 1000);
            } else {
                this.setStatus(I18n.format('magicSearchIndexingPaused', { total }), false);
            }
        } catch (e) {
            Logger.error('[VectorSearch] Bulk index failed', e);
            this.setStatus(I18n.t('magicSearchBulkIndexFailed'), false);
        } finally {
            this.autoIndexRunning = false;
            this.autoIndexRequested = false;
        }
    }

    private async indexWork(work: any): Promise<boolean> {
        if (!work?.id) return false;
        const id = String(work.id);
        const db = await this.dbPromise;
        const existing = await db.get('vectors', id);
        if (existing) return false;

        const title = work.title || work.name || '';
        const tags = (work.tags || []).map((t: any) => t.name || t.title || '').filter(Boolean);
        const description = work.description || work.summary || '';
        const payload = [title, description, tags.join(', ')].filter(Boolean).join('\n').slice(0, 8000);

        const vector = await this.getEmbedding(payload);
        if (vector) {
            const cover = this.resolveCoverUrl(work, id) || undefined;
            await db.put('vectors', { id, title, description, tags, cover, vector });
            return true;
        }
        return false;
    }

    private async indexWorks(works: any[]): Promise<number> {
        if (works.length === 0) return 0;
        let added = 0;
        let index = 0;
        const workerCount = Math.min(EMBED_CONCURRENCY, works.length);
        const workers = Array.from({ length: workerCount }).map(async () => {
            while (index < works.length) {
                const work = works[index++];
                try {
                    if (await this.indexWork(work)) added += 1;
                } catch (e) {
                    Logger.warn('[VectorSearch] Index work failed', e);
                }
            }
        });
        await Promise.all(workers);
        return added;
    }

    public async search(query: string): Promise<void> {
        Logger.log('[VectorSearch] Search query:', query);
        if (this.embeddingRateLimited) {
            const wait = Math.max(0, Math.ceil((this.embeddingCooldownUntil - Date.now()) / 1000));
            Logger.warn(`[VectorSearch] Rate limited, ${wait}s remaining`);
            this.renderStatus(I18n.format('magicSearchCooldown', { wait }), false);
            return;
        }
        this.renderStatus(I18n.t('magicSearchPreparing'), true);

        const searchMeta = await this.buildSearchContext(query);
        Logger.debug('[VectorSearch] Search context:', searchMeta);
        const searchLabel = searchMeta.usedTranslation ? I18n.t('magicSearchSearchingJP') : I18n.t('magicSearchSearching');
        this.renderStatus(searchLabel, true);
        const queryVector = await this.getEmbedding(searchMeta.payload);
        if (!queryVector) {
            this.renderStatus(I18n.t('magicSearchEmbedFail'), false);
            return;
        }

        const db = await this.dbPromise;
        const entries = await db.getAll('vectors');
        if (entries.length === 0) {
            Logger.warn('[VectorSearch] Index empty. Starting auto-index.');
            this.renderStatus(I18n.t('magicSearchIndexEmpty'), true);
            await this.scheduleAutoIndex();
            const refreshed = await db.getAll('vectors');
            if (refreshed.length === 0) {
                this.renderStatus(I18n.t('magicSearchIndexEmptyCheck'), false);
                return;
            }
            const scored = refreshed.map(entry => ({
                entry,
                score: this.scoreEntry(entry, queryVector, searchMeta)
            })).sort((a, b) => b.score - a.score);
            // Free vector arrays after scoring — no longer needed, saves ~25-50MB
            for (const r of scored) (r.entry as any).vector = null;
            this.renderResults(scored);
            return;
        }

        const scored = entries.map(entry => ({
            entry,
            score: this.scoreEntry(entry, queryVector, searchMeta)
        })).sort((a, b) => b.score - a.score);
        // Free vector arrays after scoring — no longer needed, saves ~25-50MB
        for (const r of scored) (r.entry as any).vector = null;

        Logger.log(`[VectorSearch] Search completed: ${scored.length} results from ${entries.length} indexed entries`, {
            topResults: scored.slice(0, 5).map(r => ({ id: r.entry.id, title: r.entry.title, score: r.score.toFixed(3) })),
        });

        this.renderResults(scored);
    }

    private renderStatus(msg: string, loading: boolean) {
        if (!this.overlay) return;
        this.setStatus(msg, loading);
        const list = this.overlay.querySelector('.asmr-vector-result-list');
        if (!list) return;
        if (loading) {
            list.innerHTML = '';
            list.classList.add('is-empty');
            (list as HTMLElement).style.display = 'none';
            const pagination = this.overlay.querySelector('.asmr-vector-pagination') as HTMLElement | null;
            if (pagination) pagination.style.display = 'none';
        }
    }

    private renderResults(results: Array<{ entry: VectorEntry; score: number }>): void {
        if (!this.overlay) return;
        const list = this.overlay.querySelector('.asmr-vector-result-list');
        if (!list) return;

        list.innerHTML = '';
        this.lastResults = results.slice();
        this.currentPage = 1;
        if (results.length === 0) {
            this.setStatus(I18n.t('magicSearchNoMatches'), false);
            list.classList.add('is-empty');
            (list as HTMLElement).style.display = 'none';
            this.updatePagination();
            return;
        }
        this.renderPage(1);
    }

    private renderPage(page: number): void {
        if (!this.overlay) return;
        const list = this.overlay.querySelector('.asmr-vector-result-list') as HTMLElement | null;
        if (!list) return;

        const totalPages = Math.max(1, Math.ceil(this.lastResults.length / RESULT_LIMIT));
        this.currentPage = Math.max(1, Math.min(page, totalPages));
        const start = (this.currentPage - 1) * RESULT_LIMIT;
        const pageResults = this.lastResults.slice(start, start + RESULT_LIMIT);

        list.innerHTML = '';
        list.classList.remove('is-empty');
        list.style.display = 'grid'; // Required to override inline display: none

        this.setStatus(I18n.format('magicSearchShowing', { start: start + 1, end: start + pageResults.length, total: this.lastResults.length }), false);

        pageResults.forEach(({ entry, score }) => {
            const row = document.createElement('div');
            row.className = 'asmr-vector-result'; // CSS handles flex layout

            const description = (entry.description || '').trim();
            const tags = entry.tags.slice(0, 3).filter(Boolean).join(' · ');

            const cacheKey = `img-fail-${entry.id}`;
            const isFailed = SharedCache.get(cacheKey);
            const coverSrc = isFailed ? '' : buildCoverUrl(entry.id, 'main', getApiBaseUrl());

            row.innerHTML = `
                <div class="asmr-vector-thumb">
                    ${coverSrc ? `<img src="${coverSrc}" alt="" referrerpolicy="no-referrer">` : ''}
                    <div class="asmr-vector-thumb-placeholder${coverSrc ? '' : ' visible'}"><i class="material-icons">music_note</i></div>
                </div>
                <div class="q-item__section q-pa-sm asmr-result-content">
                    <div class="asmr-vector-title" title="${entry.title}">${entry.title}</div>
                    <div class="asmr-vector-title-translation hidden"></div>
                    ${description ? `<div class="asmr-vector-desc">${description}</div>` : ''}
                    <div class="asmr-vector-meta-line">
                         <span class="text-weight-bold asmr-accent">${(score * 100).toFixed(0)}${I18n.t('magicSearchMatch')}</span>
                         ${tags ? `<span class="text-grey-5 q-mx-xs">•</span><span class="text-grey-6 ellipsis">${tags}</span>` : ''}
                    </div>
                </div>
                <div class="column justify-center q-pr-sm">
                    <button class="q-btn q-btn-flat q-btn-round asmr-accent">
                         <i class="material-icons asmr-play-icon">play_circle</i>
                    </button>
                </div>
            `;
            row.addEventListener('click', () => {
                this.bridge.router.push(`/work/${entry.id}`);
                this.closeDialog();
            });
            list.appendChild(row);

            const titleTranslation = row.querySelector('.asmr-vector-title-translation') as HTMLElement | null;
            if (titleTranslation) {
                void this.translateResultTitle(entry.title, titleTranslation);
            }
            const img = row.querySelector('.asmr-vector-thumb img') as HTMLImageElement | null;
            const placeholder = row.querySelector('.asmr-vector-thumb-placeholder') as HTMLElement | null;
            if (img && placeholder) {
                img.addEventListener('load', () => { placeholder.style.display = 'none'; });
                img.addEventListener('error', () => {
                    img.style.display = 'none';
                    placeholder.style.display = 'flex';
                    SharedCache.set(cacheKey, true, 24 * 60 * 60 * 1000); // 24h cache
                });
            }
        });

        this.updatePagination();
    }

    private updatePagination(): void {
        if (!this.overlay) return;
        const pagination = this.overlay.querySelector('.asmr-vector-pagination') as HTMLElement | null;
        const pageLabel = this.overlay.querySelector('.asmr-vector-page') as HTMLElement | null;
        const prevBtn = this.overlay.querySelector('.asmr-vector-prev') as HTMLButtonElement | null;
        const nextBtn = this.overlay.querySelector('.asmr-vector-next') as HTMLButtonElement | null;
        if (!pagination || !pageLabel || !prevBtn || !nextBtn) return;

        const totalPages = Math.max(1, Math.ceil(this.lastResults.length / RESULT_LIMIT));
        if (this.lastResults.length <= RESULT_LIMIT) {
            pagination.style.display = 'none';
            return;
        }
        pagination.style.display = 'flex';
        pageLabel.textContent = I18n.format('magicSearchPage', { current: this.currentPage, total: totalPages });
        prevBtn.disabled = this.currentPage <= 1;
        nextBtn.disabled = this.currentPage >= totalPages;
    }

    private goToPage(page: number): void {
        this.renderPage(page);
    }

    private setStatus(message: string, loading: boolean): void {
        if (!this.overlay) return;
        const statusEl = this.overlay.querySelector('.asmr-vector-status') as HTMLElement | null;
        if (!statusEl) return;
        statusEl.textContent = message;
        statusEl.classList.toggle('asmr-vector-status--loading', loading);
    }

    private async getEmbedding(text: string): Promise<number[] | null> {
        if (!Config.get('vectorSearchApiKey')) {
            Logger.warn('[VectorSearch] Missing Jina API key.');
            return null;
        }
        // Use SharedCache memory-only for embeddings (too large for GM_*)
        const cacheKey = `embedding:${text}`;
        const cached = SharedCache.getMemory<number[]>(cacheKey);
        if (cached) {
            Logger.debug(`[VectorSearch] Embedding cache hit (dim=${cached.length})`);
            return cached;
        }
        if (this.embeddingInflight.has(text)) {
            Logger.debug('[VectorSearch] Embedding in-flight, waiting...');
            return this.embeddingInflight.get(text)!;
        }
        Logger.debug(`[VectorSearch] Fetching embedding for text (${text.length} chars)`);

        const task = this.waitForEmbeddingSlot().then(() => this.fetchEmbedding(text)).then((vector) => {
            if (vector) SharedCache.setMemory(cacheKey, vector, 1000 * 60 * 60); // 1 hour
            return vector;
        }).finally(() => {
            this.embeddingInflight.delete(text);
        });

        this.embeddingInflight.set(text, task);
        return task;
    }

    private async fetchEmbedding(text: string): Promise<number[] | null> {
        Logger.debug('[VectorSearch] fetchEmbedding');
        const url = 'https://api.jina.ai/v1/embeddings';
        const headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${Config.get('vectorSearchApiKey')}`,
        };
        const body = JSON.stringify({ model: 'jina-embeddings-v2-base-en', input: [text] });

        try {
            const res = await retryWithBackoff(
                () => gmRequest({ method: 'POST', url, headers, data: body, responseType: 'json' }),
                {
                    attempts: 3,
                    backoffMs: 1000,
                    multiplier: 2,
                    shouldRetry: (err) => {
                        // On 429, apply persistent rate limit and stop retrying
                        if (err instanceof HttpError && err.status === 429) {
                            this.applyRateLimit(60000);
                            return false;
                        }
                        return true;
                    },
                },
            );

            const data = typeof res.response === 'object' && res.response
                ? res.response as any
                : JSON.parse(res.responseText);

            const embedding: number[] | null = data?.data?.[0]?.embedding || null;
            Logger.debug(`[VectorSearch] Embedding received: dim=${embedding?.length || 0}`);
            if (embedding) this.resetRateLimitBackoff();
            return embedding;
        } catch (err) {
            if (err instanceof HttpError && err.status === 429) {
                // Already handled by shouldRetry
                return null;
            }
            Logger.warn('[VectorSearch] fetchEmbedding failed:', err);
            return null;
        }
    }

    private async ensureAutoIndexOnOpen(): Promise<void> {
        const count = await this.countIndex();
        if (count > 0) return;
        await this.scheduleAutoIndex();
    }

    private async waitForEmbeddingSlot(): Promise<void> {
        const now = Date.now();
        const waitUntil = Math.max(this.embeddingCooldownUntil, this.embeddingNextAt);
        const delay = Math.max(0, waitUntil - now);
        if (delay > 0) {
            await new Promise(resolve => window.setTimeout(resolve, delay));
        }
        const nextBase = Math.max(Date.now(), waitUntil);
        this.embeddingNextAt = nextBase + this.embeddingMinIntervalMs;
    }

    private applyRateLimit(delayMs: number): void {
        const currentBackoff = Number(Config.get('vectorRateLimitBackoff') || 1);
        const backoffMultiplier = Math.min(currentBackoff * 2, 8);
        const cooldownMs = Math.max(1000, delayMs * backoffMultiplier);

        this.embeddingCooldownUntil = Date.now() + cooldownMs;
        this.embeddingRateLimited = true;

        Config.set('vectorRateLimitCooldownUntil', this.embeddingCooldownUntil);
        Config.set('vectorRateLimitBackoff', backoffMultiplier);

        const waitSecs = Math.round(cooldownMs / 1000);
        this.setStatus(I18n.format('magicSearchRateLimitedRetry', { wait: waitSecs }), false);
        Logger.warn(`[VectorSearch] Rate limited by Jina. Cooling down for ${waitSecs}s (backoff: ${backoffMultiplier}x)`);
    }

    private checkPersistedRateLimit(): void {
        const persistedCooldown = Number(Config.get('vectorRateLimitCooldownUntil') || 0);
        if (persistedCooldown > Date.now()) {
            this.embeddingCooldownUntil = persistedCooldown;
            this.embeddingRateLimited = true;
        } else if (persistedCooldown > 0) {
            Config.set('vectorRateLimitBackoff', 1);
            Config.set('vectorRateLimitCooldownUntil', 0);
        }
    }

    private resetRateLimitBackoff(): void {
        if (Config.get('vectorRateLimitBackoff') !== 1) {
            Config.set('vectorRateLimitBackoff', 1);
        }
    }

    private async buildSearchContext(query: string): Promise<{ payload: string; usedTranslation: boolean; tokens: string[] }> {
        const trimmed = query.trim();
        if (!trimmed) return { payload: trimmed, usedTranslation: false, tokens: [] };
        if (this.containsJapanese(trimmed)) {
            return { payload: trimmed, usedTranslation: false, tokens: this.extractTokens(trimmed) };
        }
        const translated = await TranslationService.translate(trimmed, 'ja');
        const normalized = translated?.trim() || '';
        if (normalized && normalized !== trimmed) {
            return {
                payload: `${trimmed}\n${normalized}`,
                usedTranslation: true,
                tokens: Array.from(new Set(this.extractTokens(`${trimmed} ${normalized}`)))
            };
        }
        return { payload: trimmed, usedTranslation: false, tokens: this.extractTokens(trimmed) };
    }

    private containsJapanese(text: string): boolean {
        return /[\u3040-\u30ff\u4e00-\u9fff]/.test(text);
    }

    private extractTokens(text: string): string[] {
        return text
            .toLowerCase()
            .split(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/g)
            .map(token => token.trim())
            .filter(token => token.length >= 2);
    }



    private scoreEntry(entry: VectorEntry, vector: number[], searchMeta: { tokens: string[] }): number {
        const similarity = this.cosineSimilarity(vector, entry.vector);
        const boost = this.calculateKeywordBoost(entry, searchMeta.tokens);
        return similarity + boost;
    }

    private calculateKeywordBoost(entry: VectorEntry, tokens: string[]): number {
        if (!tokens.length) return 0;
        const title = (entry.title || '').toLowerCase();
        const description = (entry.description || '').toLowerCase();
        const tags = entry.tags.join(' ').toLowerCase();

        let boost = 0;
        let matched = 0;
        for (const token of tokens) {
            if (tags.includes(token)) {
                boost += 0.08;
                matched += 1;
            } else if (title.includes(token)) {
                boost += 0.05;
                matched += 1;
            } else if (description.includes(token)) {
                boost += 0.02;
            }
        }
        if (matched >= Math.min(2, tokens.length)) boost += 0.04;
        return boost;
    }

    private async translateResultTitle(title: string, target: HTMLElement): Promise<void> {
        if (!title || I18n.lang !== 'en') return;
        if (!this.containsJapanese(title)) return;
        const translated = await TranslationService.translate(title, 'en');
        if (!translated || translated.trim() === title.trim()) return;
        target.textContent = translated;
        target.classList.remove('hidden');
    }

    private async scheduleAutoIndex(): Promise<void> {
        if (this.autoIndexRequested || this.autoIndexRunning) return;
        this.autoIndexRequested = true;
        await this.bulkIndex({ maxPages: 6, maxWorks: 250, order: 'release', sort: 'desc' });
    }

    private scheduleNextBatch(delayMs = 60 * 1000): void {
        if (this.autoBatchTimer) return;
        this.autoBatchTimer = window.setTimeout(async () => {
            this.autoBatchTimer = null;
            if (this.autoIndexRunning || this.autoIndexExhausted) return;
            await this.scheduleAutoIndex();
        }, delayMs);
    }

    private startIndexWatcher(): void {
        if (this.autoWatchTimer) return;
        this.autoWatchTimer = window.setInterval(() => {
            void this.checkForNewWorks();
        }, 10 * 60 * 1000);
    }

    private async checkForNewWorks(): Promise<void> {
        if (this.autoIndexRunning) return;
        if (!Config.get('vectorSearchApiKey')) return;
        const res = await WorksApi.getWorks({ order: 'release', sort: 'desc', page: 1 });
        const works = res.works || [];
        if (!works.length || !works[0]?.id) return;
        const latest = String(works[0].id);
        const lastSeen = String(Config.get('vectorIndexLatestWorkId') || '');
        if (latest && latest !== lastSeen) {
            Logger.log('[VectorSearch] New works detected. Re-indexing from page 1.');
            this.bulkIndexCursor = 1;
            await this.bulkIndex({ maxPages: 3, maxWorks: 150, order: 'release', sort: 'desc', startPage: 1 });
        }

    }

    // Math utils
    private cosineSimilarity(vecA: number[], vecB: number[]): number {
        let dot = 0.0;
        let normA = 0.0;
        let normB = 0.0;
        for (let i = 0; i < vecA.length; i++) {
            dot += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        if (normA === 0 || normB === 0) return 0;
        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    private resolveCoverUrl(work: any, id: string): string | null {
        if (work.coverUrl) return work.coverUrl;
        if (work.main_cover_url) return work.main_cover_url;
        return buildCoverUrl(id, 'main', getApiBaseUrl());
    }

    private async countIndex(): Promise<number> {
        const db = await this.dbPromise;
        return db.count('vectors');
    }
}
