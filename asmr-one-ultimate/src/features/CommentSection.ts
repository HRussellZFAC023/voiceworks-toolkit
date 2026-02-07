import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { ReviewApi } from '../api/Review';
import { DLsiteScraper } from './DLsiteScraper';
import { Logger } from '../core/Utils';
import { CentralObserver } from '../core/CentralObserver';
import { I18n } from '../core/Config';
import { TranslationService } from '../services/TranslationService';
import { AppStore } from '../store/AppStore';
import type { DLsiteUserReview } from '../types/dlsite';

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export class CommentSection {
    private bridge: KikoeruBridge;
    private scraper: DLsiteScraper;
    private currentWorkId: string | null = null;
    private currentWorkData: any = null;
    private sectionEl: HTMLElement | null = null;
    private isExpanded = false;
    private dlsiteReviews: DLsiteUserReview[] = [];
    private dlsiteLoaded = false;
    private dlsiteLoading = false;
    private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    private currentRating = 0;
    private currentText = '';
    private eagerFetchPromise: Promise<void> | null = null;
    private qRatingListener: (() => void) | null = null;
    private syncing = false;
    private dlsiteFetchFailed = false;
    private routeCleanupUnsubscribe: (() => void) | null = null;
    /** Sum of review_count across all language editions (JP + CN + ...) */
    private combinedEditionReviewCount = 0;

    constructor() {
        this.bridge = KikoeruBridge.getInstance();
        this.scraper = DLsiteScraper.getInstance();
    }

    public enable(): void {
        const app = this.bridge.app;
        if (app && typeof (app as any).$watch === 'function') {
            (app as any).$watch('$route', () => this.checkRoute());
        }
        this.setupRouteCleanup();
        this.checkRoute();

        CentralObserver.register('CommentSection', () => {
            this.reinject();
        }, 500);
    }

    /**
     * Remove injected DOM elements before Vue processes route changes.
     * Prevents "insertBefore" errors from Vue's vDOM patching.
     * Only removes when navigating AWAY from the current work, not within it.
     */
    private setupRouteCleanup(): void {
        if (this.routeCleanupUnsubscribe) return;
        const router = this.bridge.router;
        if (!router?.beforeEach) return;

        this.routeCleanupUnsubscribe = router.beforeEach((to, _from, next) => {
            // Extract work ID from destination route
            const toPath = to?.path || '';
            const toWorkId = to?.params?.id || toPath.match(/\/work\/([^/]+)/)?.[1] || null;

            // Only remove section if navigating away from current work
            // (not when navigating within folders of the same work)
            if (!toWorkId || toWorkId !== this.currentWorkId) {
                this.removeSection();
            }
            next();
        });
    }

    private async checkRoute() {
        const route = this.bridge.router.currentRoute;
        if (route.name === 'work' || route.path.startsWith('/work/')) {
            const id = route.params.id;
            if (id && id !== this.currentWorkId) {
                this.currentWorkId = id;
                this.dlsiteReviews = [];
                this.dlsiteLoaded = false;
                this.dlsiteLoading = false;
                this.eagerFetchPromise = null;
                this.dlsiteFetchFailed = false;
                this.combinedEditionReviewCount = 0;
                await this.load(id);
            }
        } else {
            this.currentWorkId = null;
            this.currentWorkData = null;
            this.removeSection();
        }
    }

    private async load(workId: string) {
        this.removeSection();

        // Get work data from Vuex store or API
        const work = await this.getWorkData(workId);
        if (this.currentWorkId !== workId) return; // Guard: navigation changed during fetch
        this.currentWorkData = work;

        // Extract existing review data
        this.currentRating = work?.userRating || 0;
        this.currentText = work?.review_text || '';

        // Fetch combined review_count across all language editions (JP + CN + ...)
        await this.fetchCombinedEditionReviewCount();
        if (this.currentWorkId !== workId) return; // Guard: navigation changed during fetch

        this.renderSection();
        this.injectInDom();

        // Patch the host app's native comment count in the DOM
        this.patchHostCommentCount();

        // Eagerly fetch DLsite reviews in background so they're ready when expanded
        if (!this.dlsiteLoaded && !this.dlsiteLoading) {
            this.eagerFetchPromise = this.fetchDLsiteReviewsData();
        }
    }

    private async getWorkData(id: string): Promise<any> {
        const storeWork = this.bridge.store?.state?.AudioPlayer?.work;
        if (storeWork && String(storeWork.id) === String(id)) return storeWork;
        const worksState = (this.bridge.store?.state as any)?.Works;
        const cachedWork = worksState?.work || worksState?.currentWork || worksState?.detail;
        if (cachedWork && String(cachedWork.id) === String(id)) return cachedWork;

        try {
            const axios = this.bridge.axios;
            const res = await axios.get(`/api/work/${id}`);
            return res.data;
        } catch (e) {
            Logger.warn('[CommentSection] Failed to fetch work data', e);
            return null;
        }
    }

    private renderSection() {
        const section = document.createElement('div');
        section.className = 'asmr-comments-section q-mb-md';
        section.setAttribute('data-asmr-comments', '1');

        // Header (always visible)
        const header = this.renderHeader();
        section.appendChild(header);

        // Body (collapsible)
        const body = document.createElement('div');
        body.className = 'asmr-comments-body';
        if (this.isExpanded) body.classList.add('asmr-comments-body--expanded');

        const inner = document.createElement('div');
        inner.className = 'asmr-comments-body-inner';

        // My Review editor
        inner.appendChild(this.renderEditor());

        // DLsite reviews area (placeholder until loaded)
        const dlsiteArea = document.createElement('div');
        dlsiteArea.className = 'asmr-comments-dlsite-area';
        inner.appendChild(dlsiteArea);

        body.appendChild(inner);
        section.appendChild(body);

        this.sectionEl = section;

        // If expanded and reviews already fetched, render them immediately
        if (this.isExpanded && this.dlsiteLoaded) {
            this.renderDLsiteReviews(dlsiteArea);
        } else if (this.isExpanded) {
            // Expanded but still loading — show skeleton and wait
            this.lazyLoadDLsiteReviews();
        }
    }

    private renderHeader(): HTMLElement {
        const header = document.createElement('div');
        header.className = 'asmr-comments-header';

        const icon = document.createElement('i');
        icon.className = 'material-icons asmr-comments-header-icon';
        icon.textContent = 'forum';
        header.appendChild(icon);

        const label = document.createElement('span');
        label.className = 'asmr-comments-header-label';
        label.textContent = I18n.t('commentsHeader');
        header.appendChild(label);

        // Badge showing count
        const reviewCount = this.getReviewCount();
        if (reviewCount > 0) {
            const badge = document.createElement('span');
            badge.className = 'asmr-comments-badge';
            badge.textContent = String(reviewCount);
            header.appendChild(badge);
        }

        const chevron = document.createElement('i');
        chevron.className = 'material-icons asmr-comments-chevron';
        if (this.isExpanded) chevron.classList.add('asmr-comments-chevron--expanded');
        chevron.textContent = 'expand_more';
        header.appendChild(chevron);

        header.addEventListener('click', () => {
            this.isExpanded = !this.isExpanded;
            const body = this.sectionEl?.querySelector('.asmr-comments-body');
            const chev = this.sectionEl?.querySelector('.asmr-comments-chevron');
            if (body) body.classList.toggle('asmr-comments-body--expanded', this.isExpanded);
            if (chev) chev.classList.toggle('asmr-comments-chevron--expanded', this.isExpanded);

            if (this.isExpanded) {
                this.lazyLoadDLsiteReviews();
            }
        });

        return header;
    }

    private renderEditor(): HTMLElement {
        const editor = document.createElement('div');
        editor.className = 'asmr-comments-editor';

        // Header row: label + stars
        const editorHeader = document.createElement('div');
        editorHeader.className = 'asmr-comments-editor-header';

        const editorLabel = document.createElement('span');
        editorLabel.className = 'asmr-comments-editor-label';
        editorLabel.textContent = I18n.t('commentsMyReview');
        editorHeader.appendChild(editorLabel);

        const starsContainer = this.renderStarRating();
        editorHeader.appendChild(starsContainer);

        editor.appendChild(editorHeader);

        // Textarea
        const textarea = document.createElement('textarea');
        textarea.className = 'asmr-comments-textarea';
        textarea.placeholder = I18n.t('commentsPlaceholder');
        textarea.value = this.currentText;

        textarea.addEventListener('input', () => {
            this.currentText = textarea.value;
            this.debouncedSave();
        });

        editor.appendChild(textarea);

        // Actions row: save status + delete
        const actions = document.createElement('div');
        actions.className = 'asmr-comments-actions';

        const saveStatus = document.createElement('span');
        saveStatus.className = 'asmr-comments-save-status';
        saveStatus.setAttribute('data-save-status', '1');
        actions.appendChild(saveStatus);

        if (this.currentRating > 0 || this.currentText) {
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'asmr-comments-delete-btn';
            deleteBtn.innerHTML = `<i class="material-icons" style="font-size:14px">delete</i> ${escapeHtml(I18n.t('commentsDelete'))}`;
            deleteBtn.addEventListener('click', () => this.handleDelete());
            actions.appendChild(deleteBtn);
        }

        editor.appendChild(actions);

        return editor;
    }

    private renderStarRating(): HTMLElement {
        const container = document.createElement('div');
        container.className = 'asmr-comments-stars';

        for (let i = 1; i <= 5; i++) {
            const star = document.createElement('i');
            star.className = `material-icons asmr-comments-star${i <= this.currentRating ? ' asmr-comments-star--active' : ''}`;
            star.textContent = i <= this.currentRating ? 'star' : 'star_border';
            star.addEventListener('click', () => {
                this.currentRating = i;
                this.updateStarsUI(container);
                this.clickQRatingStar(i);
                this.handleSave();
            });
            container.appendChild(star);
        }

        return container;
    }

    private updateStarsUI(container: HTMLElement) {
        const stars = container.querySelectorAll('.asmr-comments-star');
        stars.forEach((star, idx) => {
            const active = idx < this.currentRating;
            star.classList.toggle('asmr-comments-star--active', active);
            star.textContent = active ? 'star' : 'star_border';
        });
    }

    // =========================================================================
    // q-rating <-> CommentSection star sync
    // =========================================================================

    /**
     * Set up bidirectional sync between the host app's Quasar q-rating
     * and our custom CommentSection stars.
     */
    private setupQRatingSync() {
        this.teardownQRatingSync();

        const handler = (e: Event) => {
            if (this.syncing) return;

            const target = e.target;
            if (!(target instanceof HTMLElement)) return;
            const container = target.closest('.q-rating--editable');
            if (!container) return;
            const iconContainer = target.closest('.q-rating__icon-container');
            if (!iconContainer) return;

            // Determine which star was clicked (1-based index)
            const allStars = Array.from(container.querySelectorAll('.q-rating__icon-container'));
            const idx = allStars.indexOf(iconContainer);
            if (idx < 0) return;

            const newRating = idx + 1;

            // Allow the host Vue component to process first, then sync
            setTimeout(() => {
                if (this.currentRating === newRating) return;
                this.currentRating = newRating;

                // Update our custom stars UI
                const starsContainer = this.sectionEl?.querySelector('.asmr-comments-stars');
                if (starsContainer) {
                    this.updateStarsUI(starsContainer as HTMLElement);
                }
                // Don't call handleSave() — the host app already saves via its own binding
            }, 0);
        };

        document.addEventListener('click', handler, true);
        this.qRatingListener = () => document.removeEventListener('click', handler, true);
    }

    private teardownQRatingSync() {
        if (this.qRatingListener) {
            this.qRatingListener();
            this.qRatingListener = null;
        }
    }

    /**
     * Update the host q-rating DOM to visually match our current rating.
     * Does NOT trigger Vue reactivity — safe to call on page load.
     */
    private syncRatingToQRating() {
        const qRating = document.querySelector('.q-rating--editable') as HTMLElement | null;
        if (!qRating) return;

        const stars = qRating.querySelectorAll('.q-rating__icon-container');
        stars.forEach((starEl, idx) => {
            const icon = starEl.querySelector('.q-rating__icon');
            if (!icon) return;
            const active = idx < this.currentRating;
            icon.textContent = active ? 'star' : 'star_border';
            starEl.setAttribute('aria-checked', active ? 'true' : 'false');
        });

        const hiddenInput = qRating.querySelector('input[type="hidden"]') as HTMLInputElement | null;
        if (hiddenInput) {
            hiddenInput.value = String(this.currentRating);
        }
    }

    /**
     * Programmatically click the host q-rating star so Vue picks up the change.
     * Only call this on user-initiated star clicks, not on page load.
     */
    private clickQRatingStar(rating: number) {
        const qRating = document.querySelector('.q-rating--editable') as HTMLElement | null;
        if (!qRating) return;

        const stars = qRating.querySelectorAll('.q-rating__icon-container');
        const target = stars[rating - 1] as HTMLElement | undefined;
        if (target) {
            this.syncing = true;
            target.click();
            this.syncing = false;
        }
    }

    private debouncedSave() {
        if (this.saveDebounceTimer) clearTimeout(this.saveDebounceTimer);
        this.updateSaveStatus('saving');
        this.saveDebounceTimer = setTimeout(() => this.handleSave(), 800);
    }

    private async handleSave() {
        if (!this.currentWorkId) return;

        const allIds = this.getAllRelatedWorkIds();
        if (allIds.length === 0) return;

        this.updateSaveStatus('saving');

        try {
            // Save to all related work IDs (all language editions in local DB)
            await Promise.all(allIds.map(id =>
                ReviewApi.updateReview({
                    work_id: id,
                    rating: this.currentRating || undefined,
                    review_text: this.currentText,
                    starOnly: false,
                })
            ));
            this.updateSaveStatus('saved');
            Logger.debug('[CommentSection] Review saved for works', allIds);
        } catch (e) {
            this.updateSaveStatus('failed');
            Logger.error('[CommentSection] Save failed', e);
        }
    }

    private async handleDelete() {
        if (!this.currentWorkId) return;
        if (!confirm(I18n.t('commentsDeleteConfirm'))) return;

        const allIds = this.getAllRelatedWorkIds();
        if (allIds.length === 0) return;

        try {
            // Delete from all related work IDs
            await Promise.all(allIds.map(id => ReviewApi.deleteReview(id)));
            this.currentRating = 0;
            this.currentText = '';
            this.syncRatingToQRating();

            // Re-render section
            // TODO: No-op assignment — wasExpanded is read from this.isExpanded and written back unchanged.
            // This likely intended to force a re-render or preserve expand state across renderSection(),
            // but renderSection() reads this.isExpanded directly, so this assignment has no effect.
            const wasExpanded = this.isExpanded;
            this.isExpanded = wasExpanded;
            this.renderSection();
            this.injectInDom();

            Logger.debug('[CommentSection] Review deleted for works', allIds);
        } catch (e) {
            Logger.error('[CommentSection] Delete failed', e);
        }
    }

    private updateSaveStatus(state: 'saving' | 'saved' | 'failed') {
        const el = this.sectionEl?.querySelector('[data-save-status]');
        if (!el) return;

        el.className = 'asmr-comments-save-status';
        switch (state) {
            case 'saving':
                el.classList.add('asmr-comments-save-status--saving');
                el.textContent = I18n.t('commentsSaving');
                break;
            case 'saved':
                el.classList.add('asmr-comments-save-status--saved');
                el.textContent = I18n.t('commentsSaved');
                setTimeout(() => {
                    if (el.textContent === I18n.t('commentsSaved')) {
                        el.textContent = '';
                    }
                }, 3000);
                break;
            case 'failed':
                el.classList.add('asmr-comments-save-status--failed');
                el.textContent = I18n.t('commentsSaveFailed');
                break;
        }
    }

    // =========================================================================
    // DLsite Reviews
    // =========================================================================

    /**
     * Fetch DLsite reviews data (no DOM interaction).
     * Called eagerly on page load so data is ready when user expands.
     */
    private async fetchDLsiteReviewsData(): Promise<void> {
        if (this.dlsiteLoading || this.dlsiteLoaded) return;

        const workIdAtStart = this.currentWorkId;
        if (!workIdAtStart) return;

        this.dlsiteLoading = true;

        const allCodes = this.extractAllRjCodes();
        Logger.debug('[CommentSection] Eager fetch starting for', allCodes.length, 'RJ codes:', allCodes);
        if (allCodes.length === 0) {
            this.dlsiteLoading = false;
            this.dlsiteLoaded = true;
            return;
        }

        try {
            // Fetch reviews from all editions in parallel
            const results = await Promise.allSettled(
                allCodes.map(code => this.scraper.scrapeReviews(code))
            );

            if (this.currentWorkId !== workIdAtStart) {
                this.dlsiteLoading = false;
                return; // Guard: navigation changed during fetch
            }

            // Merge and deduplicate reviews across editions
            const seen = new Set<string>();
            const merged: DLsiteUserReview[] = [];
            let fetchedCount = 0;
            for (const result of results) {
                if (result.status !== 'fulfilled') continue;
                fetchedCount += result.value.length;
                for (const review of result.value) {
                    if (!review.rating || review.rating <= 0) continue;
                    const key = `${review.username}:${review.text.slice(0, 50)}`;
                    if (!seen.has(key)) {
                        seen.add(key);
                        merged.push(review);
                    }
                }
            }

            this.dlsiteReviews = merged;
            this.dlsiteLoaded = true;
            this.dlsiteLoading = false;
            // Mark as failed if we expected reviews but got none (likely geo-blocked)
            if (fetchedCount === 0 && this.combinedEditionReviewCount > 0) {
                this.dlsiteFetchFailed = true;
            }
            Logger.debug(`[CommentSection] Eager fetch complete: ${merged.length} reviews merged from ${allCodes.length} editions`);

            // Eagerly pre-translate all review paragraphs in parallel
            // so translations are cached and ready when the user expands
            this.preTranslateReviews(merged);

            // Update badge count now that we have data
            this.updateBadge();

            // If section is already expanded, render reviews into DOM immediately
            if (this.isExpanded) {
                const dlsiteArea = this.sectionEl?.querySelector('.asmr-comments-dlsite-area') as HTMLElement | null;
                if (dlsiteArea) {
                    Logger.debug('[CommentSection] Section already expanded, rendering reviews now');
                    this.renderDLsiteReviews(dlsiteArea);
                }
            }
        } catch (e) {
            Logger.warn('[CommentSection] DLsite review scraping failed', e);
            this.dlsiteLoading = false;
            this.dlsiteLoaded = true;
            this.dlsiteFetchFailed = true;
        }
    }

    /**
     * Called when user expands the section. If data is already fetched, renders immediately.
     * Otherwise shows skeleton and waits for the eager fetch to complete.
     */
    private async lazyLoadDLsiteReviews() {
        const dlsiteArea = this.sectionEl?.querySelector('.asmr-comments-dlsite-area') as HTMLElement | null;
        if (!dlsiteArea) {
            Logger.warn('[CommentSection] lazyLoad: dlsite area not found in DOM');
            return;
        }

        // Already loaded — just render
        if (this.dlsiteLoaded) {
            Logger.debug(`[CommentSection] lazyLoad: already loaded, rendering ${this.dlsiteReviews.length} reviews`);
            this.renderDLsiteReviews(dlsiteArea);
            return;
        }

        // Show skeleton while waiting
        dlsiteArea.innerHTML = '';
        const skeleton = document.createElement('div');
        skeleton.className = 'asmr-comments-skeleton';
        for (let i = 0; i < 3; i++) {
            const bar = document.createElement('div');
            bar.className = 'asmr-comments-skeleton-bar';
            skeleton.appendChild(bar);
        }
        dlsiteArea.appendChild(skeleton);

        // Wait for the eager fetch (or start one if it wasn't kicked off)
        if (!this.eagerFetchPromise) {
            this.eagerFetchPromise = this.fetchDLsiteReviewsData();
        }
        await this.eagerFetchPromise;

        // Render after fetch completes (re-check area still exists)
        const area = this.sectionEl?.querySelector('.asmr-comments-dlsite-area') as HTMLElement | null;
        if (area) this.renderDLsiteReviews(area);
    }

    private renderDLsiteReviews(container: HTMLElement) {
        container.innerHTML = '';

        const validReviews = this.dlsiteReviews.filter(r => r.rating && r.rating > 0);

        if (validReviews.length === 0) {
            if (this.dlsiteFetchFailed) {
                const msg = document.createElement('div');
                msg.className = 'asmr-comments-fetch-error cursor-pointer';
                msg.title = 'Click to open settings';

                const icon = document.createElement('i');
                icon.className = 'material-icons';
                icon.textContent = 'cloud_off';
                msg.appendChild(icon);

                const span = document.createElement('span');
                span.textContent = I18n.t('commentsFetchFailed');
                msg.appendChild(span);

                msg.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.bridge.router.push('/settings');
                });

                container.appendChild(msg);
            }
            return;
        }

        // Section divider
        const divider = document.createElement('div');
        divider.className = 'asmr-comments-divider';

        const dividerLabel = document.createElement('span');
        dividerLabel.className = 'asmr-comments-divider-label';
        dividerLabel.textContent = I18n.t('commentsDLsite');
        divider.appendChild(dividerLabel);

        const dividerCount = document.createElement('span');
        dividerCount.className = 'asmr-comments-divider-count';
        dividerCount.textContent = `(${validReviews.length})`;
        divider.appendChild(dividerCount);

        container.appendChild(divider);

        // Reviews list
        const list = document.createElement('div');
        list.className = 'asmr-comments-dlsite-list';

        validReviews.forEach(review => {
            const card = this.renderDLsiteReview(review);
            if (card) list.appendChild(card);
        });

        container.appendChild(list);
    }

    private renderDLsiteReview(review: DLsiteUserReview): HTMLElement | null {
        if (!review.rating || review.rating <= 0) return null;
        const card = document.createElement('div');
        card.className = 'asmr-comments-review';

        // Header: stars + username + date
        const header = document.createElement('div');
        header.className = 'asmr-comments-review-header';

        if (review.rating > 0) {
            const stars = document.createElement('span');
            stars.className = 'asmr-comments-review-stars';
            let starsHtml = '';
            for (let i = 1; i <= 5; i++) {
                starsHtml += `<i class="material-icons${i > review.rating ? ' star-empty' : ''}">${i <= review.rating ? 'star' : 'star_border'}</i>`;
            }
            stars.innerHTML = starsHtml;
            header.appendChild(stars);
        }

        const user = document.createElement('span');
        user.className = 'asmr-comments-review-user';
        user.textContent = review.username;
        header.appendChild(user);

        if (review.date) {
            const date = document.createElement('span');
            date.className = 'asmr-comments-review-date';
            date.textContent = review.date;
            header.appendChild(date);
        }

        card.appendChild(header);

        // Text — sanitized with embedded links and auto-translated side-by-side grid
        if (review.text) {
            const sanitized = this.sanitizeReviewText(review.text);

            // Skip if sanitization removed all meaningful content
            if (!sanitized || sanitized.length < 3) return card;

            // Split into paragraphs for aligned original/translated rendering
            const paragraphs = sanitized
                .split(/\n\n+/)
                .map(p => p.trim())
                .filter(p => p.length > 0);

            const grid = document.createElement('div');
            grid.className = 'asmr-comments-review-grid';

            const shouldTranslate = AppStore.getConfig('translateMode');
            const transCells: { el: HTMLElement, text: string }[] = [];

            paragraphs.forEach(para => {
                const row = document.createElement('div');
                row.className = 'asmr-comments-review-row';

                const origCell = document.createElement('div');
                origCell.className = 'asmr-comments-review-cell asmr-comments-review-cell--original';
                origCell.innerHTML = para.replace(/\n/g, '<br>');
                row.appendChild(origCell);

                if (shouldTranslate) {
                    const transCell = document.createElement('div');
                    transCell.className = 'asmr-comments-review-cell asmr-comments-review-cell--translated';
                    transCell.textContent = '...';
                    row.appendChild(transCell);

                    const plainText = origCell.textContent || '';
                    if (plainText.length > 0) {
                        transCells.push({ el: transCell, text: plainText });
                    }
                }

                grid.appendChild(row);
            });

            // Auto-translate paragraphs in batch (only when translateMode is on)
            if (shouldTranslate && transCells.length > 0) {
                TranslationService.translateBatch(transCells.map(c => c.text)).then(results => {
                    results.forEach((translated, i) => {
                        const cell = transCells[i];
                        if (translated && translated !== cell.text) {
                            cell.el.textContent = translated;
                        } else {
                            cell.el.textContent = '';
                        }
                    });
                }).catch((e) => {
                    Logger.warn('[CommentSection] Batch translation of review paragraphs failed', e);
                    transCells.forEach(c => c.el.textContent = '');
                });
            }

            card.appendChild(grid);
        }

        return card;
    }

    /**
     * Sanitize review text: strip tracking images, page chrome, age gate content,
     * and convert markdown links to HTML. Reuses patterns from WorkMetadata.sanitizeBody().
     */
    private sanitizeReviewText(text: string): string {
        let s = text;

        // === 1. Truncate at page-chrome / age-gate boundaries ===
        const stopMarkers = [
            // Age gate
            'あなたは18歳以上ですか',
            '18歳未満の方は閲覧できない',
            '成人向け入室確認',
            'age_verification',
            // Page chrome
            'Select Language',
            'この作品を買った人',
            '最近チェックした作品',
            '関連サービス',
            'DLsiteについて',
            'ヘルプ&ガイド',
            'お支払い&ポイント',
            '推奨環境',
            '© 1996 DLsite',
            'SORRY...',
            '同人誌・同人ゲーム・同人ボイス',
            '言語と通貨を設定',
            '全年齢向けへ',
            '女性向け',
            // Shopping / navigation chrome
            '会員登録でクーポン',
            'クーポン利用価格',
            'カートに入れる',
            'お気に入りに追加',
            'この作品を買う',
            '会員登録して購入',
            '対応環境ブラウザ視聴',
            'アフィリエイトリンク作成',
            '総合トップ',
            '採用情報',
            '採用サイトへ',
            '推奨環境：最新版',
        ];
        for (const marker of stopMarkers) {
            const idx = s.indexOf(marker);
            if (idx !== -1) s = s.substring(0, idx);
        }

        // === 2. Strip dangerous HTML tags ===
        s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
        s = s.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
        s = s.replace(/<style[\s\S]*?<\/style>/gi, '');

        // === 3. Strip tracking/banner images (markdown + HTML) ===
        s = s.replace(/!\[Image \d+[^\]]*\]\([^)]*\)/g, '');
        s = s.replace(/!\[[^\]]*\]\([^)]*(?:analytics|octopuspop|adsct|twitter|doubleclick|facebook|banner|gsspat|bance|rubiconproject|modpub|logo|payment|recruit)[^)]*\)/gi, '');
        s = s.replace(/<img[^>]*src="[^"]*(?:analytics|octopuspop|adsct|twitter|doubleclick|facebook|banner|gsspat|bance|rubiconproject|modpub|logo|payment|recruit)[^"]*"[^>]*\/?>/gi, '');

        // === 4. Strip navigation links to DLsite non-product pages and external services ===
        s = s.replace(/\*?\s*\[([^\]]*)\]\(https?:\/\/(?:www\.dlsite\.com\/home\/|www\.dlsite\.com\/maniax\/work|www\.dlsite\.com\/maniax\/(?:regist|login|mypage|guide|rule|faq|inquiry)|www\.dlsite\.com\/modpub|ci-en|ch\.dlsite|www\.nijiyome|chobit|triokini|play\.dlsite|hire\.wantedly|www\.eisys|www\.geonet|cs\.dlsite|min-hon|www\.youtube|x\.com|t\.co|analytics\.twitter)[^)]*\)/gi, '');
        // Strip empty-text markdown links [](url) — navigation chrome artifacts
        s = s.replace(/\*?\s*\[\s*\]\([^)]*\)/g, '');

        // === 5. Strip markdown image refs to DLsite product images (these are ads/related works) ===
        s = s.replace(/!\[[^\]]*\]\(https?:\/\/img\.dlsite\.jp[^)]*\)/gi, '');

        // === 6. Convert remaining markdown to HTML ===
        // Links: [text](url) → <a>
        s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
        // Linkify bare URLs not already in <a> tags
        s = s.replace(/(^|[^("'])(https?:\/\/[^\s<>"')\]]+)/gm, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
        // Bold
        s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');

        // === 7. Replace TeX-style quotes with double quotes (common in translated Japanese reviews) ===
        s = s.replace(/``/g, '"');
        s = s.replace(/''/g, '"');

        // === 8. Strip price lines and shopping UI fragments ===
        s = s.replace(/^\d+\s*円\s*$/gm, '');
        s = s.replace(/^価格\s*$/gm, '');
        s = s.replace(/^Multi Lang\.\s*$/gm, '');
        s = s.replace(/^日本語\s*$/gm, '');
        s = s.replace(/^Sales:\s*\d+\s*$/gm, '');
        s = s.replace(/^\d+\s*JPY(?:Sales:\s*\d+)?\s*$/gm, '');
        s = s.replace(/^隠す\s*$/gm, '');
        s = s.replace(/^カート\s*$/gm, '');

        // === 8. Strip lines that are just DLsite section headers or OS compatibility ===
        s = s.replace(/^(?:Windows|Mac|iOS|Android|その他)-?\s*$/gm, '');
        s = s.replace(/^対応OS\s*$/gm, '');
        s = s.replace(/^対応アプリ.*$/gm, '');
        s = s.replace(/^DLsite Sound\s*$/gm, '');

        // === 9. Clean up ===
        s = s.replace(/^\*\s*$/gm, '');
        s = s.replace(/^---+$/gm, '');
        s = s.replace(/^={3,}$/gm, '');
        s = s.replace(/\n{3,}/g, '\n\n');
        s = s.trim();

        // Reject if mostly URLs or too short after cleanup
        if (s.length < 10) return '';
        const urlRatio = (s.match(/https?:\/\//g) || []).length / Math.max(1, s.split('\n').length);
        if (urlRatio > 0.5) return '';

        return s;
    }

    /**
     * Eagerly translate all review paragraphs in parallel so translations
     * are warm in the SharedCache when the user expands the section.
     * Only fires requests for texts that actually need translation.
     */
    private preTranslateReviews(reviews: DLsiteUserReview[]): void {
        if (!AppStore.getConfig('translateMode')) return;
        const texts: string[] = [];
        for (const review of reviews) {
            if (!review.text) continue;
            const sanitized = this.sanitizeReviewText(review.text);
            if (!sanitized || sanitized.length < 3) continue;
            const paragraphs = sanitized.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 0);
            for (const para of paragraphs) {
                // Strip HTML to get plain text (same as renderDLsiteReview does via textContent)
                const tmp = document.createElement('div');
                tmp.innerHTML = para.replace(/\n/g, '<br>');
                const plain = tmp.textContent || '';
                if (plain.length > 0 && !TranslationService.isUserLang(plain)) {
                    texts.push(plain);
                }
            }
        }
        if (texts.length === 0) return;
        Logger.debug(`[CommentSection] Pre-translating ${texts.length} paragraphs in bulk`);
        TranslationService.translateBatch(texts).then(() => {
            Logger.debug(`[CommentSection] Pre-translation complete`);
        }).catch(err => {
            Logger.error(`[CommentSection] Pre-translation failed`, err);
        });
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    private getReviewCount(): number {
        let count = 0;
        if (this.currentRating > 0 || this.currentText) count++;
        count += this.dlsiteReviews.filter(r => r.rating && r.rating > 0).length;
        // Use combined review_count across all language editions as fallback
        const editionCount = this.combinedEditionReviewCount || this.currentWorkData?.review_count || 0;
        if (this.dlsiteReviews.length === 0 && editionCount > 0) {
            count += editionCount;
        }
        return count;
    }

    /**
     * Fetch review_count from all language editions in the local DB and sum them.
     * For multi-language works (JP + CN + ...), each edition has its own review_count.
     */
    private async fetchCombinedEditionReviewCount(): Promise<void> {
        const work = this.currentWorkData;
        if (!work) return;

        const otherEditions = work.other_language_editions_in_db;
        if (!Array.isArray(otherEditions) || otherEditions.length === 0) {
            this.combinedEditionReviewCount = work.review_count || 0;
            return;
        }

        let total = work.review_count || 0;

        const axios = this.bridge.axios;
        const fetches = otherEditions.map(async (ed: any) => {
            const edId = ed?.id;
            if (!edId || String(edId) === String(this.currentWorkId)) return 0;
            try {
                const res = await axios.get(`/api/work/${edId}`);
                return (res.data as any)?.review_count || 0;
            } catch (e) {
                Logger.warn(`[CommentSection] Failed to fetch review count for edition ${edId}`, e);
                return 0;
            }
        });

        const counts = await Promise.all(fetches);
        total += counts.reduce((sum: number, c: number) => sum + c, 0);

        this.combinedEditionReviewCount = total;
        Logger.debug(`[CommentSection] Combined review count across ${1 + otherEditions.length} editions: ${total}`);
    }

    /**
     * Patch the host app's native comment count display (the "(N)" next to the chat icon)
     * to show the combined count across all language editions.
     */
    private patchHostCommentCount(): void {
        if (this.combinedEditionReviewCount <= 0) return;
        const work = this.currentWorkData;
        const otherEditions = work?.other_language_editions_in_db;
        if (!Array.isArray(otherEditions) || otherEditions.length === 0) return;

        const icons = document.querySelectorAll('.q-icon.material-icons');
        for (const icon of icons) {
            if (icon.textContent?.trim() === 'chat') {
                const countSpan = icon.parentElement?.querySelector('span.text-grey');
                if (countSpan) {
                    countSpan.textContent = ` (${this.combinedEditionReviewCount})`;
                }
                break;
            }
        }
    }

    private updateBadge() {
        const badge = this.sectionEl?.querySelector('.asmr-comments-badge');
        const count = this.getReviewCount();
        if (badge) {
            if (count > 0) {
                badge.textContent = String(count);
                (badge as HTMLElement).style.display = '';
            } else {
                (badge as HTMLElement).style.display = 'none';
            }
        } else if (count > 0) {
            // Add badge if it didn't exist
            const header = this.sectionEl?.querySelector('.asmr-comments-header');
            const chevron = this.sectionEl?.querySelector('.asmr-comments-chevron');
            if (header && chevron) {
                const newBadge = document.createElement('span');
                newBadge.className = 'asmr-comments-badge';
                newBadge.textContent = String(count);
                header.insertBefore(newBadge, chevron);
            }
        }
    }

    private extractRjCode(): string | null {
        const work = this.currentWorkData;
        if (!work) return null;

        // Extract RJ code from source_id, which can be:
        // - Full format: "RJ114717" or "RJ01497193"  
        // - Numeric only: "114717" or "01497193"
        const sourceId = (work.source_id || work.sourceId || '').toString();
        if (sourceId) {
            const rjMatch = sourceId.match(/RJ\d{6,8}/i);
            if (rjMatch) return rjMatch[0].toUpperCase();
            
            // source_id might be just the numeric part - add RJ prefix
            const numericMatch = sourceId.match(/\d{6,8}/);
            if (numericMatch) return 'RJ' + numericMatch[0];
        }

        // Try to extract from workId
        const workIdStr = String(this.currentWorkId);
        const idRjMatch = workIdStr.match(/RJ\d{6,8}/i);
        if (idRjMatch) return idRjMatch[0].toUpperCase();
        
        // workId might be numeric only
        const idNumericMatch = workIdStr.match(/\d{6,8}/);
        if (idNumericMatch) return 'RJ' + idNumericMatch[0];

        // Try title as last resort
        const titleMatch = work.title?.match(/RJ\d{6,8}/i);
        if (titleMatch) return titleMatch[0].toUpperCase();

        return null;
    }

    /**
     * Collect ALL RJ codes for this work across language editions.
     * Works can have JP original + CN/KR/EN translations, each with its own RJ code.
     * We scrape reviews from all editions and merge them.
     */
    private extractAllRjCodes(): string[] {
        const work = this.currentWorkData;
        const primary = this.extractRjCode();
        const codes = new Set<string>();
        if (primary) codes.add(primary);
        if (!work) return [...codes];

        // language_editions: array of { lang, workno, ... }
        const editions = work.language_editions;
        if (Array.isArray(editions)) {
            for (const ed of editions) {
                const wno = String(ed?.workno || '');
                const m = wno.match(/RJ\d{6,8}/i);
                if (m) codes.add(m[0].toUpperCase());
            }
        }

        // translation_info: parent_workno, original_workno, child_worknos
        const ti = work.translation_info;
        if (ti) {
            for (const field of ['original_workno', 'parent_workno']) {
                const val = ti[field];
                if (val && typeof val === 'string') {
                    const m = val.match(/RJ\d{6,8}/i);
                    if (m) codes.add(m[0].toUpperCase());
                }
            }
            if (Array.isArray(ti.child_worknos)) {
                for (const wno of ti.child_worknos) {
                    const m = String(wno).match(/RJ\d{6,8}/i);
                    if (m) codes.add(m[0].toUpperCase());
                }
            }
        }

        // other_language_editions_in_db: array of work objects with id/source_id
        const otherEditions = work.other_language_editions_in_db;
        if (Array.isArray(otherEditions)) {
            for (const ed of otherEditions) {
                const sid = String(ed?.source_id || ed?.sourceId || '');
                const m = sid.match(/RJ\d{6,8}/i);
                if (m) codes.add(m[0].toUpperCase());
            }
        }

        return [...codes];
    }

    /**
     * Get all kikoeru work IDs (numeric) that this work maps to.
     * Used for posting reviews to all language editions in the local DB.
     */
    private getAllRelatedWorkIds(): number[] {
        const ids = new Set<number>();
        const primary = parseInt(this.currentWorkId || '', 10);
        if (!isNaN(primary)) ids.add(primary);

        const work = this.currentWorkData;
        if (!work) return [...ids];

        // other_language_editions_in_db: array of { id, source_id, ... }
        const otherEditions = work.other_language_editions_in_db;
        if (Array.isArray(otherEditions)) {
            for (const ed of otherEditions) {
                const edId = parseInt(String(ed?.id || ''), 10);
                if (!isNaN(edId)) ids.add(edId);
            }
        }

        return [...ids];
    }

    private injectInDom() {
        if (!this.currentWorkId || !this.sectionEl) return;
        if (document.body.contains(this.sectionEl)) return;

        // Inject after the metadata panel if it exists, otherwise after the info container
        const targets = [
            '.asmr-metadata-panel',
            '.col-12.col-md-8.q-pa-sm.q-pt-md-md > .q-px-sm.q-py-none',
            '.work-info .q-px-sm.q-py-none',
            '.q-page .q-px-sm.q-py-none',
            'h1.text-h6',
        ];

        for (const selector of targets) {
            const target = document.querySelector(selector);
            if (target && target.parentElement) {
                // Final check to avoid race condition double-injection
                if (document.querySelector('.asmr-comments-section[data-asmr-comments="1"]')) {
                    Logger.warn('[CommentSection] Skipping injection, section already exists');
                    return;
                }
                target.parentElement.insertBefore(this.sectionEl, target.nextSibling);
                this.setupQRatingSync();
                this.syncRatingToQRating();
                return;
            }
        }
    }

    private reinject() {
        if (!this.currentWorkId || !this.sectionEl) return;
        if (document.body.contains(this.sectionEl)) return;
        this.injectInDom();
    }

    private removeSection() {
        this.teardownQRatingSync();

        // Remove our tracked element
        if (this.sectionEl) {
            this.sectionEl.remove();
            this.sectionEl = null;
        }

        // Clean up any stray elements from the DOM (e.g. from interrupted/race condition loads)
        const strays = document.querySelectorAll('.asmr-comments-section[data-asmr-comments="1"]');
        strays.forEach(el => el.remove());

        if (this.saveDebounceTimer) {
            clearTimeout(this.saveDebounceTimer);
            this.saveDebounceTimer = null;
        }
    }
}
