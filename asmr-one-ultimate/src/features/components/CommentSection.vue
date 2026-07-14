<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { useBridge } from '../../composables/useBridge';
import { useI18n } from '../../composables/useI18n';
import { useConfig } from '../../composables/useConfig';
import { useRoute } from '../../composables/useRoute';
import { ReviewApi } from '../../api/Review';
import { DLsiteScraper } from '../DLsiteScraper';
import { TranslationService } from '../../services/TranslationService';
import { Priority } from '../../core/GpuScheduler';
import { Logger } from '../../core/Logger';
import { isChinese } from '../../core/DomUtils';
import { runPacedBatches } from '../../core/PacedBatch';
import type { DLsiteUserReview } from '../../types/dlsite';
import {
    extractAllRjCodes,
    getAllRelatedWorkIds,
    getReviewParagraphs,
    htmlToPlainText,
    sanitizeReviewHtml,
    type CommentSectionWorkLike,
} from '../commentSectionUtils';

// ---------------------------------------------------------------------------
// Composables & singletons
// ---------------------------------------------------------------------------

const bridge = useBridge();
const { t, lang } = useI18n();
const translateMode = useConfig('translateMode');
const cnToJp = useConfig('translateCnToJp');
const route = useRoute();
const scraper = DLsiteScraper.getInstance();

// ---------------------------------------------------------------------------
// Reactive state
// ---------------------------------------------------------------------------

const isExpanded = ref(false);
const currentRating = ref(0);
const currentText = ref('');
const saveStatus = ref<'idle' | 'saving' | 'saved' | 'failed'>('idle');
const dlsiteReviews = ref<DLsiteUserReview[]>([]);
const dlsiteLoaded = ref(false);
const dlsiteLoading = ref(false);
const dlsiteFetchFailed = ref(false);
const combinedEditionReviewCount = ref(0);
const currentWorkData = ref<CommentSectionWorkLike | null>(null);
const currentWorkId = ref<string | null>(null);

/** Translations for each review paragraph keyed by `${reviewIdx}:${paraIdx}` */
const translations = ref<Record<string, string>>({});

// Internal tracking
let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let eagerFetchPromise: Promise<void> | null = null;
let syncing = false;
let qRatingCleanup: (() => void) | null = null;
let savedStatusTimer: ReturnType<typeof setTimeout> | null = null;
let loadRequestVersion = 0;
let translationGeneration = 0;
const COMMENT_TRANSLATION_PRIORITY = Priority.NORMAL;

function getCommentTranslationQueueKey(workId: string | null, scope: 'preload' | 'paragraphs' = 'paragraphs'): string {
    return `comments:${workId || 'unknown'}:${scope}`;
}

function clearCommentTranslationQueues(workId: string | null): void {
    TranslationService.cancelPending({ cancellableKey: getCommentTranslationQueueKey(workId, 'preload') });
    TranslationService.cancelPending({ cancellableKey: getCommentTranslationQueueKey(workId, 'paragraphs') });
}

// ---------------------------------------------------------------------------
// Computed
// ---------------------------------------------------------------------------

const workIdFromRoute = computed(() => {
    const currentRoute = route.value;
    if (currentRoute?.name === 'work' || currentRoute?.path?.startsWith('/work/')) {
        return currentRoute.params?.id || null;
    }
    return null;
});

const validDlsiteReviews = computed(() =>
    dlsiteReviews.value.filter(r => r.rating && r.rating > 0)
);

const reviewCount = computed(() => {
    let count = 0;
    if (currentRating.value > 0 || currentText.value) count++;
    count += validDlsiteReviews.value.length;
    const editionCount = combinedEditionReviewCount.value || currentWorkData.value?.review_count || 0;
    if (dlsiteReviews.value.length === 0 && editionCount > 0) {
        count += editionCount;
    }
    return count;
});

const hasExistingReview = computed(() => currentRating.value > 0 || !!currentText.value);

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

type RootStoreStateLike = {
    AudioPlayer?: { work?: CommentSectionWorkLike | null };
    Works?: {
        work?: CommentSectionWorkLike | null;
        currentWork?: CommentSectionWorkLike | null;
        detail?: CommentSectionWorkLike | null;
    };
};

