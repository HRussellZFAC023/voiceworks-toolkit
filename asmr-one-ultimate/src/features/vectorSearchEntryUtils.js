export const SEMANTIC_DOCUMENT_MAX_CHARS = 640;
export const SEMANTIC_DESCRIPTION_MAX_CHARS = 1500;
export const SEMANTIC_PAYLOAD_MAX_CHARS = 5000;

/** @param {string} text @param {number} maxChars */
function truncateText(text, maxChars) {
    if (!text) return '';
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}...`;
}

/** @param {string} text */
function normalizeText(text) {
    return text ? text.normalize('NFKC').toLowerCase() : '';
}

/** @param {(string | undefined | null)[]} values */
function uniqueStrings(values) {
    const seen = new Set();
    for (const value of values) {
        if (!value) continue;
        const normalized = value.trim();
        if (normalized) seen.add(normalized);
    }
    return [...seen];
}

/**
 * Pure entry recipe shared by the browser delta indexer and offline producer.
 * @param {import('./vectorSearchEntryUtils').SemanticWorkInput} work
 * @param {import('./vectorSearchEntryUtils').SemanticEntryPreparationOptions} [options]
 * @returns {import('./vectorSearchEntryUtils').PreparedSemanticWork | null}
 */
export function prepareSemanticWorkEntry(work, options = {}) {
    if (!work?.id) return null;
    const id = String(work.id);
    const title = work.title || '';
    const descriptionRaw = work.description || work.summary || '';
    const description = truncateText(descriptionRaw, SEMANTIC_DESCRIPTION_MAX_CHARS);
    const circle = work.circle?.name || '';
    const series = work.series?.name || '';
    const vas = (work.vas || []).map((voiceActor) => voiceActor?.name || '').filter(Boolean);
    const tags = work.tags || [];
    const displayTags = uniqueStrings(tags.map((tag) => tag?.name || ''));
    const searchTagValues = [];
    for (const tag of tags) {
        searchTagValues.push(...(options.resolveTagAliases?.(tag) || []));
        searchTagValues.push(tag?.name || '', tag?.i18n?.['en-us']?.name || '', tag?.i18n?.['ja-jp']?.name || '');
    }
    const searchTags = uniqueStrings(searchTagValues);
    const ageCategory = String(work.age_category_string || '');
    const languageEditions = Array.isArray(work.language_editions)
        ? work.language_editions.map((edition) => edition?.lang || edition?.label || '').filter(Boolean)
        : [];
    const payloadParts = [];
    if (title) payloadParts.push(`Title: ${title}`);
    if (circle) payloadParts.push(`Circle: ${circle}`);
    if (series) payloadParts.push(`Series: ${series}`);
    if (vas.length) payloadParts.push(`VAs: ${vas.join(', ')}`);
    if (searchTags.length) payloadParts.push(`Tags: ${searchTags.join(', ')}`);
    if (ageCategory) payloadParts.push(`Category: ${ageCategory}`);
    if (languageEditions.length) payloadParts.push(`Languages: ${languageEditions.join(', ')}`);
    if (description) payloadParts.push(`Description: ${description}`);
    const payload = truncateText(payloadParts.join('\n'), SEMANTIC_PAYLOAD_MAX_CHARS);
    if (!payload.trim()) return null;
    const entry = {
        id,
        title,
        description,
        tags: displayTags,
        searchTags,
        circle: circle || undefined,
        series: series || undefined,
        vas: vas.length ? vas : undefined,
        searchText: normalizeText([
            title, description, circle, series, vas.join(' '), searchTags.join(' '),
        ].filter(Boolean).join(' ')),
        vector: [],
        release: typeof work.release === 'string' ? work.release : '',
        dlCount: typeof work.dl_count === 'number' ? work.dl_count : undefined,
        rating: typeof work.rate_average_2dp === 'number' ? work.rate_average_2dp : undefined,
        nsfw: typeof work.nsfw === 'boolean' ? work.nsfw : undefined,
        hasSubtitle: typeof work.has_subtitle === 'boolean' ? work.has_subtitle : undefined,
    };
    return { entry, payload };
}

/** Canonical document input shared by baseline production and client deltas. @param {string} value */
export function canonicalSemanticDocumentPayload(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, SEMANTIC_DOCUMENT_MAX_CHARS);
}

/** Exact text passed to the E5 feature extractor. @param {string} value */
export function canonicalSemanticPassageModelInput(value) {
    return `passage: ${canonicalSemanticDocumentPayload(value)}`;
}

/** @param {ArrayLike<number>} left @param {ArrayLike<number>} right */
export function semanticDotProduct(left, right) {
    if (left.length !== right.length) return 0;
    let dot = 0;
    for (let index = 0; index < left.length; index++) dot += left[index] * right[index];
    return dot;
}
