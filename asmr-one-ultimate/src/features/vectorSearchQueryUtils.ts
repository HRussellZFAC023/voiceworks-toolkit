export type SearchQueryScript = 'japanese' | 'chinese' | 'other';

const KANA_PATTERN = /[\u3040-\u30ff]/u;
const HAN_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const TOKEN_SPLIT_PATTERN = /[^a-z0-9\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu;
const HAN_RUN_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{2,}/gu;

/**
 * Classify a search query for expansion purposes. Han alone is ambiguous in
 * general, but treating it as Chinese is the useful default for user-entered
 * search: Japanese queries normally contain kana, while the old Han-is-JP
 * rule made every unspaced Chinese query skip its Japanese tag expansion.
 */
export function detectSearchQueryScript(text: string): SearchQueryScript {
    if (KANA_PATTERN.test(text)) return 'japanese';
    if (HAN_PATTERN.test(text)) return 'chinese';
    return 'other';
}

/** Result titles use broader CJK eligibility than query routing. */
export function containsCjkForResultTranslation(text: string): boolean {
    return KANA_PATTERN.test(text) || HAN_PATTERN.test(text);
}

function addToken(tokens: Set<string>, token: string): void {
    const trimmed = token.trim();
    if (trimmed.length >= 2) tokens.add(trimmed);
}

/**
 * Tokenize semantic-search queries without a dictionary dependency. Chinese
 * has no whitespace word boundaries, so retain the complete phrase and add
 * overlapping Han bigrams. This improves exact title/tag recall while the
 * multilingual embedding continues to carry the semantic signal.
 */
export function extractSearchTokens(text: string): string[] {
    const normalized = text ? text.normalize('NFKC').toLowerCase() : '';
    const tokens = new Set<string>();
    for (const part of normalized.split(TOKEN_SPLIT_PATTERN)) addToken(tokens, part);

    if (detectSearchQueryScript(normalized) === 'chinese') {
        for (const match of normalized.matchAll(HAN_RUN_PATTERN)) {
            const run = match[0];
            for (let index = 0; index < run.length - 1; index += 1) {
                addToken(tokens, run.slice(index, index + 2));
            }
        }
    }
    return Array.from(tokens);
}