async function getWorkData(id: string): Promise<CommentSectionWorkLike | null> {
    const state = bridge.store?.state as RootStoreStateLike | undefined;
    const storeWork = state?.AudioPlayer?.work;
    if (storeWork && String(storeWork.id) === String(id)) return storeWork;
    const worksState = state?.Works;
    const cachedWork = worksState?.work ?? worksState?.currentWork ?? worksState?.detail;
    if (cachedWork && String(cachedWork.id) === String(id)) return cachedWork;

    try {
        const res = await bridge.axios.get<CommentSectionWorkLike>(`/api/work/${id}`);
        return res.data ?? null;
    } catch (e) {
        Logger.warn('[CommentSection] Failed to fetch work data', e);
        return null;
    }
}

async function fetchCombinedEditionReviewCount(expectedVersion: number, expectedWorkId: string): Promise<void> {
    const work = currentWorkData.value;
    if (!work) return;

    const otherEditions = work.other_language_editions_in_db;
    if (!Array.isArray(otherEditions) || otherEditions.length === 0) {
        combinedEditionReviewCount.value = work.review_count || 0;
        return;
    }

    let total = work.review_count || 0;

    const counts = await runPacedBatches(otherEditions, async ed => {
        const edId = ed?.id;
        if (!edId || String(edId) === String(currentWorkId.value)) return 0;
        try {
            const res = await bridge.axios.get<{ review_count?: number }>(`/api/work/${edId}`);
            return res.data?.review_count || 0;
        } catch (e) {
            Logger.warn(`[CommentSection] Failed to fetch review count for edition ${edId}`, e);
            return 0;
        }
    }, { batchSize: 2, delayMs: 300 });
    if (loadRequestVersion !== expectedVersion || currentWorkId.value !== expectedWorkId) return;
    total += counts.reduce((sum, result) =>
        sum + (result.status === 'fulfilled' ? result.value : 0), 0);

    combinedEditionReviewCount.value = total;
    Logger.debug(`[CommentSection] Combined review count across ${1 + otherEditions.length} editions: ${total}`);
}

