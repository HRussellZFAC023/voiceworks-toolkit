type WorkLike = {
    source_id?: string | number | null;
    sourceId?: string | number | null;
} | null | undefined;

const RJ_CODE_RE = /^RJ\d{6,8}$/i;
const RJ_NUMERIC_RE = /^\d{6,8}$/;

function normalizeRjCode(raw: string): string {
    const input = raw.trim();
    if (!input) return '';
    if (RJ_CODE_RE.test(input)) return input.toUpperCase();
    if (RJ_NUMERIC_RE.test(input)) return `RJ${input}`;
    return '';
}

export function extractRjCode(work: WorkLike, workId: string | number | null | undefined): string {
    const sourceId = String(work?.source_id ?? work?.sourceId ?? '').trim();
    const fromSource = normalizeRjCode(sourceId);
    if (fromSource) return fromSource;
    return normalizeRjCode(String(workId ?? ''));
}

export function buildHvdbUrl(rjCode: string): string {
    const code = normalizeRjCode(rjCode);
    if (!code) return '';
    const hvdbId = code.replace(/^RJ/i, '');
    return `https://hvdb.me/Dashboard/Add?id=${hvdbId}`;
}

export function buildChobitUrl(rjCode: string): string {
    const code = normalizeRjCode(rjCode);
    if (!code) return '';
    return `https://chobit.cc/s/?f_category=all&q_keyword=${code}`;
}

