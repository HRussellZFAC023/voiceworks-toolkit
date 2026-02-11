<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useBridge } from '../../composables/useBridge';
import { useConfig } from '../../composables/useConfig';
import { useI18n } from '../../composables/useI18n';
import { useEventBus } from '../../composables/useEventBus';
import { useRoute } from '../../composables/useRoute';
import { DLsiteScraper } from '../DLsiteScraper';
import type { DLsiteMetadata } from '../../types/dlsite';
import type { Work, WorkDetail } from '../../types/api';
import { CacheKeys, SharedCache } from '../../core/Cache';
import { TranslationService } from '../../services/TranslationService';
import { Priority } from '../../core/GpuScheduler';
import { TranslatedTags } from '../TranslatedTags';
import { MediaViewerController } from '../MediaViewerController';
import { extractEmbeddedRjCode, extractPrimaryRjCode } from '../rjCodeUtils';
import { Logger, SafeUtils } from '../../core/Utils';
import { isChinese } from '../../core/DomUtils';
import { HttpClient } from '../../infrastructure/HttpClient';

// ============================================================================
// Composables
// ============================================================================

const bridge = useBridge();
const { t, format } = useI18n();
const { emit } = useEventBus();
const route = useRoute();
const translateMode = useConfig('translateMode');
const cnToJpConfig = useConfig('translateCnToJp');
const dlsiteProxyUrl = useConfig('dlsiteProxyUrl');

// ============================================================================
// State
// ============================================================================

const scraper = DLsiteScraper.getInstance();

const meta = ref<DLsiteMetadata | null>(null);
const scrapeCode = ref('');
const detailsExpanded = ref(false);
const descriptionTranslated = ref('');
const bodyTranslations = ref<Map<number, string>>(new Map());
const chipTranslations = ref<Map<string, string>>(new Map());
const currentWorkId = ref('');
let loadRequestVersion = 0;
let titleTranslationRequestVersion = 0;
const METADATA_BODY_FIRST_BATCH = 20;
const METADATA_BODY_STREAM_BATCH = 40;
const METADATA_BODY_STREAM_YIELD_MS = 0;
const METADATA_TRANSLATION_SCOPES = ['title', 'description', 'chips', 'body'] as const;
const METADATA_TRANSLATION_PRIORITY = Priority.NORMAL;
const lastDescriptionSignature = ref('');
const lastChipSignature = ref('');
const lastBodySignature = ref('');

/** Image retry counters keyed by URL */
const imageRetries = ref<Map<string, number>>(new Map());
const imageSrcs = ref<Map<string, string>>(new Map());
const imageBlobAttempts = ref<Set<string>>(new Set());
const imageBlobUrls = ref<Map<string, string>>(new Map());
const hiddenImageUrls = ref<Set<string>>(new Set());
const loadedImageUrls = ref<Set<string>>(new Set());

// ============================================================================
// Computed
// ============================================================================

const shouldTranslate = computed(() => !!translateMode.value);
const cnToJp = computed(() => !!cnToJpConfig.value);
const cnOnlyMode = computed(() => !shouldTranslate.value && cnToJp.value);

const workId = computed(() => {
    const params = route.value?.params;
    return params?.id || '';
});

const rjCode = computed(() => {
    if (!meta.value) return '';
    return meta.value.rjcode || '';
});

const badgeClass = computed(() => {
    if (!meta.value) return '';
    return meta.value.age_category_string === 'R18' ? 'asmr-meta-badge--r18' : 'asmr-meta-badge--all';
});

const hasDiscount = computed(() => {
    return meta.value?.discount && meta.value.discount.rate > 0;
});

const discountedPrice = computed(() => {
    if (!meta.value?.price || !hasDiscount.value) return 0;
    return Math.floor(meta.value.price * (100 - meta.value.discount!.rate) / 100);
});

const rankParts = computed(() => {
    if (!meta.value?.rank) return [];
    const r = meta.value.rank;
    return [
        r.day ? `D${r.day}` : '',
        r.week ? `W${r.week}` : '',
        r.total ? `T${r.total}` : '',
    ].filter(Boolean);
});

const chips = computed(() => {
    if (!meta.value) return [];
    const result: { label: string; variant: string; icon?: string; key: string; tagId?: number }[] = [];

    if (meta.value.circle?.name) {
        result.push({ label: meta.value.circle.name, variant: 'circle', icon: 'business', key: `circle-${meta.value.circle.name}` });
    }
    meta.value.cvs.forEach((cv, i) => {
        result.push({ label: cv.name, variant: 'cv', icon: 'record_voice_over', key: `cv-${i}-${cv.name}` });
    });
    meta.value.tags.slice(0, 15).forEach((tag, i) => {
        result.push({ label: tag.name, variant: 'tag', key: `tag-${i}-${tag.name}`, tagId: tag.id });
    });

    return result;
});

const imageSamples = computed(() => meta.value?.image_samples || []);
const visibleImageSamples = computed(() => imageSamples.value.filter(url => !hiddenImageUrls.value.has(url)));

const bodyParagraphs = computed(() => {
    if (!meta.value) return [];
    const bodyText = meta.value.body || meta.value.intro || meta.value.summary || '';
    if (!bodyText) return [];

    let processedBody = bodyText;
    if (meta.value.description && processedBody.startsWith(meta.value.description)) {
        processedBody = processedBody.slice(meta.value.description.length).replace(/^[\s\n]+/, '');
    }

    processedBody = sanitizeBody(processedBody);
    if (processedBody.length <= 20) return [];

    return processedBody
        .split(/\n\n+/)
        .map(p => p.trim())
        .filter(p => p.length > 0);
});

const toggleLabel = computed(() => {
    return detailsExpanded.value ? t('metaHideDetails') : t('metaShowDetails');
});

const toggleIcon = computed(() => {
    return detailsExpanded.value ? 'expand_less' : 'expand_more';
});

// ============================================================================
// Helper: get displayed chip label (original or translated)
// ============================================================================

function chipDisplayLabel(chip: { label: string; key: string }): string {
    return chipTranslations.value.get(chip.key) || chip.label;
}

function chipTitle(chip: { label: string; key: string }): string {
    return chipTranslations.value.has(chip.key) ? chip.label : '';
}

// ============================================================================
// Helper: get image src with retry support
// ============================================================================

function getProxyBaseUrl(): string {
    let raw = String(dlsiteProxyUrl.value || '').trim().replace(/\/+$/, '');
    if (!raw) return '';
    if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
    try {
        const parsed = new URL(raw);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    } catch {
        return '';
    }
    return raw;
}