async function fetchDLsiteReviewsData(expectedVersion = loadRequestVersion): Promise<void> {
    if (dlsiteLoading.value || dlsiteLoaded.value) return;

    const workIdAtStart = currentWorkId.value;
    if (!workIdAtStart) return;

    dlsiteLoading.value = true;

    const allCodes = extractAllRjCodes(currentWorkData.value, currentWorkId.value);
    Logger.debug('[CommentSection] Eager fetch starting for', allCodes.length, 'RJ codes:', allCodes);
    if (allCodes.length === 0) {
        dlsiteLoading.value = false;
        dlsiteLoaded.value = true;
        return;
    }

    try {
        const results = await runPacedBatches(
            allCodes,
            code => scraper.scrapeReviews(code),
            { batchSize: 2, delayMs: 500 },
        );

        if (loadRequestVersion !== expectedVersion || currentWorkId.value !== workIdAtStart) {
            dlsiteLoading.value = false;
            return;
        }

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

        dlsiteReviews.value = merged;
        dlsiteLoaded.value = true;
        dlsiteLoading.value = false;

        if (fetchedCount === 0 && combinedEditionReviewCount.value > 0) {
            dlsiteFetchFailed.value = true;
        }
        Logger.debug(`[CommentSection] Eager fetch complete: ${merged.length} reviews merged from ${allCodes.length} editions`);

        preTranslateReviews(merged);
    } catch (e) {
        Logger.warn('[CommentSection] DLsite review scraping failed', e);
        dlsiteLoading.value = false;
        dlsiteLoaded.value = true;
        dlsiteFetchFailed.value = true;
    }
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

function preTranslateReviews(reviews: DLsiteUserReview[]): void {
    if (!translateMode.value && !cnToJp.value) return;
    const queueKey = getCommentTranslationQueueKey(currentWorkId.value, 'preload');
    const cnOnlyMode = !translateMode.value && cnToJp.value;
    const uiTargetLang = TranslationService.getUiTargetLang();
    const texts: string[] = [];
    const cnTexts: string[] = [];
    for (const review of reviews) {
        const paragraphs = getReviewParagraphs(review);
        for (const para of paragraphs) {
            const plain = htmlToPlainText(para);
            if (plain.length === 0) continue;
            if (cnOnlyMode) {
                if (isChinese(plain)) cnTexts.push(plain);
            } else {
                if (!TranslationService.isUserLang(plain)) texts.push(plain);
                if (cnToJp.value && isChinese(plain)) cnTexts.push(plain);
            }
        }
    }
    if (texts.length > 0) {
        Logger.debug(`[CommentSection] Pre-translating ${texts.length} paragraphs in bulk`);
        TranslationService.translateBatch(texts, uiTargetLang, {
            priority: COMMENT_TRANSLATION_PRIORITY,
            cancellable: true,
            cancellableKey: queueKey,
        }).then(() => {
            Logger.debug(`[CommentSection] Pre-translation complete`);
        }).catch(err => {
            Logger.error(`[CommentSection] Pre-translation failed`, err);
        });
    }
    if (cnTexts.length > 0) {
        Logger.debug(`[CommentSection] Pre-translating ${cnTexts.length} CN->JA paragraphs`);
        TranslationService.translateBatch(cnTexts, 'ja', {
            priority: COMMENT_TRANSLATION_PRIORITY,
            cancellable: true,
            cancellableKey: queueKey,
        }).catch(err => {
            Logger.error(`[CommentSection] CN->JA pre-translation failed`, err);
        });
    }
}

async function translateParagraphs(
    reviewIdx: number,
    paragraphs: string[],
    expectedVersion: number,
    expectedWorkId: string,
    targetLang?: string,
    expectedTranslationGeneration = translationGeneration,
): Promise<void> {
    const queueKey = getCommentTranslationQueueKey(expectedWorkId, 'paragraphs');
    const effectiveTargetLang = targetLang || TranslationService.getUiTargetLang();
    // Translate each paragraph independently so results stream into the UI
    // as they complete (cache hits appear instantly, model results trickle in).
    const promises: Promise<void>[] = [];
    for (let paraIdx = 0; paraIdx < paragraphs.length; paraIdx++) {
        const plain = htmlToPlainText(paragraphs[paraIdx]);
        if (plain.length === 0) continue;
        promises.push(
            TranslationService.translate(plain, effectiveTargetLang, {
                priority: COMMENT_TRANSLATION_PRIORITY,
                cancellable: true,
                cancellableKey: queueKey,
                sourceLanguageHint: targetLang === 'ja' ? 'zh' : 'auto',
            }).then(translated => {
                if (loadRequestVersion !== expectedVersion
                    || currentWorkId.value !== expectedWorkId
                    || expectedTranslationGeneration !== translationGeneration) return;
                translations.value[`${reviewIdx}:${paraIdx}`] = (translated && translated !== plain) ? translated : '';
            }).catch(() => {
                if (loadRequestVersion !== expectedVersion
                    || currentWorkId.value !== expectedWorkId
                    || expectedTranslationGeneration !== translationGeneration) return;
                translations.value[`${reviewIdx}:${paraIdx}`] = '';
            }),
        );
    }
    await Promise.allSettled(promises);
}

function getTranslation(reviewIdx: number, paraIdx: number): string | undefined {
    return translations.value[`${reviewIdx}:${paraIdx}`];
}

/** In CN->JP mode (translateMode off), replace CN paragraph text with JP translation inline */
function getCnToJpDisplay(para: string, reviewIdx: number, paraIdx: number): string {
    if (translateMode.value || !cnToJp.value) return para;
    const plain = htmlToPlainText(para);
    if (!isChinese(plain)) return para;
    const translation = getTranslation(reviewIdx, paraIdx);
    return translation ? sanitizeReviewHtml(translation) : para;
}

// ---------------------------------------------------------------------------
// q-rating <-> star sync (host app interop)
// ---------------------------------------------------------------------------

function setupQRatingSync(): void {
    teardownQRatingSync();

    const handler = (e: Event) => {
        if (syncing) return;
        const target = e.target;
        if (!(target instanceof HTMLElement)) return;
        const container = target.closest('.q-rating--editable');
        if (!container) return;
        const iconContainer = target.closest('.q-rating__icon-container');
        if (!iconContainer) return;

        const allStars = Array.from(container.querySelectorAll('.q-rating__icon-container'));
        const idx = allStars.indexOf(iconContainer);
        if (idx < 0) return;

        const newRating = idx + 1;
        setTimeout(() => {
            if (currentRating.value === newRating) return;
            currentRating.value = newRating;
        }, 0);
    };

    document.addEventListener('click', handler, true);
    qRatingCleanup = () => document.removeEventListener('click', handler, true);
}

function teardownQRatingSync(): void {
    if (qRatingCleanup) {
        qRatingCleanup();
        qRatingCleanup = null;
    }
}

function syncRatingToQRating(): void {
    const qRating = document.querySelector('.q-rating--editable') as HTMLElement | null;
    if (!qRating) return;

    const stars = qRating.querySelectorAll('.q-rating__icon-container');
    stars.forEach((starEl, idx) => {
        const icon = starEl.querySelector('.q-rating__icon');
        if (!icon) return;
        const active = idx < currentRating.value;
        icon.textContent = active ? 'star' : 'star_border';
        starEl.setAttribute('aria-checked', active ? 'true' : 'false');
    });

    const hiddenInput = qRating.querySelector('input[type="hidden"]') as HTMLInputElement | null;
    if (hiddenInput) {
        hiddenInput.value = String(currentRating.value);
    }
}

function clickQRatingStar(rating: number): void {
    const qRating = document.querySelector('.q-rating--editable') as HTMLElement | null;
    if (!qRating) return;

    const stars = qRating.querySelectorAll('.q-rating__icon-container');
    const target = stars[rating - 1] as HTMLElement | undefined;
    if (target) {
        syncing = true;
        target.click();
        syncing = false;
    }
}

// ---------------------------------------------------------------------------
// Patch host comment count
// ---------------------------------------------------------------------------

function patchHostCommentCount(): void {
    const work = currentWorkData.value;
    if (!work) return;
    const otherEditions = work.other_language_editions_in_db;
    const useCombinedCount = Array.isArray(otherEditions) && otherEditions.length > 0;
    const targetCount = useCombinedCount
        ? combinedEditionReviewCount.value
        : (work.review_count || 0);

    const icons = document.querySelectorAll('.q-icon.material-icons');
    for (const icon of icons) {
        if (icon.textContent?.trim() === 'chat') {
            const countSpan = icon.parentElement?.querySelector('span.text-grey');
            if (countSpan) {
                countSpan.textContent = ` (${targetCount})`;
            }
            break;
        }
    }
}

// ---------------------------------------------------------------------------
// Save / Delete handlers
// ---------------------------------------------------------------------------

function updateSaveStatus(state: 'saving' | 'saved' | 'failed'): void {
    saveStatus.value = state;
    if (savedStatusTimer) {
        clearTimeout(savedStatusTimer);
        savedStatusTimer = null;
    }
    if (state === 'saved') {
        savedStatusTimer = setTimeout(() => {
            if (saveStatus.value === 'saved') {
                saveStatus.value = 'idle';
            }
        }, 3000);
    }
}

function debouncedSave(): void {
    if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
    updateSaveStatus('saving');
    saveDebounceTimer = setTimeout(() => handleSave(), 800);
}

async function handleSave(): Promise<void> {
    if (!currentWorkId.value) return;

    const allIds = getAllRelatedWorkIds(currentWorkId.value, currentWorkData.value);
    if (allIds.length === 0) return;

    updateSaveStatus('saving');

    try {
        const results = await runPacedBatches(allIds, id =>
            ReviewApi.updateReview({
                work_id: id,
                rating: currentRating.value || undefined,
                review_text: currentText.value,
                starOnly: false,
            }),
            { batchSize: 2, delayMs: 250 },
        );
        const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failed) throw failed.reason;
        updateSaveStatus('saved');
        Logger.debug('[CommentSection] Review saved for works', allIds);
    } catch (e) {
        updateSaveStatus('failed');
        Logger.error('[CommentSection] Save failed', e);
    }
}

