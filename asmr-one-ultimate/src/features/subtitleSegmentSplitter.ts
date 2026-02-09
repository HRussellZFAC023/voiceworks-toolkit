export type SubtitleWordTiming = { start: number; end: number; text: string };
export type SubtitleLine = {
    time: number;
    endTime?: number;
    text: string;
    words?: SubtitleWordTiming[];
};

const DEFAULT_MAX_SUBTITLE_CHARS = 70;
const DEFAULT_CJK_MAX_SUBTITLE_CHARS = 48;
const PUNCT_SPLIT_MIN_RATIO = 0.6;
const SPLIT_PUNCT = /[。！？.!?\n]/;
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;

function charCount(text: string): number {
    return Array.from(text).length;
}

function isCjkText(text: string): boolean {
    return CJK_RE.test(text);
}

function trimCharSlice(chars: string[], start: number, end: number): { start: number; end: number; text: string } | null {
    let s = start;
    let e = end;
    while (s < e && /\s/.test(chars[s])) s++;
    while (e > s && /\s/.test(chars[e - 1])) e--;
    if (e <= s) return null;
    return { start: s, end: e, text: chars.slice(s, e).join('') };
}

function splitTextByMax(text: string, maxChars: number): Array<{ text: string; start: number; end: number }> {
    const chars = Array.from(text);
    const chunks: Array<{ text: string; start: number; end: number }> = [];
    const minPunctIdx = Math.max(1, Math.floor(maxChars * PUNCT_SPLIT_MIN_RATIO));

    let offset = 0;
    while (offset < chars.length) {
        const hardEnd = Math.min(chars.length, offset + maxChars);
        let cut = hardEnd;

        if (hardEnd < chars.length) {
            for (let i = hardEnd - 1; i >= offset + minPunctIdx; i--) {
                if (SPLIT_PUNCT.test(chars[i])) {
                    cut = i + 1;
                    break;
                }
            }
        }

        if (cut <= offset) cut = hardEnd;
        const trimmed = trimCharSlice(chars, offset, cut);
        if (trimmed) {
            chunks.push({
                text: trimmed.text,
                start: trimmed.start,
                end: trimmed.end,
            });
        }
        offset = cut;
    }

    return chunks;
}

function splitOversizeWord(word: SubtitleWordTiming, maxChars: number): SubtitleLine[] {
    const text = (word.text || '').trim();
    if (!text) return [];
    const totalChars = charCount(text);
    if (totalChars <= maxChars) {
        return [{ time: word.start, endTime: word.end, text, words: [{ ...word, text }] }];
    }

    const pieces = splitTextByMax(text, maxChars);
    const duration = Math.max(0, word.end - word.start);
    const result: SubtitleLine[] = [];
    for (const piece of pieces) {
        const startFrac = piece.start / totalChars;
        const endFrac = piece.end / totalChars;
        const start = word.start + duration * startFrac;
        const end = word.start + duration * endFrac;
        result.push({
            time: start,
            endTime: end,
            text: piece.text,
            words: [{ start, end, text: piece.text }],
        });
    }
    return result;
}

export function splitSubtitleSegments(lines: SubtitleLine[]): SubtitleLine[] {
    const result: SubtitleLine[] = [];

    for (const line of lines) {
        const text = (line.text || '').trim();
        if (!text) continue;

        const maxChars = isCjkText(text) ? DEFAULT_CJK_MAX_SUBTITLE_CHARS : DEFAULT_MAX_SUBTITLE_CHARS;
        if (charCount(text) <= maxChars) {
            result.push(line);
            continue;
        }

        if (line.words?.length) {
            let chunkWords: SubtitleWordTiming[] = [];
            let chunkText = '';

            const flushChunk = () => {
                if (chunkWords.length === 0 || !chunkText.trim()) return;
                result.push({
                    time: chunkWords[0].start,
                    endTime: chunkWords[chunkWords.length - 1].end,
                    text: chunkText.trim(),
                    words: chunkWords,
                });
                chunkWords = [];
                chunkText = '';
            };

            for (const word of line.words) {
                const wt = (word.text || '').trim();
                if (!wt) continue;

                if (charCount(wt) > maxChars) {
                    flushChunk();
                    result.push(...splitOversizeWord(word, maxChars));
                    continue;
                }

                const candidate = chunkText + wt;
                if (chunkText && charCount(candidate) > maxChars) {
                    flushChunk();
                }

                chunkWords.push(word);
                chunkText += wt;

                if (charCount(chunkText) >= maxChars * PUNCT_SPLIT_MIN_RATIO && SPLIT_PUNCT.test(wt.slice(-1))) {
                    flushChunk();
                }
            }

            flushChunk();
            continue;
        }

        const totalChars = charCount(text);
        const duration = Math.max(0, (line.endTime ?? line.time) - line.time);
        const chunks = splitTextByMax(text, maxChars);
        for (const chunk of chunks) {
            const startFrac = chunk.start / totalChars;
            const endFrac = chunk.end / totalChars;
            result.push({
                time: line.time + duration * startFrac,
                endTime: line.time + duration * endFrac,
                text: chunk.text,
            });
        }
    }

    return result;
}

