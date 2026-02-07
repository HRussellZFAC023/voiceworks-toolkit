<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { useBridge } from '../../composables/useBridge';
import { useI18n } from '../../composables/useI18n';
import { useConfig } from '../../composables/useConfig';
import { ReviewApi } from '../../api/Review';
import { DLsiteScraper } from '../DLsiteScraper';
import { TranslationService } from '../../services/TranslationService';
import { Logger } from '../../core/Logger';
import type { DLsiteUserReview } from '../../types/dlsite';

// ---------------------------------------------------------------------------
// Composables & singletons
// ---------------------------------------------------------------------------

const bridge = useBridge();
const { t } = useI18n();
const translateMode = useConfig('translateMode');
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
const currentWorkData = ref<any>(null);
const currentWorkId = ref<string | null>(null);

/** Translations for each review paragraph keyed by `${reviewIdx}:${paraIdx}` */
const translations = ref<Record<string, string>>({});

// Internal tracking
let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let eagerFetchPromise: Promise<void> | null = null;
let syncing = false;
let qRatingCleanup: (() => void) | null = null;
let savedStatusTimer: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------------------
// Computed
// ---------------------------------------------------------------------------

const workIdFromRoute = computed(() => {
    const route = bridge.route;
    if (route?.name === 'work' || route?.path?.startsWith('/work/')) {
        return route.params?.id || null;
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
// Review text sanitization (pure function, no DOM needed)
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sanitizeReviewText(text: string): string {
    let s = text;

    // 1. Truncate at page-chrome / age-gate boundaries
    const stopMarkers = [
        '\u3042\u306a\u305f\u306f18\u6b73\u4ee5\u4e0a\u3067\u3059\u304b',
        '18\u6b73\u672a\u6e80\u306e\u65b9\u306f\u95b2\u89a7\u3067\u304d\u306a\u3044',
        '\u6210\u4eba\u5411\u3051\u5165\u5ba4\u78ba\u8a8d',
        'age_verification',
        'Select Language',
        '\u3053\u306e\u4f5c\u54c1\u3092\u8cb7\u3063\u305f\u4eba',
        '\u6700\u8fd1\u30c1\u30a7\u30c3\u30af\u3057\u305f\u4f5c\u54c1',
        '\u95a2\u9023\u30b5\u30fc\u30d3\u30b9',
        'DLsite\u306b\u3064\u3044\u3066',
        '\u30d8\u30eb\u30d7&\u30ac\u30a4\u30c9',
        '\u304a\u652f\u6255\u3044&\u30dd\u30a4\u30f3\u30c8',
        '\u63a8\u5968\u74b0\u5883',
        '\u00a9 1996 DLsite',
        'SORRY...',
        '\u540c\u4eba\u8a8c\u30fb\u540c\u4eba\u30b2\u30fc\u30e0\u30fb\u540c\u4eba\u30dc\u30a4\u30b9',
        '\u8a00\u8a9e\u3068\u901a\u8ca8\u3092\u8a2d\u5b9a',
        '\u5168\u5e74\u9f62\u5411\u3051\u3078',
        '\u5973\u6027\u5411\u3051',
        '\u4f1a\u54e1\u767b\u9332\u3067\u30af\u30fc\u30dd\u30f3',
        '\u30af\u30fc\u30dd\u30f3\u5229\u7528\u4fa1\u683c',
        '\u30ab\u30fc\u30c8\u306b\u5165\u308c\u308b',
        '\u304a\u6c17\u306b\u5165\u308a\u306b\u8ffd\u52a0',
        '\u3053\u306e\u4f5c\u54c1\u3092\u8cb7\u3046',
        '\u4f1a\u54e1\u767b\u9332\u3057\u3066\u8cfc\u5165',
        '\u5bfe\u5fdc\u74b0\u5883\u30d6\u30e9\u30a6\u30b6\u8996\u8074',
        '\u30a2\u30d5\u30a3\u30ea\u30a8\u30a4\u30c8\u30ea\u30f3\u30af\u4f5c\u6210',
        '\u7dcf\u5408\u30c8\u30c3\u30d7',
        '\u63a1\u7528\u60c5\u5831',
        '\u63a1\u7528\u30b5\u30a4\u30c8\u3078',
        '\u63a8\u5968\u74b0\u5883\uff1a\u6700\u65b0\u7248',
    ];
    for (const marker of stopMarkers) {
        const idx = s.indexOf(marker);
        if (idx !== -1) s = s.substring(0, idx);
    }

    // 2. Strip dangerous HTML tags
    s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
    s = s.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
    s = s.replace(/<style[\s\S]*?<\/style>/gi, '');

    // 3. Strip tracking/banner images
    s = s.replace(/!\[Image \d+[^\]]*\]\([^)]*\)/g, '');
    s = s.replace(/!\[[^\]]*\]\([^)]*(?:analytics|octopuspop|adsct|twitter|doubleclick|facebook|banner|gsspat|bance|rubiconproject|modpub|logo|payment|recruit)[^)]*\)/gi, '');
    s = s.replace(/<img[^>]*src="[^"]*(?:analytics|octopuspop|adsct|twitter|doubleclick|facebook|banner|gsspat|bance|rubiconproject|modpub|logo|payment|recruit)[^"]*"[^>]*\/?>/gi, '');

    // 4. Strip navigation links
    s = s.replace(/\*?\s*\[([^\]]*)\]\(https?:\/\/(?:www\.dlsite\.com\/home\/|www\.dlsite\.com\/maniax\/work|www\.dlsite\.com\/maniax\/(?:regist|login|mypage|guide|rule|faq|inquiry)|www\.dlsite\.com\/modpub|ci-en|ch\.dlsite|www\.nijiyome|chobit|triokini|play\.dlsite|hire\.wantedly|www\.eisys|www\.geonet|cs\.dlsite|min-hon|www\.youtube|x\.com|t\.co|analytics\.twitter)[^)]*\)/gi, '');
    s = s.replace(/\*?\s*\[\s*\]\([^)]*\)/g, '');

    // 5. Strip DLsite product images
    s = s.replace(/!\[[^\]]*\]\(https?:\/\/img\.dlsite\.jp[^)]*\)/gi, '');

    // 6. Convert markdown to HTML (with XSS protection)
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_match, text, url) => {
        const safeText = escapeHtml(text);
        const safeUrl = escapeHtml(url);
        return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeText}</a>`;
    });
    s = s.replace(/(^|[^("'])(https?:\/\/[^\s<>"')\]]+)/gm, (_match, prefix, url) => {
        const safeUrl = escapeHtml(url);
        return `${prefix}<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>`;
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');

    // 7. Replace TeX-style quotes
    s = s.replace(/``/g, '\u201c');
    s = s.replace(/''/g, '\u201d');

    // 8. Strip price lines and shopping UI fragments
    s = s.replace(/^\d+\s*\u5186\s*$/gm, '');
    s = s.replace(/^\u4fa1\u683c\s*$/gm, '');
    s = s.replace(/^Multi Lang\.\s*$/gm, '');
    s = s.replace(/^\u65e5\u672c\u8a9e\s*$/gm, '');
    s = s.replace(/^Sales:\s*\d+\s*$/gm, '');
    s = s.replace(/^\d+\s*JPY(?:Sales:\s*\d+)?\s*$/gm, '');
    s = s.replace(/^\u96a0\u3059\s*$/gm, '');
    s = s.replace(/^\u30ab\u30fc\u30c8\s*$/gm, '');

    // 9. Strip OS/section headers
    s = s.replace(/^(?:Windows|Mac|iOS|Android|\u305d\u306e\u4ed6)-?\s*$/gm, '');
    s = s.replace(/^\u5bfe\u5fdc\uff2f\uff33\s*$/gm, '');
    s = s.replace(/^\u5bfe\u5fdcOS\s*$/gm, '');
    s = s.replace(/^\u5bfe\u5fdc\u30a2\u30d7\u30ea.*$/gm, '');
    s = s.replace(/^DLsite Sound\s*$/gm, '');

    // 10. Clean up
    s = s.replace(/^\*\s*$/gm, '');
    s = s.replace(/^---+$/gm, '');
    s = s.replace(/^={3,}$/gm, '');
    s = s.replace(/\n{3,}/g, '\n\n');
    s = s.trim();

    if (s.length < 10) return '';
    const urlRatio = (s.match(/https?:\/\//g) || []).length / Math.max(1, s.split('\n').length);
    if (urlRatio > 0.5) return '';

    return s;
}

/**
 * Parse review text into paragraphs of sanitized HTML.
 * Each paragraph can contain <a>, <strong>, <br> from markdown conversion,
 * so we use v-html for rendering.
 */
function getReviewParagraphs(review: DLsiteUserReview): string[] {
    if (!review.text) return [];
    const sanitized = sanitizeReviewText(review.text);
    if (!sanitized || sanitized.length < 3) return [];
    return sanitized
        .split(/\n\n+/)
        .map(p => p.trim())
        .filter(p => p.length > 0)
        .map(p => p.replace(/\n/g, '<br>'));
}

/**
 * Extract plain text from an HTML paragraph (strips tags).
 */
function htmlToPlainText(html: string): string {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return tmp.textContent || '';
}

// ---------------------------------------------------------------------------
// RJ code / work ID extraction helpers
// ---------------------------------------------------------------------------

function extractRjCode(): string | null {
    const work = currentWorkData.value;
    if (!work) return null;

    const sourceId = (work.source_id || work.sourceId || '').toString();
    if (sourceId) {
        const rjMatch = sourceId.match(/RJ\d{6,8}/i);
        if (rjMatch) return rjMatch[0].toUpperCase();
        const numericMatch = sourceId.match(/\d{6,8}/);
        if (numericMatch) return 'RJ' + numericMatch[0];
    }

    const workIdStr = String(currentWorkId.value);
    const idRjMatch = workIdStr.match(/RJ\d{6,8}/i);
    if (idRjMatch) return idRjMatch[0].toUpperCase();
    const idNumericMatch = workIdStr.match(/\d{6,8}/);
    if (idNumericMatch) return 'RJ' + idNumericMatch[0];

    const titleMatch = work.title?.match(/RJ\d{6,8}/i);
    if (titleMatch) return titleMatch[0].toUpperCase();

    return null;
}

function extractAllRjCodes(): string[] {
    const work = currentWorkData.value;
    const primary = extractRjCode();
    const codes = new Set<string>();
    if (primary) codes.add(primary);
    if (!work) return [...codes];

    const editions = work.language_editions;
    if (Array.isArray(editions)) {
        for (const ed of editions) {
            const wno = String(ed?.workno || '');
            const m = wno.match(/RJ\d{6,8}/i);
            if (m) codes.add(m[0].toUpperCase());
        }
    }

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

function getAllRelatedWorkIds(): number[] {
    const ids = new Set<number>();
    const primary = parseInt(currentWorkId.value || '', 10);
    if (!isNaN(primary)) ids.add(primary);

    const work = currentWorkData.value;
    if (!work) return [...ids];

    const otherEditions = work.other_language_editions_in_db;
    if (Array.isArray(otherEditions)) {
        for (const ed of otherEditions) {
            const edId = parseInt(String(ed?.id || ''), 10);
            if (!isNaN(edId)) ids.add(edId);
        }
    }

    return [...ids];
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function getWorkData(id: string): Promise<any> {
    const storeWork = bridge.store?.state?.AudioPlayer?.work;
    if (storeWork && String(storeWork.id) === String(id)) return storeWork;
    const worksState = (bridge.store?.state as any)?.Works;
    const cachedWork = worksState?.work || worksState?.currentWork || worksState?.detail;
    if (cachedWork && String(cachedWork.id) === String(id)) return cachedWork;

    try {
        const res = await bridge.axios.get(`/api/work/${id}`);
        return res.data;
    } catch (e) {
        Logger.warn('[CommentSection] Failed to fetch work data', e);
        return null;
    }
}

async function fetchCombinedEditionReviewCount(): Promise<void> {
    const work = currentWorkData.value;
    if (!work) return;

    const otherEditions = work.other_language_editions_in_db;
    if (!Array.isArray(otherEditions) || otherEditions.length === 0) {
        combinedEditionReviewCount.value = work.review_count || 0;
        return;
    }

    let total = work.review_count || 0;

    const fetches = otherEditions.map(async (ed: any) => {
        const edId = ed?.id;
        if (!edId || String(edId) === String(currentWorkId.value)) return 0;
        try {
            const res = await bridge.axios.get(`/api/work/${edId}`);
            return (res.data as any)?.review_count || 0;
        } catch (e) {
            Logger.warn(`[CommentSection] Failed to fetch review count for edition ${edId}`, e);
            return 0;
        }
    });

    const counts = await Promise.all(fetches);
    total += counts.reduce((sum: number, c: number) => sum + c, 0);

    combinedEditionReviewCount.value = total;
    Logger.debug(`[CommentSection] Combined review count across ${1 + otherEditions.length} editions: ${total}`);
}

async function fetchDLsiteReviewsData(): Promise<void> {
    if (dlsiteLoading.value || dlsiteLoaded.value) return;

    const workIdAtStart = currentWorkId.value;
    if (!workIdAtStart) return;

    dlsiteLoading.value = true;

    const allCodes = extractAllRjCodes();
    Logger.debug('[CommentSection] Eager fetch starting for', allCodes.length, 'RJ codes:', allCodes);
    if (allCodes.length === 0) {
        dlsiteLoading.value = false;
        dlsiteLoaded.value = true;
        return;
    }

    try {
        const results = await Promise.allSettled(
            allCodes.map(code => scraper.scrapeReviews(code))
        );

        if (currentWorkId.value !== workIdAtStart) {
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
    if (!translateMode.value) return;
    const texts: string[] = [];
    for (const review of reviews) {
        if (!review.text) continue;
        const sanitized = sanitizeReviewText(review.text);
        if (!sanitized || sanitized.length < 3) continue;
        const paragraphs = sanitized.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 0);
        for (const para of paragraphs) {
            const plain = htmlToPlainText(para.replace(/\n/g, '<br>'));
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

async function translateParagraphs(reviewIdx: number, paragraphs: string[]): Promise<void> {
    const plainTexts = paragraphs.map(p => htmlToPlainText(p));
    const validTexts = plainTexts.filter(t => t.length > 0);
    if (validTexts.length === 0) return;

    try {
        const results = await TranslationService.translateBatch(validTexts);
        let validIdx = 0;
        for (let paraIdx = 0; paraIdx < paragraphs.length; paraIdx++) {
            const plain = plainTexts[paraIdx];
            if (plain.length === 0) continue;
            const translated = results[validIdx];
            if (translated && translated !== plain) {
                translations.value[`${reviewIdx}:${paraIdx}`] = translated;
            } else {
                translations.value[`${reviewIdx}:${paraIdx}`] = '';
            }
            validIdx++;
        }
    } catch (e) {
        Logger.warn('[CommentSection] Batch translation of review paragraphs failed', e);
        for (let paraIdx = 0; paraIdx < paragraphs.length; paraIdx++) {
            translations.value[`${reviewIdx}:${paraIdx}`] = '';
        }
    }
}

function getTranslation(reviewIdx: number, paraIdx: number): string | undefined {
    return translations.value[`${reviewIdx}:${paraIdx}`];
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
    if (combinedEditionReviewCount.value <= 0) return;
    const work = currentWorkData.value;
    const otherEditions = work?.other_language_editions_in_db;
    if (!Array.isArray(otherEditions) || otherEditions.length === 0) return;

    const icons = document.querySelectorAll('.q-icon.material-icons');
    for (const icon of icons) {
        if (icon.textContent?.trim() === 'chat') {
            const countSpan = icon.parentElement?.querySelector('span.text-grey');
            if (countSpan) {
                countSpan.textContent = ` (${combinedEditionReviewCount.value})`;
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

    const allIds = getAllRelatedWorkIds();
    if (allIds.length === 0) return;

    updateSaveStatus('saving');

    try {
        await Promise.all(allIds.map(id =>
            ReviewApi.updateReview({
                work_id: id,
                rating: currentRating.value || undefined,
                review_text: currentText.value,
                starOnly: false,
            })
        ));
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

    const allIds = getAllRelatedWorkIds();
    if (allIds.length === 0) return;

    try {
        await Promise.all(allIds.map(id => ReviewApi.deleteReview(id)));
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
        eagerFetchPromise = fetchDLsiteReviewsData();
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

async function load(workId: string): Promise<void> {
    // Reset state
    dlsiteReviews.value = [];
    dlsiteLoaded.value = false;
    dlsiteLoading.value = false;
    dlsiteFetchFailed.value = false;
    combinedEditionReviewCount.value = 0;
    eagerFetchPromise = null;
    translations.value = {};

    const work = await getWorkData(workId);
    if (currentWorkId.value !== workId) return;
    currentWorkData.value = work;

    currentRating.value = work?.userRating || 0;
    currentText.value = work?.review_text || '';

    await fetchCombinedEditionReviewCount();
    if (currentWorkId.value !== workId) return;

    patchHostCommentCount();

    // Setup q-rating sync after DOM settles
    await nextTick();
    setupQRatingSync();
    syncRatingToQRating();

    // Eagerly fetch DLsite reviews in background
    if (!dlsiteLoaded.value && !dlsiteLoading.value) {
        eagerFetchPromise = fetchDLsiteReviewsData();
    }
}

// ---------------------------------------------------------------------------
// Watch workId from route
// ---------------------------------------------------------------------------

watch(workIdFromRoute, (newId, oldId) => {
    if (newId && newId !== oldId) {
        currentWorkId.value = newId;
        load(newId);
    } else if (!newId) {
        currentWorkId.value = null;
        currentWorkData.value = null;
        teardownQRatingSync();
    }
}, { immediate: true });

// Trigger translations when reviews load and translateMode is on
watch([dlsiteLoaded, translateMode], ([loaded, shouldTranslate]) => {
    if (loaded && shouldTranslate) {
        validDlsiteReviews.value.forEach((review, idx) => {
            const paragraphs = getReviewParagraphs(review);
            if (paragraphs.length > 0) {
                translateParagraphs(idx, paragraphs);
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
        <div class="asmr-comments-header" @click="toggleExpand">
            <i class="material-icons asmr-comments-header-icon">forum</i>
            <span class="asmr-comments-header-label">{{ t('commentsHeader') }}</span>
            <span v-if="reviewCount > 0" class="asmr-comments-badge">{{ reviewCount }}</span>
            <i class="material-icons asmr-comments-chevron"
               :class="{ 'asmr-comments-chevron--expanded': isExpanded }">expand_more</i>
        </div>

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
                    <div v-else-if="isExpanded && dlsiteLoaded && validDlsiteReviews.length === 0 && dlsiteFetchFailed"
                         class="asmr-comments-fetch-error cursor-pointer"
                         title="Click to open settings"
                         @click.stop="onFetchErrorClick">
                        <i class="material-icons">cloud_off</i>
                        <span>{{ t('commentsFetchFailed') }}</span>
                    </div>

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
                                             v-html="para" />
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
</style>