async function handleDelete(): Promise<void> {
    if (!currentWorkId.value) return;
    if (!confirm(t('commentsDeleteConfirm'))) return;

    const allIds = getAllRelatedWorkIds(currentWorkId.value, currentWorkData.value);
    if (allIds.length === 0) return;

    try {
        const results = await runPacedBatches(
            allIds,
            id => ReviewApi.deleteReview(id),
            { batchSize: 2, delayMs: 250 },
        );
        const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failed) throw failed.reason;
        currentRating.value = 0;
        currentText.value = '';
        syncRatingToQRating();
        Logger.debug('[CommentSection] Review deleted for works', allIds);
    } catch (e) {
        Logger.error('[CommentSection] Delete failed', e);
    }
}

// ---------------------------------------------------------------------------
// Star click handler
// ---------------------------------------------------------------------------

function onStarClick(starIdx: number): void {
    currentRating.value = starIdx;
    clickQRatingStar(starIdx);
    handleSave();
}

// ---------------------------------------------------------------------------
// Expand / collapse
// ---------------------------------------------------------------------------

function toggleExpand(): void {
    isExpanded.value = !isExpanded.value;
    if (isExpanded.value) {
        lazyLoadDLsiteReviews();
    }
}

async function lazyLoadDLsiteReviews(): Promise<void> {
    if (dlsiteLoaded.value) return;

    if (!eagerFetchPromise) {
        const expectedVersion = loadRequestVersion;
        eagerFetchPromise = fetchDLsiteReviewsData(expectedVersion);
    }
    await eagerFetchPromise;
}

