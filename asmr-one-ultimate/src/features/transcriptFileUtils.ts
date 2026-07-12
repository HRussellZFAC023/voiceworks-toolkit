import type { WhisperSegment } from '../types';

export function formatLrcTimestamp(seconds: number): string {
    const safe = Math.max(0, seconds);
    const totalCentis = Math.round(safe * 100);
    const minutes = Math.floor(totalCentis / 6000);
    const secondCentis = totalCentis % 6000;
    const secs = Math.floor(secondCentis / 100);
    const centis = secondCentis % 100;
    const mm = String(minutes).padStart(2, '0');
    const ss = String(secs).padStart(2, '0');
    const xx = String(centis).padStart(2, '0');
    return `${mm}:${ss}.${xx}`;
}

/**
 * Remove temporally overlapping segments from an already-sorted array.
 * Whisper chunk strides produce overlapping segments with slightly different
 * text (e.g. kanji vs hiragana for the same speech). For clean export, keep
 * the longer/more-detailed segment when two overlap by more than 50%.
 */
function deduplicateOverlappingSegments(sorted: WhisperSegment[]): WhisperSegment[] {
    if (sorted.length <= 1) return sorted;
    const result: WhisperSegment[] = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
        const prev = result[result.length - 1];
        const curr = sorted[i];
        const overlapStart = Math.max(prev.start, curr.start);
        const overlapEnd = Math.min(prev.end, curr.end);
        const overlapDuration = Math.max(0, overlapEnd - overlapStart);
        const prevDuration = prev.end - prev.start;
        const currDuration = curr.end - curr.start;
        const shorterDuration = Math.min(prevDuration, currDuration);
        // If the shorter segment is >50% overlapped, merge by keeping the longer one
        if (shorterDuration > 0 && overlapDuration / shorterDuration > 0.5) {
            if (currDuration > prevDuration) {
                result[result.length - 1] = curr; // replace with longer
            }
            // else keep prev (already in result)
        } else {
            result.push(curr);
        }
    }
    return result;
}

export function buildPlainTextFromSegments(segments: WhisperSegment[]): string {
    if (!segments?.length) return '';
    const sorted = [...segments].sort((a, b) => a.start - b.start);
    return deduplicateOverlappingSegments(sorted)
        .map((segment) => segment.text.trim())
        .filter(Boolean)
        .join('\n');
}

export function buildLrcFromSegments(segments: WhisperSegment[]): string {
    if (!segments?.length) return '';
    const sorted = [...segments].sort((a, b) => a.start - b.start);
    const deduped = deduplicateOverlappingSegments(sorted);
    return deduped.map((seg) => `[${formatLrcTimestamp(seg.start)}]${seg.text}`).join('\n');
}

export function formatVttTimestamp(seconds: number): string {
    const safe = Math.max(0, seconds);
    const totalMillis = Math.round(safe * 1000);
    const hours = Math.floor(totalMillis / 3_600_000);
    const remainingAfterHours = totalMillis % 3_600_000;
    const minutes = Math.floor(remainingAfterHours / 60_000);
    const remainingAfterMinutes = remainingAfterHours % 60_000;
    const secs = Math.floor(remainingAfterMinutes / 1000);
    const millis = remainingAfterMinutes % 1000;
    const hh = String(hours).padStart(2, '0');
    const mm = String(minutes).padStart(2, '0');
    const ss = String(secs).padStart(2, '0');
    const mmm = String(millis).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${mmm}`;
}

export function buildVttFromSegments(segments: WhisperSegment[]): string {
    if (!segments?.length) return '';
    const sorted = [...segments].sort((a, b) => a.start - b.start);
    const deduped = deduplicateOverlappingSegments(sorted);
    const lines = ['WEBVTT', ''];
    for (let i = 0; i < deduped.length; i++) {
        const seg = deduped[i];
        const safeEnd = Math.max(seg.start + 0.01, seg.end);
        lines.push(`${i + 1}`);
        lines.push(`${formatVttTimestamp(seg.start)} --> ${formatVttTimestamp(safeEnd)}`);
        if (seg.words?.length) {
            const parts = seg.words.map((word) => `<${formatVttTimestamp(word.start)}>${word.text}`);
            lines.push(parts.join(''));
        } else {
            lines.push(seg.text);
        }
        lines.push('');
    }
    return lines.join('\n');
}

export function buildTranscriptFileName(
    title: string | undefined,
    model: string | undefined,
    lang: string,
    ext: 'lrc' | 'vtt' | string = 'lrc',
): string {
    const baseTitle = (title || 'transcript').replace(/[\\/:*?"<>|]/g, '_');
    const modelSuffix = model?.split('/').pop() || 'whisper';
    return `${baseTitle}.${lang}.${modelSuffix}.${ext}`;
}
