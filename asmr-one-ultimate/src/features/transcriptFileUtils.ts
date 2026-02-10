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

export function buildLrcFromSegments(segments: WhisperSegment[]): string {
    if (!segments?.length) return '';
    return segments.map((seg) => `[${formatLrcTimestamp(seg.start)}]${seg.text}`).join('\n');
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
    const lines = ['WEBVTT', ''];
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
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