// ---------------------------------------------------------------------------
// Fetch-error click handler: navigate to settings
// ---------------------------------------------------------------------------

function onFetchErrorClick(): void {
    bridge.router.push('/settings');
}

// ---------------------------------------------------------------------------
// Main load routine
// ---------------------------------------------------------------------------

function resetStateForWorkSwitch(): void {
    translationGeneration++;
    clearCommentTranslationQueues(currentWorkId.value);
    dlsiteReviews.value = [];
    dlsiteLoaded.value = false;
    dlsiteLoading.value = false;
    dlsiteFetchFailed.value = false;
    combinedEditionReviewCount.value = 0;
    currentRating.value = 0;
    currentText.value = '';
    saveStatus.value = 'idle';
    currentWorkData.value = null;
    eagerFetchPromise = null;
    translations.value = {};
}

async function load(workId: string): Promise<void> {
    const expectedVersion = ++loadRequestVersion;
    resetStateForWorkSwitch();

    const work = await getWorkData(workId);
    if (loadRequestVersion !== expectedVersion || currentWorkId.value !== workId) return;
    currentWorkData.value = work;

    currentRating.value = work?.userRating || 0;
    currentText.value = work?.review_text || '';
    patchHostCommentCount();

    await fetchCombinedEditionReviewCount(expectedVersion, workId);
    if (loadRequestVersion !== expectedVersion || currentWorkId.value !== workId) return;

    patchHostCommentCount();

    // Setup q-rating sync after DOM settles
    await nextTick();
    setupQRatingSync();
    syncRatingToQRating();

    // Eagerly fetch DLsite reviews in background
    if (!dlsiteLoaded.value && !dlsiteLoading.value) {
        eagerFetchPromise = fetchDLsiteReviewsData(expectedVersion);
    }
}

// ---------------------------------------------------------------------------
// Watch workId from route
// ---------------------------------------------------------------------------

watch(workIdFromRoute, (newId, oldId) => {
    if (newId && newId !== oldId) {
        clearCommentTranslationQueues(oldId || null);
        currentWorkId.value = newId;
        load(newId);
    } else if (!newId) {
        clearCommentTranslationQueues(currentWorkId.value);
        loadRequestVersion++;
        currentWorkId.value = null;
        resetStateForWorkSwitch();
        teardownQRatingSync();
    }
}, { immediate: true });