function toAbsoluteUrl(url: string): string {
    if (!url) return '';
    if (url.startsWith('//')) return `https:${url}`;
    return url;
}

function isDlsiteImageUrl(url: string): boolean {
    try {
        const host = new URL(url).hostname.toLowerCase();
        return host.includes('dlsite.com') || host.includes('dlsite.jp');
    } catch {
        return false;
    }
}

function proxyImageUrl(originalUrl: string, preserveHost = true): string {
    const normalizedUrl = toAbsoluteUrl(originalUrl);
    const base = getProxyBaseUrl();
    if (!base) return normalizedUrl;

    try {
        const parsed = new URL(normalizedUrl);
        const host = parsed.hostname.toLowerCase();
        if (!host.includes('dlsite.com') && !host.includes('dlsite.jp')) return normalizedUrl;
        const params = new URLSearchParams(parsed.search);
        if (preserveHost && host !== 'www.dlsite.com') {
            params.set('__host', host);
        }
        const query = params.toString();
        return `${base}${parsed.pathname}${query ? `?${query}` : ''}`;
    } catch {
        return normalizedUrl;
    }
}

function getDisplayBaseUrl(url: string): string {
    return toAbsoluteUrl(url);
}

function getResolvedImageUrl(url: string): string {
    return imageSrcs.value.get(url) || getDisplayBaseUrl(url);
}

function getImageSrc(url: string): string {
    return getResolvedImageUrl(url);
}

function isImageLoaded(url: string): boolean {
    return loadedImageUrls.value.has(url);
}

async function tryBlobFallback(url: string): Promise<boolean> {
    if (imageBlobAttempts.value.has(url) || imageBlobUrls.value.has(url)) return false;
    imageBlobAttempts.value.add(url);
    let loadedFromBlob = false;

    const directUrl = toAbsoluteUrl(url);
    const hostAwareProxyUrl = proxyImageUrl(url, true);
    const legacyProxyUrl = proxyImageUrl(url, false);
    const orderedCandidates = [directUrl, hostAwareProxyUrl, legacyProxyUrl];
    const candidates = orderedCandidates
        .filter((candidate, idx, arr) => !!candidate && arr.indexOf(candidate) === idx);

    for (const candidate of candidates) {
        if (!candidate) continue;
        Logger.debug(`[WorkMetadataPanel] Image failed, trying blob fetch: ${candidate}`);
        try {
            const blob = await HttpClient.getBlob(candidate, {
                retry: { attempts: 2, backoffMs: 600, multiplier: 2 },
            });
            if (!blob) continue;

            const blobUrl = URL.createObjectURL(blob);
            const previousBlob = imageBlobUrls.value.get(url);
            if (previousBlob) URL.revokeObjectURL(previousBlob);

            imageBlobUrls.value.set(url, blobUrl);
            imageSrcs.value.set(url, blobUrl);
            hiddenImageUrls.value.delete(url);
            loadedFromBlob = true;
            return true;
        } catch (e) {
            Logger.debug(`[WorkMetadataPanel] Blob fallback failed for sample image: ${candidate}`, e);
        }
    }

    // Allow later retries if this fallback cycle failed for every candidate.
    if (!loadedFromBlob) {
        imageBlobAttempts.value.delete(url);
    }
    return loadedFromBlob;
}

function onImageError(url: string): void {
    const baseUrl = toAbsoluteUrl(url);
    const isDlsite = isDlsiteImageUrl(baseUrl);

    void tryBlobFallback(url).then((ok) => {
        if (isDlsite && !ok && !imageBlobUrls.value.has(url)) {
            hiddenImageUrls.value.add(url);
        }
    });

    // DLsite image endpoints frequently hard-403 for unavailable samples.
    // Don't waste time with cache-buster retries; fallback/hide handles it.
    if (isDlsite) return;

    const count = (imageRetries.value.get(url) || 0) + 1;
    const maxRetries = 3;
    if (count > maxRetries) {
        if (!imageBlobUrls.value.has(url)) {
            hiddenImageUrls.value.add(url);
        }
        return;
    }

    imageRetries.value.set(url, count);
    const delay = Math.pow(2, count - 1) * 1000;
    Logger.debug(`[WorkMetadataPanel] Sample image retry ${count}/${maxRetries} in ${delay}ms`);

    setTimeout(() => {
        if (imageBlobUrls.value.has(url)) return;
        const retryBaseUrl = toAbsoluteUrl(url);
        if (!retryBaseUrl || retryBaseUrl.startsWith('blob:')) {
            if (count >= maxRetries && !imageBlobUrls.value.has(url)) {
                hiddenImageUrls.value.add(url);
            }
            return;
        }
        if (isDlsiteImageUrl(retryBaseUrl) || retryBaseUrl.includes('__host=')) {
            if (count >= maxRetries && !imageBlobUrls.value.has(url)) {
                hiddenImageUrls.value.add(url);
            }
            return;
        }
        const separator = retryBaseUrl.includes('?') ? '&' : '?';
        imageSrcs.value.set(url, `${retryBaseUrl}${separator}_r=${count}`);
    }, delay);
}

function onImageLoad(url: string): void {
    loadedImageUrls.value.add(url);
    hiddenImageUrls.value.delete(url);
}

function resetImageState(): void {
    imageBlobUrls.value.forEach((blobUrl) => {
        try {
            URL.revokeObjectURL(blobUrl);
        } catch {
            // Ignore invalid/revoked object URLs
        }
    });
    imageRetries.value = new Map();
    imageSrcs.value = new Map();
    imageBlobAttempts.value = new Set();
    imageBlobUrls.value = new Map();
    hiddenImageUrls.value = new Set();
    loadedImageUrls.value = new Set();
}

function resetInjectedTitleElements(): void {
    document.querySelector('.asmr-original-title')?.remove();
    document.querySelector('.asmr-translated-title')?.remove();
    const h1 = document.querySelector('h1.text-h6') as HTMLElement | null;
    if (h1) h1.style.display = '';
}

function getMetadataTranslationQueueKey(workId: string, scope: typeof METADATA_TRANSLATION_SCOPES[number]): string {
    return `workmeta:${workId}:${scope}`;
}

function clearMetadataTranslationQueue(workId: string): void {
    if (!workId) return;
    for (const scope of METADATA_TRANSLATION_SCOPES) {
        TranslationService.cancelPending({ cancellableKey: getMetadataTranslationQueueKey(workId, scope) });
    }
}

// ============================================================================
// Business Logic
// ============================================================================

