const RJ_EXACT_RE = /^RJ\d{6,8}$/i;
const RJ_EMBEDDED_RE = /RJ\d{6,8}/i;
const NUMERIC_EXACT_RE = /^\d{6,8}$/;
const NUMERIC_EMBEDDED_RE = /\d{6,8}/;

function toInputString(value: unknown): string {
    return String(value ?? '').trim();
}

export function normalizeRjCode(value: unknown): string {
    const input = toInputString(value);
    if (!input) return '';
    if (RJ_EXACT_RE.test(input)) return input.toUpperCase();
    if (NUMERIC_EXACT_RE.test(input)) return `RJ${input}`;
    return '';
}

export function extractEmbeddedRjCode(value: unknown): string | null {
    const input = toInputString(value);
    if (!input) return null;
    const rjMatch = input.match(RJ_EMBEDDED_RE);
    return rjMatch ? rjMatch[0].toUpperCase() : null;
}

export function extractRjCodeFromText(value: unknown): string | null {
    const exact = normalizeRjCode(value);
    if (exact) return exact;

    const embeddedRj = extractEmbeddedRjCode(value);
    if (embeddedRj) return embeddedRj;

    const input = toInputString(value);
    if (!input) return null;
    const numericMatch = input.match(NUMERIC_EMBEDDED_RE);
    return numericMatch ? `RJ${numericMatch[0]}` : null;
}

export function extractPrimaryRjCode(params: {
    sourceId?: unknown;
    workId?: unknown;
    title?: unknown;
    allowTitleNumeric?: boolean;
}): string | null {
    const sourceCode = extractRjCodeFromText(params.sourceId);
    if (sourceCode) return sourceCode;

    const workIdCode = extractRjCodeFromText(params.workId);
    if (workIdCode) return workIdCode;

    if (params.allowTitleNumeric) {
        return extractRjCodeFromText(params.title);
    }

    return extractEmbeddedRjCode(params.title);
}

export function toRjNumericId(value: unknown): string | null {
    const code = extractRjCodeFromText(value);
    if (!code) return null;
    return code.slice(2);
}