// Trigger translations when reviews load and translateMode or cnToJp is on
watch([dlsiteLoaded, translateMode, cnToJp, lang], ([loaded, shouldTranslate, cnToJpOn]) => {
    translationGeneration++;
    clearCommentTranslationQueues(currentWorkId.value);
    translations.value = {};
    if (loaded && (shouldTranslate || cnToJpOn)) {
        const expectedVersion = loadRequestVersion;
        const expectedTranslationGeneration = translationGeneration;
        const expectedWorkId = currentWorkId.value;
        if (!expectedWorkId) return;
        const cnOnlyMode = !shouldTranslate && cnToJpOn;
        validDlsiteReviews.value.forEach((review, idx) => {
            const paragraphs = getReviewParagraphs(review);
            if (paragraphs.length > 0) {
                translateParagraphs(
                    idx,
                    paragraphs,
                    expectedVersion,
                    expectedWorkId,
                    cnOnlyMode ? 'ja' : undefined,
                    expectedTranslationGeneration,
                );
            }
        });
    }
}, { immediate: true });

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

onMounted(() => {
    setupQRatingSync();
});

onUnmounted(() => {
    translationGeneration++;
    clearCommentTranslationQueues(currentWorkId.value);
    loadRequestVersion++;
    teardownQRatingSync();
    if (saveDebounceTimer) {
        clearTimeout(saveDebounceTimer);
        saveDebounceTimer = null;
    }
    if (savedStatusTimer) {
        clearTimeout(savedStatusTimer);
        savedStatusTimer = null;
    }
});

// ---------------------------------------------------------------------------
// Computed helpers for the save status display
// ---------------------------------------------------------------------------

const saveStatusText = computed(() => {
    switch (saveStatus.value) {
        case 'saving': return t('commentsSaving');
        case 'saved': return t('commentsSaved');
        case 'failed': return t('commentsSaveFailed');
        default: return '';
    }
});

const saveStatusClass = computed(() => {
    switch (saveStatus.value) {
        case 'saving': return 'asmr-comments-save-status--saving';
        case 'saved': return 'asmr-comments-save-status--saved';
        case 'failed': return 'asmr-comments-save-status--failed';
        default: return '';
    }
});
</script>