function openDlsiteSearch(keyword: string): void {
    window.open(`https://www.dlsite.com/maniax/fsr/=/keyword/${encodeURIComponent(keyword)}`, '_blank');
}

function openImageViewer(urls: string[], index: number): void {
    const resolvedUrls = urls.map((url) => imageBlobUrls.value.get(url) || toAbsoluteUrl(url));
    try {
        MediaViewerController.getInstance().showExternalImages(resolvedUrls, index);
    } catch (e) {
        Logger.warn('[WorkMetadataPanel] MediaViewer failed, opening in new tab:', e);
        window.open(resolvedUrls[index], '_blank');
    }
}

async function handleRefresh(): Promise<void> {
    if (!currentWorkId.value || !scrapeCode.value) return;
    clearMetadataTranslationQueue(currentWorkId.value);
    lastDescriptionSignature.value = '';
    lastChipSignature.value = '';
    lastBodySignature.value = '';

    // Invalidate cache for the scrape code
    const key = CacheKeys.dlsite(scrapeCode.value.toUpperCase());
    SharedCache.set(key, null as unknown as DLsiteMetadata, 0);

    const reviewKey = CacheKeys.dlsiteReviews(scrapeCode.value.toUpperCase());
    SharedCache.set(reviewKey, null, 0);

    // Invalidate translations for visible metadata
    const textsToInvalidate = [
        meta.value?.title,
        meta.value?.description,
        meta.value?.circle?.name,
        ...(meta.value?.tags || []).map(t => t.name),
        ...(meta.value?.cvs || []).map(c => c.name),
    ];
    textsToInvalidate.forEach(text => {
        if (!text) return;
        SharedCache.set(CacheKeys.translation(text, 'en', 'remote'), null, 0);
        SharedCache.set(CacheKeys.translation(text, 'en', 'auto'), null, 0);
    });

    titleTranslationRequestVersion++;
    resetInjectedTitleElements();

    // Reset state and reload
    meta.value = null;
    descriptionTranslated.value = '';
    bodyTranslations.value = new Map();
    chipTranslations.value = new Map();
    detailsExpanded.value = false;
    resetImageState();

    await loadMetadata(currentWorkId.value);
}

// ============================================================================
// RJ Code Resolution
// ============================================================================

function extractRjCode(work: Work | WorkDetail, id: string): string {
    return extractPrimaryRjCode({
        sourceId: work.source_id || work.sourceId,
        workId: id,
        title: work.title,
    }) ?? '';
}

function resolveJpRjCode(work: Work | WorkDetail, currentCode: string): string | null {
    const origWorkno = work.original_workno;
    if (origWorkno && typeof origWorkno === 'string') {
        const code = extractEmbeddedRjCode(origWorkno);
        if (code) return code;
    }

    const ti = work.translation_info;
    if (ti) {
        const orig = ti.original_workno || ti.parent_workno;
        if (orig && typeof orig === 'string') {
            const code = extractEmbeddedRjCode(orig);
            if (code) return code;
        }
    }

    const editions = work.language_editions;
    if (Array.isArray(editions)) {
        const jpn = editions.find((e) => e.lang === 'JPN' || e.lang === 'jpn');
        if (jpn?.workno) {
            const code = extractEmbeddedRjCode(jpn.workno);
            if (code && code !== currentCode) return code;
        }
    }

    return null;
}

function buildFallbackMeta(work: (Work | WorkDetail) & Record<string, unknown>, rjCodeStr: string): DLsiteMetadata | null {
    if (!work) return null;
    const circleName = work.circle?.name || String(work.circle_name || work.maker_name || work.circleName || '');
    const circleId = Number(work.circle?.id || work.circle_id || work.maker_id || 0) || 0;
    const rawTags = (work.tags || work.genres || work.tags_replaced || []) as Array<{ id?: number; tag_id?: number; name?: string; title?: string }>;
    const tags = rawTags.map((t) => ({
        id: Number(t.id || t.tag_id || 0) || 0,
        name: t.name || t.title || '',
    })).filter((t) => t.name);
    const rawCvs = (work.vas || work.voice_actors || work.voiceActors || work.cvs || []) as Array<{ name?: string; title?: string }>;
    const cvs = rawCvs.map((c) => ({
        name: c.name || c.title || '',
    })).filter((c) => c.name);

    const age = Number(work.age_category || work.age || 0) || 0;
    const ageString = age >= 3 ? 'R18' : age === 2 ? 'R15' : 'ALL';
    const release = (work.release_date || work.release || work.release_at || work.regist_date || '').toString().slice(0, 10);
    const rating = Number(work.rate || work.rating_average || work.rate_average_2dp || 0) || 0;
    const price = Number(work.price || 0) || 0;

    return {
        rjcode: rjCodeStr,
        title: work.title || work.name || rjCodeStr,
        nsfw: age >= 2 || !!work.nsfw,
        release,
        tags,
        cvs,
        rating_average: rating,
        price,
        age_category_string: ageString,
        circle: circleName ? { id: circleId, name: circleName } : undefined,
    };
}

function mergeMeta(primary: DLsiteMetadata, fallback: DLsiteMetadata | null): DLsiteMetadata {
    if (!fallback) return primary;
    const merged = { ...primary };
    if (!merged.title) merged.title = fallback.title;
    if (!merged.circle?.name && fallback.circle?.name) merged.circle = fallback.circle;
    if (merged.tags.length === 0 && fallback.tags.length) merged.tags = fallback.tags;
    if (merged.cvs.length === 0 && fallback.cvs.length) merged.cvs = fallback.cvs;
    if (!merged.release && fallback.release) merged.release = fallback.release;
    if (!merged.rating_average && fallback.rating_average) merged.rating_average = fallback.rating_average;
    if (!merged.price && fallback.price) merged.price = fallback.price;
    if (!merged.age_category_string && fallback.age_category_string) merged.age_category_string = fallback.age_category_string;
    return merged;
}

// ============================================================================
// Body Sanitization
// ============================================================================

