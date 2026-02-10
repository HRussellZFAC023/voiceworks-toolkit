import type { DLsiteUserReview } from '../types/dlsite';
import {
    extractEmbeddedRjCode,
    extractPrimaryRjCode,
} from './rjCodeUtils';

export interface CommentSectionEditionLike {
    id?: string | number | null;
    source_id?: string | number | null;
    sourceId?: string | number | null;
    workno?: string | null;
}

export interface CommentSectionTranslationInfoLike {
    original_workno?: string | null;
    parent_workno?: string | null;
    child_worknos?: Array<string | number> | null;
}

export interface CommentSectionWorkLike {
    id?: string | number | null;
    source_id?: string | number | null;
    sourceId?: string | number | null;
    title?: string | null;
    review_count?: number | null;
    userRating?: number | null;
    review_text?: string | null;
    language_editions?: CommentSectionEditionLike[] | null;
    translation_info?: CommentSectionTranslationInfoLike | null;
    other_language_editions_in_db?: CommentSectionEditionLike[] | null;
}

const STOP_MARKERS = [
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

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function sanitizeReviewText(text: string): string {
    let s = text;

    for (const marker of STOP_MARKERS) {
        const idx = s.indexOf(marker);
        if (idx !== -1) s = s.substring(0, idx);
    }

    s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
    s = s.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
    s = s.replace(/<style[\s\S]*?<\/style>/gi, '');

    s = s.replace(/!\[Image \d+[^\]]*\]\([^)]*\)/g, '');
    s = s.replace(/!\[[^\]]*\]\([^)]*(?:analytics|octopuspop|adsct|twitter|doubleclick|facebook|banner|gsspat|bance|rubiconproject|modpub|logo|payment|recruit)[^)]*\)/gi, '');
    s = s.replace(/<img[^>]*src="[^"]*(?:analytics|octopuspop|adsct|twitter|doubleclick|facebook|banner|gsspat|bance|rubiconproject|modpub|logo|payment|recruit)[^"]*"[^>]*\/?>/gi, '');

    s = s.replace(/\*?\s*\[([^\]]*)\]\(https?:\/\/(?:www\.dlsite\.com\/home\/|www\.dlsite\.com\/maniax\/work|www\.dlsite\.com\/maniax\/(?:regist|login|mypage|guide|rule|faq|inquiry)|www\.dlsite\.com\/modpub|ci-en|ch\.dlsite|www\.nijiyome|chobit|triokini|play\.dlsite|hire\.wantedly|www\.eisys|www\.geonet|cs\.dlsite|min-hon|www\.youtube|x\.com|t\.co|analytics\.twitter)[^)]*\)/gi, '');
    s = s.replace(/\*?\s*\[\s*\]\([^)]*\)/g, '');

    s = s.replace(/!\[[^\]]*\]\(https?:\/\/img\.dlsite\.jp[^)]*\)/gi, '');

    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_match, label: string, url: string) => {
        const safeLabel = escapeHtml(label);
        const safeUrl = escapeHtml(url);
        return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeLabel}</a>`;
    });
    s = s.replace(/(^|[^("'])(https?:\/\/[^\s<>"')\]]+)/gm, (_match, prefix: string, url: string) => {
        const safeUrl = escapeHtml(url);
        return `${prefix}<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>`;
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');

    s = s.replace(/``/g, '\u201c');
    s = s.replace(/''/g, '\u201d');

    s = s.replace(/^\d+\s*\u5186\s*$/gm, '');
    s = s.replace(/^\u4fa1\u683c\s*$/gm, '');
    s = s.replace(/^Multi Lang\.\s*$/gm, '');
    s = s.replace(/^\u65e5\u672c\u8a9e\s*$/gm, '');
    s = s.replace(/^Sales:\s*\d+\s*$/gm, '');
    s = s.replace(/^\d+\s*JPY(?:Sales:\s*\d+)?\s*$/gm, '');
    s = s.replace(/^\u96a0\u3059\s*$/gm, '');
    s = s.replace(/^\u30ab\u30fc\u30c8\s*$/gm, '');

    s = s.replace(/^(?:Windows|Mac|iOS|Android|\u305d\u306e\u4ed6)-?\s*$/gm, '');
    s = s.replace(/^\u5bfe\u5fdc\uff2f\uff33\s*$/gm, '');
    s = s.replace(/^\u5bfe\u5fdcOS\s*$/gm, '');
    s = s.replace(/^\u5bfe\u5fdc\u30a2\u30d7\u30ea.*$/gm, '');
    s = s.replace(/^DLsite Sound\s*$/gm, '');

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

export function getReviewParagraphs(review: DLsiteUserReview): string[] {
    if (!review.text) return [];
    const sanitized = sanitizeReviewText(review.text);
    if (!sanitized || sanitized.length < 3) return [];
    return sanitized
        .split(/\n\n+/)
        .map(p => p.trim())
        .filter(Boolean)
        .map(p => p.replace(/\n/g, '<br>'));
}

export function htmlToPlainText(html: string): string {
    if (typeof document !== 'undefined') {
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        return tmp.textContent ?? '';
    }

    return html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

export function extractRjCode(work: CommentSectionWorkLike | null, workId: string | number | null): string | null {
    return extractPrimaryRjCode({
        sourceId: work?.source_id ?? work?.sourceId,
        workId,
        title: work?.title,
    });
}

export function extractAllRjCodes(work: CommentSectionWorkLike | null, workId: string | number | null): string[] {
    const codes = new Set<string>();
    const primary = extractRjCode(work, workId);
    if (primary) codes.add(primary);
    if (!work) return [...codes];

    for (const edition of work.language_editions ?? []) {
        const code = extractEmbeddedRjCode(edition?.workno);
        if (code) codes.add(code);
    }

    const translationInfo = work.translation_info;
    if (translationInfo) {
        const originalCode = extractEmbeddedRjCode(translationInfo.original_workno);
        if (originalCode) codes.add(originalCode);

        const parentCode = extractEmbeddedRjCode(translationInfo.parent_workno);
        if (parentCode) codes.add(parentCode);

        for (const childWorkno of translationInfo.child_worknos ?? []) {
            const childCode = extractEmbeddedRjCode(childWorkno);
            if (childCode) codes.add(childCode);
        }
    }

    for (const edition of work.other_language_editions_in_db ?? []) {
        const code = extractEmbeddedRjCode(edition?.source_id ?? edition?.sourceId);
        if (code) codes.add(code);
    }

    return [...codes];
}

export function getAllRelatedWorkIds(workId: string | number | null, work: CommentSectionWorkLike | null): number[] {
    const ids = new Set<number>();
    const primary = Number.parseInt(String(workId ?? ''), 10);
    if (Number.isFinite(primary)) ids.add(primary);

    for (const edition of work?.other_language_editions_in_db ?? []) {
        const editionId = Number.parseInt(String(edition?.id ?? ''), 10);
        if (Number.isFinite(editionId)) ids.add(editionId);
    }

    return [...ids];
}