<template>
    <div class="asmr-comments-section q-mb-md" data-asmr-comments="1">
        <!-- Header (always visible, clickable to expand) -->
        <button class="asmr-comments-header" @click="toggleExpand"
                :aria-expanded="isExpanded"
                :aria-label="t('commentsHeader')">
            <i class="material-icons asmr-comments-header-icon">forum</i>
            <span class="asmr-comments-header-label">{{ t('commentsHeader') }}</span>
            <span v-if="reviewCount > 0" class="asmr-comments-badge">{{ reviewCount }}</span>
            <i class="material-icons asmr-comments-chevron"
               :class="{ 'asmr-comments-chevron--expanded': isExpanded }">expand_more</i>
        </button>

        <!-- Body (collapsible) -->
        <div class="asmr-comments-body"
             :class="{ 'asmr-comments-body--expanded': isExpanded }">
            <div class="asmr-comments-body-inner">
                <!-- My Review Editor -->
                <div class="asmr-comments-editor">
                    <div class="asmr-comments-editor-header">
                        <span class="asmr-comments-editor-label">{{ t('commentsMyReview') }}</span>
                        <!-- Star rating -->
                        <div class="asmr-comments-stars">
                            <i v-for="i in 5" :key="i"
                               class="material-icons asmr-comments-star"
                               :class="{ 'asmr-comments-star--active': i <= currentRating }"
                               @click.stop="onStarClick(i)">
                                {{ i <= currentRating ? 'star' : 'star_border' }}
                            </i>
                        </div>
                    </div>

                    <textarea
                        class="asmr-comments-textarea"
                        :placeholder="t('commentsPlaceholder')"
                        :value="currentText"
                        @input="currentText = ($event.target as HTMLTextAreaElement).value; debouncedSave()"
                    />

                    <!-- Actions row -->
                    <div class="asmr-comments-actions">
                        <span class="asmr-comments-save-status" :class="saveStatusClass">
                            {{ saveStatusText }}
                        </span>
                        <button
                            v-if="hasExistingReview"
                            class="asmr-comments-delete-btn"
                            @click="handleDelete">
                            <i class="material-icons" style="font-size:14px">delete</i>
                            {{ t('commentsDelete') }}
                        </button>
                    </div>
                </div>

                <!-- DLsite Reviews Area -->
                <div class="asmr-comments-dlsite-area">
                    <!-- Loading skeleton -->
                    <div v-if="isExpanded && !dlsiteLoaded && dlsiteLoading" class="asmr-comments-skeleton">
                        <div class="asmr-comments-skeleton-bar" />
                        <div class="asmr-comments-skeleton-bar" />
                        <div class="asmr-comments-skeleton-bar" />
                    </div>

                    <!-- Fetch error -->
                    <button v-else-if="isExpanded && dlsiteLoaded && validDlsiteReviews.length === 0 && dlsiteFetchFailed"
                            class="asmr-comments-fetch-error cursor-pointer"
                            :title="t('commentsOpenSettings')"
                            :aria-label="t('commentsOpenSettings')"
                            @click.stop="onFetchErrorClick">
                        <i class="material-icons">cloud_off</i>
                        <span>{{ t('commentsFetchFailed') }}</span>
                    </button>

                    <!-- DLsite reviews list -->
                    <template v-else-if="isExpanded && dlsiteLoaded && validDlsiteReviews.length > 0">
                        <!-- Section divider -->
                        <div class="asmr-comments-divider">
                            <span class="asmr-comments-divider-label">{{ t('commentsDLsite') }}</span>
                            <span class="asmr-comments-divider-count">({{ validDlsiteReviews.length }})</span>
                        </div>

                        <!-- Reviews -->
                        <div class="asmr-comments-dlsite-list">
                            <div v-for="(review, reviewIdx) in validDlsiteReviews"
                                 :key="`${review.username}-${reviewIdx}`"
                                 class="asmr-comments-review">
                                <!-- Review header: stars + username + date -->
                                <div class="asmr-comments-review-header">
                                    <span v-if="review.rating > 0" class="asmr-comments-review-stars">
                                        <i v-for="s in 5" :key="s"
                                           class="material-icons"
                                           :class="{ 'star-empty': s > review.rating }">
                                            {{ s <= review.rating ? 'star' : 'star_border' }}
                                        </i>
                                    </span>
                                    <span class="asmr-comments-review-user">{{ review.username }}</span>
                                    <span v-if="review.date" class="asmr-comments-review-date">{{ review.date }}</span>
                                </div>

                                <!-- Review text grid (original + optional translation) -->
                                <div v-if="getReviewParagraphs(review).length > 0"
                                     class="asmr-comments-review-grid">
                                    <div v-for="(para, paraIdx) in getReviewParagraphs(review)"
                                         :key="paraIdx"
                                         class="asmr-comments-review-row">
                                        <!-- eslint-disable-next-line vue/no-v-html -->
                                        <div class="asmr-comments-review-cell asmr-comments-review-cell--original"
                                             v-html="getCnToJpDisplay(para, reviewIdx, paraIdx)" />
                                        <div v-if="translateMode"
                                             class="asmr-comments-review-cell asmr-comments-review-cell--translated">
                                            {{ getTranslation(reviewIdx, paraIdx) ?? '...' }}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </template>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
/*
 * Component-level scoped styles.
 * The bulk of the CSS lives in _comments.css (global stylesheet).
 * This scoped block adds Vue-specific adjustments or overrides
 * that would not work well globally.
 */

/*
 * Ensure the root element does not get extra margin from the
 * FeatureController's container div.
 */
:deep(.asmr-comments-section) {
    /* Inherit all styles from _comments.css */
}

/*
 * Textarea v-model styling: prevent layout shift when switching
 * between idle and active states.
 */
textarea.asmr-comments-textarea {
    box-sizing: border-box;
}

/*
 * Reset button styling for accessible interactive elements
 * (header toggle and fetch-error action).
 */
button.asmr-comments-header {
    background: none;
    border: none;
    width: 100%;
    cursor: pointer;
    display: flex;
    align-items: center;
    font: inherit;
    color: inherit;
}

button.asmr-comments-fetch-error {
    background: none;
    border: none;
    width: 100%;
    cursor: pointer;
    display: flex;
    align-items: center;
    font: inherit;
    color: inherit;
}
</style>