function sanitizeBody(body: string): string {
    let s = body;

    const stopMarkers = [
        'Select Language', '\u3053\u306e\u4f5c\u54c1\u3092\u8cb7\u3063\u305f\u4eba',
        '\u6700\u8fd1\u30c1\u30a7\u30c3\u30af\u3057\u305f\u4f5c\u54c1',
        '\u95a2\u9023\u30b5\u30fc\u30d3\u30b9', 'DLsite\u306b\u3064\u3044\u3066',
        '\u30d8\u30eb\u30d7&\u30ac\u30a4\u30c9',
        '\u304a\u652f\u6255\u3044&\u30dd\u30a4\u30f3\u30c8',
        '\u63a8\u5968\u74b0\u5883', '\u00a9 1996 DLsite',
        '\u6210\u4eba\u5411\u3051\u5165\u5ba4\u78ba\u8a8d',
        'SORRY...',
        '\u540c\u4eba\u8a8c\u30fb\u540c\u4eba\u30b2\u30fc\u30e0\u30fb\u540c\u4eba\u30dc\u30a4\u30b9',
        '\u8a00\u8a9e\u3068\u901a\u8ca8\u3092\u8a2d\u5b9a',
        '\u5168\u5e74\u9f62\u5411\u3051\u3078',
        '\u5973\u6027\u5411\u3051',
    ];
    for (const marker of stopMarkers) {
        const idx = s.indexOf(marker);
        if (idx !== -1) s = s.substring(0, idx);
    }

    s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
    s = s.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
    s = s.replace(/<object[\s\S]*?<\/object>/gi, '');
    s = s.replace(/<style[\s\S]*?<\/style>/gi, '');

    s = s.replace(/<img[^>]*src="[^"]*(?:analytics|octopuspop|adsct|twitter|doubleclick|facebook|banner|modpub|logo|payment|recruit)[^"]*"[^>]*\/?>/gi, '');
    s = s.replace(/!\[Image \d+[^\]]*\]\([^)]*\)/g, '');
    s = s.replace(/!\[[^\]]*\]\([^)]*(?:banner|modpub|logo|payment|recruit|octopuspop|analytics|adsct)[^)]*\)/gi, '');

    s = s.replace(/\*?\s*\[([^\]]*)\]\(https?:\/\/(?:www\.nijiyome|ci-en|ch\.dlsite|chobit|triokini|play\.dlsite|hire\.wantedly|www\.eisys|www\.geonet|cs\.dlsite|min-hon|www\.youtube|x\.com|t\.co|analytics\.twitter)[^)]*\)/gi, '');
    s = s.replace(/\*?\s*\[([^\]]*)\]\(https?:\/\/www\.dlsite\.com\/(?:maniax|home)\/(?:regist|login|mypage|guide|rule|faq|inquiry)[^)]*\)/gi, '');
    s = s.replace(/\*?\s*\[\s*\]\([^)]*\)/g, '');

    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;border-radius:4px">');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/^#{1,6}\s+(.+)$/gm, '<strong>$1</strong>');
    s = s.replace(/^(.+)\n={3,}$/gm, '<strong>$1</strong>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');

    s = s.replace(/(^|[^("'])(https?:\/\/[^\s<>"')\]]+)/gm, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');

    s = s.replace(/``/g, '"');
    s = s.replace(/''/g, '"');

    s = s.replace(/^\*\s*$/gm, '');
    s = s.replace(/^\*\s+\u975e\u8868\u793a\u306b\u3059\u308b\s*$/gm, '');
    s = s.replace(/^---+$/gm, '');
    s = s.replace(/^={3,}$/gm, '');

    s = s.replace(/\n{3,}/g, '\n\n');
    s = s.trim();

    if (s.length < 30) return '';
    const urlRatio = (s.match(/https?:\/\//g) || []).length / Math.max(1, s.split('\n').length);
    if (urlRatio > 0.5) return '';

    return s;
}

/** Convert newlines in a paragraph to <br> for v-html rendering.
 *  sanitizeBody() already strips dangerous tags (script/iframe/object/style),
 *  so the output is safe for v-html without additional escaping. */
function paragraphHtml(para: string): string {
    return para.replace(/\n/g, '<br>');
}

// ============================================================================
// Title Translation (operates on host DOM, outside Vue scope)
// ============================================================================

async function translateTitle(originalTitle: string, expectedLoadVersion: number, expectedWorkId: string): Promise<void> {
    if (!originalTitle) return;

    const titleRequestId = ++titleTranslationRequestVersion;
    const shouldSkipTranslation =
        (!shouldTranslate.value && !cnToJp.value) ||
        (cnOnlyMode.value && !isChinese(originalTitle)) ||
        (!cnOnlyMode.value && TranslationService.isUserLang(originalTitle));
    if (shouldSkipTranslation) {
        if (
            expectedLoadVersion === loadRequestVersion &&
            currentWorkId.value === expectedWorkId &&
            titleRequestId === titleTranslationRequestVersion
        ) {
            resetInjectedTitleElements();
            emit('title:update', { title: originalTitle });
        }
        return;
    }

    try {
        const queueKey = getMetadataTranslationQueueKey(expectedWorkId, 'title');
        TranslationService.cancelPending({ cancellableKey: queueKey });
        const translated = cnOnlyMode.value
            ? await TranslationService.translate(originalTitle, 'ja', {
                priority: METADATA_TRANSLATION_PRIORITY,
                cancellable: true,
                cancellableKey: queueKey,
            })
            : await TranslationService.translate(originalTitle, 'en', {
                priority: METADATA_TRANSLATION_PRIORITY,
                cancellable: true,
                cancellableKey: queueKey,
            });
        if (
            expectedLoadVersion !== loadRequestVersion ||
            currentWorkId.value !== expectedWorkId ||
            titleRequestId !== titleTranslationRequestVersion
        ) {
            return;
        }
        if (!translated || translated === originalTitle) {
            resetInjectedTitleElements();
            emit('title:update', { title: originalTitle });
            return;
        }

        const h1 = await SafeUtils.waitForElement('h1.text-h6') as HTMLElement | null;
        if (
            !h1 ||
            expectedLoadVersion !== loadRequestVersion ||
            currentWorkId.value !== expectedWorkId ||
            titleRequestId !== titleTranslationRequestVersion
        ) {
            return;
        }

        if (cnOnlyMode.value) {
            // CN->JP: silently replace with Japanese
            h1.parentElement?.querySelector('.asmr-original-title')?.remove();
            let transEl = h1.parentElement?.querySelector('.asmr-translated-title') as HTMLElement;
            if (!transEl) {
                transEl = document.createElement('div');
                transEl.className = 'text-h6 asmr-translated-title';
                h1.parentElement?.insertBefore(transEl, h1.nextSibling);
            }
            transEl.textContent = translated;
            h1.style.display = 'none';
            emit('title:update', { title: translated });
            return;
        }

        let originalSpan = h1.parentElement?.querySelector('.asmr-original-title') as HTMLElement;
        if (!originalSpan) {
            originalSpan = document.createElement('div');
            originalSpan.className = 'text-caption text-grey-5 q-mb-xs asmr-original-title';
            h1.parentElement?.insertBefore(originalSpan, h1);
        }
        originalSpan.textContent = originalTitle;

        let transEl = h1.parentElement?.querySelector('.asmr-translated-title') as HTMLElement;
        if (!transEl) {
            transEl = document.createElement('div');
            transEl.className = 'text-h6 asmr-translated-title';
            h1.parentElement?.insertBefore(transEl, h1.nextSibling);
        }
        transEl.textContent = translated;
        h1.style.display = 'none';
        emit('title:update', { title: translated });
    } catch (e) {
        Logger.warn('[WorkMetadataPanel] Title translation failed', e);
    }
}

// ============================================================================
// Translation Side Effects
// ============================================================================

async function translateDescription(expectedLoadVersion: number, expectedWorkId: string): Promise<void> {
    if ((!shouldTranslate.value && !cnToJp.value) || !meta.value?.description) return;
    const source = meta.value.description;
    if (cnOnlyMode.value && !isChinese(source)) return;
    const targetLang = cnOnlyMode.value ? 'ja' : 'en';
    const signature = `${targetLang}:${source}`;
    if (signature === lastDescriptionSignature.value) return;
    lastDescriptionSignature.value = signature;

    try {
        const queueKey = getMetadataTranslationQueueKey(expectedWorkId, 'description');
        TranslationService.cancelPending({ cancellableKey: queueKey });
        const translated = await TranslationService.translate(source, targetLang, {
            priority: Priority.NORMAL,
            cancellable: true,
            cancellableKey: queueKey,
        });
        if (
            expectedLoadVersion !== loadRequestVersion ||
            currentWorkId.value !== expectedWorkId ||
            meta.value?.description !== source
        ) {
            return;
        }
        if (translated && translated !== source) {
            descriptionTranslated.value = translated;
        } else {
            descriptionTranslated.value = '';
        }
    } catch {
        // Silently fail
    }
}

async function translateChips(expectedLoadVersion: number, expectedWorkId: string): Promise<void> {
    if (!shouldTranslate.value && !cnToJp.value) return;
    const targetLang = cnOnlyMode.value ? 'ja' : 'en';
    const chipSignature = `${targetLang}:${chips.value.map(chip => `${chip.key}:${chip.label}`).join('|')}`;
    if (chipSignature === lastChipSignature.value) return;
    lastChipSignature.value = chipSignature;

    const labelsToTranslate: { key: string; text: string }[] = [];

    for (const chip of chips.value) {
        const text = chip.label.trim();
        if (!text || !/[\u3040-\u30ff\u4e00-\u9faf]/.test(text)) continue;
        if (cnOnlyMode.value && !isChinese(text)) continue;

        // Try tag pre-translation first (skip in CN-only mode)
        if (!cnOnlyMode.value && chip.tagId) {
            const tagList = TranslatedTags.getInstance().getTagList();
            const match = tagList.find(t => t.id === chip.tagId || t.ja === text);
            if (match?.en && match.ja && match.en !== match.ja) {
                chipTranslations.value.set(chip.key, TranslationService.formatPair(match.ja, match.en));
                continue;
            }
        }

        labelsToTranslate.push({ key: chip.key, text });
    }

    if (labelsToTranslate.length === 0) return;

    try {
        const queueKey = getMetadataTranslationQueueKey(expectedWorkId, 'chips');
        TranslationService.cancelPending({ cancellableKey: queueKey });
        const results = await TranslationService.translateBatch(labelsToTranslate.map(l => l.text), targetLang, {
            priority: METADATA_TRANSLATION_PRIORITY,
            cancellable: true,
            cancellableKey: queueKey,
        });
        if (
            expectedLoadVersion !== loadRequestVersion ||
            currentWorkId.value !== expectedWorkId
        ) {
            return;
        }
        const nextMap = new Map(chipTranslations.value);
        results.forEach((translated, i) => {
            const item = labelsToTranslate[i];
            if (translated && translated !== item.text) {
                if (cnOnlyMode.value) {
                    nextMap.set(item.key, translated);
                } else {
                    nextMap.set(item.key, TranslationService.formatPair(item.text, translated));
                }
            }
        });
        chipTranslations.value = nextMap;
    } catch {
        // Silently fail
    }
}

async function translateBodyParagraphs(expectedLoadVersion: number, expectedWorkId: string): Promise<void> {
    if ((!shouldTranslate.value && !cnToJp.value) || bodyParagraphs.value.length === 0) return;

    // Extract plain text from HTML paragraphs
    const tempDiv = document.createElement('div');
    const texts = bodyParagraphs.value.map(para => {
        tempDiv.innerHTML = paragraphHtml(para);
        return tempDiv.textContent || '';
    }).filter(t => t.length > 0);

    if (texts.length === 0) return;
    const targetLang = cnOnlyMode.value ? 'ja' : 'en';
    const bodySignature = `${targetLang}:${texts.join('\u241e')}`;
    if (bodySignature === lastBodySignature.value) return;
    lastBodySignature.value = bodySignature;

    try {
        const queueKey = getMetadataTranslationQueueKey(expectedWorkId, 'body');
        TranslationService.cancelPending({ cancellableKey: queueKey });

        const applyChunkResults = (chunkTexts: string[], offset: number, translatedResults: string[]) => {
            const newMap = new Map(bodyTranslations.value);
            translatedResults.forEach((translated, idx) => {
                const source = chunkTexts[idx];
                if (translated && translated !== source) {
                    newMap.set(offset + idx, translated);
                }
            });
            bodyTranslations.value = newMap;
        };

        const firstCount = Math.min(METADATA_BODY_FIRST_BATCH, texts.length);
        if (firstCount > 0) {
            const firstChunk = texts.slice(0, firstCount);
            const firstResults = await TranslationService.translateBatch(firstChunk, targetLang, {
                priority: METADATA_TRANSLATION_PRIORITY,
                cancellable: true,
                cancellableKey: queueKey,
            });
            if (
                expectedLoadVersion !== loadRequestVersion ||
                currentWorkId.value !== expectedWorkId
            ) {
                return;
            }
            applyChunkResults(firstChunk, 0, firstResults);
        }

        for (let start = firstCount; start < texts.length; start += METADATA_BODY_STREAM_BATCH) {
            const chunk = texts.slice(start, start + METADATA_BODY_STREAM_BATCH);
            const chunkResults = await TranslationService.translateBatch(chunk, targetLang, {
                priority: METADATA_TRANSLATION_PRIORITY,
                cancellable: true,
                cancellableKey: queueKey,
            });
            if (
                expectedLoadVersion !== loadRequestVersion ||
                currentWorkId.value !== expectedWorkId
            ) {
                return;
            }
            applyChunkResults(chunk, start, chunkResults);
            if (METADATA_BODY_STREAM_YIELD_MS > 0) {
                await new Promise(resolve => setTimeout(resolve, METADATA_BODY_STREAM_YIELD_MS));
            }
        }
    } catch (e) {
        Logger.warn('[WorkMetadataPanel] Batch translation of body paragraphs failed:', e);
    }
}

// ============================================================================
// Data Fetching
// ============================================================================

async function getPageWorkDetails(id: string): Promise<(Work | WorkDetail) & Record<string, unknown> | null> {
    const storeWork = bridge.store?.state?.AudioPlayer?.work;
    if (storeWork && String(storeWork.id) === String(id)) return storeWork as WorkDetail & Record<string, unknown>;

    const worksState = bridge.store?.state?.Works as Record<string, unknown> | undefined;
    const cachedWork = (worksState?.work || worksState?.currentWork || worksState?.detail) as (Work & Record<string, unknown>) | undefined;
    if (cachedWork && String(cachedWork.id) === String(id)) return cachedWork;

    try {
        const res = await bridge.axios.get<Work & Record<string, unknown>>(`/api/work/${id}`);
        return res.data;
    } catch (e) {
        Logger.error('[WorkMetadataPanel] API fetch failed for work', id, e);
        return null;
    }
}

async function loadMetadata(id: string): Promise<void> {
    const version = ++loadRequestVersion;
    clearMetadataTranslationQueue(id);
    titleTranslationRequestVersion++;
    resetInjectedTitleElements();
    const work = await getPageWorkDetails(id);
    if (version !== loadRequestVersion) return; // Stale request — newer load started
    if (!work) {
        Logger.warn('[WorkMetadataPanel] Work details missing for', id);
        return;
    }

    const rjCodeStr = extractRjCode(work, id);
    if (!rjCodeStr) {
        Logger.debug('[WorkMetadataPanel] No RJ code found for work', id);
        return;
    }

    const jpRjCode = resolveJpRjCode(work, rjCodeStr);
    const actualScrapeCode = jpRjCode || rjCodeStr;
    if (jpRjCode && jpRjCode !== rjCodeStr) {
        Logger.debug(`[WorkMetadataPanel] Resolved JP original: ${rjCodeStr} -> ${jpRjCode}`);
    }

    scrapeCode.value = actualScrapeCode;

    const fallback = buildFallbackMeta(work, rjCodeStr);

    // Start title translation early (in parallel with DLsite scrape)
    const titleToTranslate = work.title || fallback?.title || '';
    if (titleToTranslate) translateTitle(titleToTranslate, version, id);

    // Phase 0: Render fallback immediately for fast first paint
    if (fallback) {
        meta.value = fallback;
        lastDescriptionSignature.value = '';
        lastChipSignature.value = '';
        lastBodySignature.value = '';
        // Trigger translations after fallback render
        translateDescription(version, id);
        translateChips(version, id);
    }

    try {
        Logger.debug('[WorkMetadataPanel] Fetching DLsite metadata for', actualScrapeCode);

        const onProgress = (partial: DLsiteMetadata) => {
            if (currentWorkId.value !== id) return;
            partial.rjcode = rjCodeStr;
            const merged = mergeMeta(partial, fallback);
            if (merged.title && merged.title !== titleToTranslate) {
                translateTitle(merged.title, version, id);
            }
            meta.value = merged;
            // Re-trigger translations on enriched data
            lastDescriptionSignature.value = '';
            lastChipSignature.value = '';
            descriptionTranslated.value = '';
            chipTranslations.value = new Map();
            translateDescription(version, id);
            translateChips(version, id);
        };

        const fullMeta = await scraper.scrapeProgressive(actualScrapeCode, onProgress);
        if (currentWorkId.value !== id) return;

        // Phase 2: Full data with body - final render
        fullMeta.rjcode = rjCodeStr;
        const merged = mergeMeta(fullMeta, fallback);

        if (merged.title && merged.title !== titleToTranslate) {
            translateTitle(merged.title, version, id);
        }

        meta.value = merged;
        descriptionTranslated.value = '';
        chipTranslations.value = new Map();
        bodyTranslations.value = new Map();
        lastDescriptionSignature.value = '';
        lastChipSignature.value = '';
        lastBodySignature.value = '';
        translateDescription(version, id);
        translateChips(version, id);
        translateBodyParagraphs(version, id);
    } catch (e) {
        Logger.error('[WorkMetadataPanel] Failed to load metadata', e);
        // Fallback already rendered in Phase 0
    }
}

// ============================================================================
// Lifecycle
// ============================================================================

watch(workId, (newId, oldId) => {
    if (newId && newId !== oldId) {
        if (oldId) clearMetadataTranslationQueue(oldId);
        clearMetadataTranslationQueue(newId);
        titleTranslationRequestVersion++;
        resetInjectedTitleElements();
        // Reset state for new work
        meta.value = null;
        descriptionTranslated.value = '';
        bodyTranslations.value = new Map();
        chipTranslations.value = new Map();
        lastDescriptionSignature.value = '';
        lastChipSignature.value = '';
        lastBodySignature.value = '';
        detailsExpanded.value = false;
        resetImageState();
        currentWorkId.value = newId;
        loadMetadata(newId);
    }
}, { immediate: true });

onMounted(() => {
    if (workId.value && !meta.value) {
        currentWorkId.value = workId.value;
        loadMetadata(workId.value);
    }
});

onUnmounted(() => {
    clearMetadataTranslationQueue(currentWorkId.value);
    loadRequestVersion++;
    titleTranslationRequestVersion++;
    resetImageState();
    resetInjectedTitleElements();
});
</script>

<template>
    <div v-if="meta" class="asmr-metadata-panel q-mb-md q-mt-md">
        <div class="asmr-meta-content">
            <!-- Stats Row: badge, price, rank, downloads, rating, refresh -->
            <div class="asmr-meta-stats">
                <span class="asmr-meta-badge" :class="badgeClass">
                    {{ meta.age_category_string || 'R18' }}
                </span>

                <span v-if="meta.price" class="asmr-meta-price">
                    <template v-if="hasDiscount">
                        <span class="asmr-meta-price-old">{{ meta.price }}</span>
                        <span class="asmr-meta-price-current">{{ discountedPrice }} JPY</span>
                        <span class="asmr-meta-discount">-{{ meta.discount!.rate }}%</span>
                    </template>
                    <template v-else>
                        <span class="asmr-meta-price-current">{{ meta.price }} JPY</span>
                    </template>
                </span>

                <span v-if="rankParts.length" class="asmr-meta-stat">
                    <i class="material-icons" style="font-size:14px;vertical-align:middle">leaderboard</i>
                    {{ rankParts.join('/') }}
                </span>

                <span v-if="meta.dl_count" class="asmr-meta-stat">
                    <i class="material-icons" style="font-size:14px;vertical-align:middle">archive</i>
                    {{ meta.dl_count }}
                </span>

                <span v-if="meta.rating_average > 0" class="asmr-meta-stat">
                    <i class="material-icons" style="font-size:14px;vertical-align:middle;color:#ffb300">star</i>
                    {{ meta.rating_average.toFixed(2) }}
                </span>

                <button class="asmr-meta-refresh" :title="t('metaRefresh')" @click="handleRefresh">
                    <i class="material-icons" style="font-size:16px">refresh</i>
                </button>
            </div>

            <!-- Chips: circle, CVs, tags -->
            <div class="asmr-meta-chips">
                <button
                    v-for="chip in chips"
                    :key="chip.key"
                    class="asmr-chip-tag"
                    :class="`asmr-chip-tag--${chip.variant}`"
                    :title="chipTitle(chip)"
                    @click="openDlsiteSearch(chip.label)"
                >
                    <i v-if="chip.icon" class="material-icons asmr-chip-icon">{{ chip.icon }}</i>
                    <span class="asmr-chip-label">{{ chipDisplayLabel(chip) }}</span>
                </button>
            </div>

            <!-- Brief description (above the fold) -->
            <div v-if="meta.description" class="asmr-meta-description">
                <div class="asmr-meta-description-cell asmr-meta-description-cell--original">
                    {{ meta.description }}
                </div>
                <div
                    v-if="descriptionTranslated"
                    class="asmr-meta-description-cell asmr-meta-description-cell--translated"
                >
                    {{ descriptionTranslated }}
                </div>
            </div>

            <!-- Expandable DLsite Details -->
            <div class="asmr-meta-details-container">
                <button class="asmr-meta-toggle" @click="detailsExpanded = !detailsExpanded">
                    <span>{{ toggleLabel }}</span>
                    <i class="material-icons">{{ toggleIcon }}</i>
                </button>

                <div v-if="detailsExpanded" class="asmr-meta-details">
                    <!-- Sample images gallery -->
                    <div v-if="visibleImageSamples.length" class="asmr-meta-gallery">
                        <button
                            v-for="(url, idx) in visibleImageSamples"
                            :key="url"
                            class="asmr-meta-gallery-item"
                            :aria-label="'Image ' + (idx + 1)"
                            @click="openImageViewer(visibleImageSamples, idx)"
                        >
                            <img
                                :src="getImageSrc(url)"
                                :class="{ 'asmr-meta-gallery-img--loaded': isImageLoaded(url) }"
                                loading="lazy"
                                alt="Sample"
                                referrerpolicy="strict-origin-when-cross-origin"
                                @load="onImageLoad(url)"
                                @error="onImageError(url)"
                            >
                        </button>
                    </div>

                    <!-- Full body content with paragraph-aligned translations -->
                    <div v-if="bodyParagraphs.length" class="asmr-meta-body-section">
                        <div class="asmr-meta-body-grid">
                            <div
                                v-for="(para, idx) in bodyParagraphs"
                                :key="idx"
                                class="asmr-meta-body-row"
                            >
                                <!-- eslint-disable-next-line vue/no-v-html -->
                                <div class="asmr-meta-body-cell asmr-meta-body-cell--original" v-html="cnOnlyMode && bodyTranslations.get(idx) ? bodyTranslations.get(idx) : paragraphHtml(para)"></div>
                                <div
                                    v-if="shouldTranslate && bodyTranslations.get(idx)"
                                    class="asmr-meta-body-cell asmr-meta-body-cell--translated"
                                >
                                    {{ bodyTranslations.get(idx) }}
                                </div>
                                <div
                                    v-else-if="shouldTranslate"
                                    class="asmr-meta-body-cell asmr-meta-body-cell--translated"
                                >
                                    ...
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- File contents -->
                    <div v-if="meta.contents?.length" class="asmr-meta-files">
                        <div class="asmr-meta-section-label">
                            <i class="material-icons" style="font-size:16px;vertical-align:middle">folder</i>
                            {{ format('metaFileContents', { count: String(meta.contents.length) }) }}
                        </div>
                        <div class="asmr-meta-file-scroll">
                            <div
                                v-for="(file, idx) in meta.contents"
                                :key="idx"
                                class="asmr-meta-file-row"
                            >
                                <span class="asmr-meta-file-name">{{ file.file_name }}</span>
                                <span class="asmr-meta-file-size">{{ file.file_size }}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
/* ============================================
   Work Metadata Panel Components
   Mobile-first, theme-reactive via CSS variables
   ============================================ */

/* === Panel Container === */
.asmr-metadata-panel {
    background: var(--asmr-bg-tertiary);
    border-left: 4px solid var(--q-primary, var(--asmr-accent, #7c4dff));
    overflow: hidden;
    border-radius: 4px;
}

.asmr-meta-content {
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
}

/* === Stats Row (badge, price, rank, archives, rating) === */
.asmr-meta-stats {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
}

.asmr-meta-badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.5px;
    line-height: 1.4;
}

.asmr-meta-badge--r18 {
    background: var(--q-negative, #f44336);
    color: #fff;
}

.asmr-meta-badge--all {
    background: var(--q-positive, #4caf50);
    color: #fff;
}

.asmr-meta-price {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
    font-weight: 600;
}

.asmr-meta-price-old {
    text-decoration: line-through;
    opacity: 0.6;
    font-size: 0.8rem;
    color: var(--asmr-text-tertiary);
}

.asmr-meta-price-current {
    font-size: 1.1rem;
    color: var(--q-negative, #f44336);
}

.asmr-meta-discount {
    font-size: 0.75rem;
    padding: 1px 5px;
    border-radius: 3px;
    background: var(--q-negative, #f44336);
    color: #fff;
    font-weight: 600;
}

.asmr-meta-stat {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 0.8rem;
    color: var(--asmr-text-tertiary);
}

.asmr-meta-refresh {
    margin-left: auto;
    background: none;
    border: 1px solid var(--asmr-border, rgba(255, 255, 255, 0.12));
    border-radius: 4px;
    color: var(--asmr-text-secondary, rgba(255, 255, 255, 0.7));
    cursor: pointer;
    padding: 2px 4px;
    display: inline-flex;
    align-items: center;
    transition: color 0.2s, border-color 0.2s;
}

.asmr-meta-refresh:hover {
    color: var(--asmr-accent, #7c4dff);
    border-color: var(--asmr-accent, #7c4dff);
}

/* === Chips === */
.asmr-meta-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}

.asmr-chip-tag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 10px;
    border-radius: 12px;
    font-size: 0.8rem;
    cursor: pointer;
    transition: opacity 0.15s, box-shadow 0.15s;
    line-height: 1.4;
    background: none;
    border: none;
}

.asmr-chip-tag:hover {
    opacity: 0.85;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
}

.asmr-chip-icon {
    font-size: 14px;
}

.asmr-chip-tag--circle {
    background: var(--q-positive, #4caf50);
    color: #fff;
}

.asmr-chip-tag--cv {
    background: #009688;
    color: #fff;
}

.asmr-chip-tag--tag {
    background: var(--asmr-hover-bg);
    color: var(--asmr-text-primary);
    border: 1px solid var(--asmr-border-color);
}

/* === Description (above fold) === */
.asmr-meta-description {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.asmr-meta-description-cell {
    font-size: 0.9rem;
    line-height: 1.55;
    min-width: 0;
    word-break: break-word;
    white-space: pre-wrap;
}

.asmr-meta-description-cell--original {
    color: var(--asmr-text-secondary);
}

.asmr-meta-description-cell--translated {
    color: var(--q-primary, var(--asmr-accent, #7c4dff));
    font-size: 0.88rem;
}

.asmr-meta-description-cell--translated:empty {
    display: none;
}

/* === Toggle Button === */
.asmr-meta-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    width: 100%;
    padding: 6px 0;
    background: none;
    border: none;
    border-top: 1px solid var(--asmr-border-color);
    color: var(--q-primary, var(--asmr-accent, #7c4dff));
    font-size: 0.8rem;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
}

.asmr-meta-toggle:hover {
    background: var(--asmr-hover-bg);
}

.asmr-meta-toggle .material-icons {
    font-size: 18px;
}

/* === Details (expandable section) === */
.asmr-meta-details {
    background: var(--asmr-bg-secondary);
    border-radius: 0 0 4px 4px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

/* === Image Gallery === */
.asmr-meta-gallery {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding-bottom: 4px;
    -webkit-overflow-scrolling: touch;
}

.asmr-meta-gallery-item {
    flex-shrink: 0;
    width: 140px;
    aspect-ratio: 4 / 3;
    border-radius: 6px;
    overflow: hidden;
    cursor: pointer;
    transition: box-shadow 0.15s;
    background: var(--asmr-hover-bg);
    border: none;
    padding: 0;
}

.asmr-meta-gallery-item:hover {
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.asmr-meta-gallery-item img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0;
    transition: opacity 0.15s ease;
}

.asmr-meta-gallery-item img.asmr-meta-gallery-img--loaded {
    opacity: 1;
}

/* === Body Text === */
.asmr-meta-body-section {
    display: flex;
    flex-direction: column;
    gap: 0;
}

.asmr-meta-body-grid {
    display: flex;
    flex-direction: column;
    gap: 0;
    max-height: 500px;
    overflow-y: auto;
}

.asmr-meta-body-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px 0;
    border-bottom: 1px solid var(--asmr-border-color);
}

.asmr-meta-body-row:last-child {
    border-bottom: none;
}

.asmr-meta-body-cell {
    font-size: 0.875rem;
    line-height: 1.6;
    min-width: 0;
    white-space: pre-wrap;
    word-break: break-word;
}

.asmr-meta-body-cell--original {
    color: var(--asmr-text-secondary);
}

.asmr-meta-body-cell--translated {
    color: var(--q-primary, var(--asmr-accent, #7c4dff));
    font-size: 0.85rem;
}

.asmr-meta-body-cell--translated:empty {
    display: none;
}

.asmr-meta-body-cell :deep(img) {
    max-width: 100%;
    height: auto;
    border-radius: 4px;
    margin: 4px 0;
}

.asmr-meta-body-cell :deep(a) {
    color: var(--q-primary, var(--asmr-accent, #7c4dff));
    word-break: break-all;
    text-decoration: underline;
    cursor: pointer;
}

.asmr-meta-body-cell :deep(a:hover) {
    opacity: 0.8;
}

/* === Section Labels === */
.asmr-meta-section-label {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--asmr-text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--asmr-border-color);
}

/* === File Contents === */
.asmr-meta-files {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.asmr-meta-file-scroll {
    max-height: 180px;
    overflow-y: auto;
}

.asmr-meta-file-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 0;
    font-size: 0.8rem;
    border-bottom: 1px solid var(--asmr-border-color);
}

.asmr-meta-file-row:last-child {
    border-bottom: none;
}

.asmr-meta-file-name {
    color: var(--asmr-text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
}

.asmr-meta-file-size {
    color: var(--asmr-text-tertiary);
    flex-shrink: 0;
    margin-left: 12px;
}

/* === Dark Mode Adjustments === */
:is(.body--dark, .q-dark) .asmr-chip-tag--tag {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 255, 255, 0.12);
}

:is(.body--dark, .q-dark) .asmr-meta-gallery-item {
    background: rgba(255, 255, 255, 0.05);
}

/* === Responsive: Tablet+ === */
@media (min-width: 600px) {
    .asmr-meta-content {
        padding: 14px;
    }

    .asmr-meta-gallery-item {
        width: 180px;
    }

    .asmr-meta-body-grid {
        max-height: 600px;
    }
}

@media (min-width: 960px) {
    /* Side-by-side description on desktop */
    .asmr-meta-description {
        flex-direction: row;
        gap: 16px;
    }

    .asmr-meta-description-cell--original {
        flex: 1;
        border-right: 1px solid var(--asmr-border-color);
        padding-right: 16px;
    }

    .asmr-meta-description-cell--translated {
        flex: 1;
    }

    /* Side-by-side paragraph rows on desktop */
    .asmr-meta-body-row {
        flex-direction: row;
        gap: 16px;
    }

    .asmr-meta-body-cell--original {
        flex: 1;
        border-right: 1px solid var(--asmr-border-color);
        padding-right: 16px;
    }

    .asmr-meta-body-cell--translated {
        flex: 1;
    }

    .asmr-meta-gallery-item {
        width: 200px;
    }
}
</style>
