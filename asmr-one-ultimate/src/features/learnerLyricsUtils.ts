import type { AudioPlayerState } from '../types';

export interface LyricWord {
    start: number;
    end: number;
    text: string;
}

export interface LyricLine {
    time: number;
    endTime?: number;
    text: string;
    words?: LyricWord[];
}

export interface RawLyricLine {
    time?: number;
    text?: string;
    content?: string;
    lyric?: string;
    endTime?: number;
    end?: number;
    start?: number;
    startTime?: number;
    words?: LyricWord[];
    [key: string]: unknown;
}

interface SubtitleContainer {
    lines?: RawLyricLine[];
    lrcLines?: RawLyricLine[];
    lyrics?: RawLyricLine[];
    items?: RawLyricLine[];
    cues?: RawLyricLine[];
    current?: string;
    text?: string;
    [key: string]: unknown;
}

export interface ExtendedAudioPlayerState extends AudioPlayerState {
    lyrics?: RawLyricLine[];
    lyricLines?: RawLyricLine[];
    lrc?: RawLyricLine[];
    subtitleLines?: RawLyricLine[];
    subtitles?: RawLyricLine[];
    subtitle?: SubtitleContainer;
    lyric?: { lines?: RawLyricLine[] };
    currentLyric?: string;
    currentLyricText?: string;
    [key: string]: unknown;
}

interface VueLyricsInstance {
    [key: string]: unknown;
    $data?: Record<string, unknown>;
    $store?: { state?: Record<string, Record<string, unknown>> };
    $parent?: VueLyricsInstance;
}

const VUE_LYRICS_SELECTORS = ['#lyric', '.lyric-content', '.q-card__section', '.audio-player', '.q-footer'];

function normalizeToRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function getVmLyricsCandidate(vm: VueLyricsInstance): unknown {
    const vmRecord = normalizeToRecord(vm);
    const vmData = normalizeToRecord(vm.$data);
    const storeState = normalizeToRecord(vm.$store?.state);
    const audioPlayer = normalizeToRecord(storeState.AudioPlayer);
    return vmRecord.lyrics
        || vmRecord.lrcLines
        || vmRecord.lyricLines
        || vmData.lyrics
        || vmData.lrcLines
        || audioPlayer.lrcLines;
}

export function isLyricLineArray(lines: unknown[]): lines is RawLyricLine[] {
    const sample = lines.find((line) => line) as Record<string, unknown> | undefined;
    if (!sample) return false;
    return typeof sample.text === 'string' || typeof sample.content === 'string' || typeof sample.lyric === 'string';
}

export function getStoreLyricsSource(audioPlayerState: AudioPlayerState | Record<string, unknown> | null | undefined): RawLyricLine[] | null {
    const player = normalizeToRecord(audioPlayerState) as ExtendedAudioPlayerState;
    const candidates: unknown[] = [
        player.lyrics,
        player.lyricLines,
        player.lrcLines,
        player.lrc,
        player.subtitleLines,
        player.subtitles,
        player.subtitle?.lines,
        player.subtitle?.lrcLines,
        player.subtitle?.lyrics,
        player.subtitle?.items,
        player.subtitle?.cues,
        player.lyric?.lines,
    ];

    for (const candidate of candidates) {
        if (Array.isArray(candidate) && candidate.length > 0) return candidate as RawLyricLine[];
    }

    for (const value of Object.values(player)) {
        if (!value || typeof value !== 'object') continue;
        if (Array.isArray(value) && value.length > 0 && isLyricLineArray(value)) {
            return value as RawLyricLine[];
        }

        const inner = normalizeToRecord(value).lines
            || normalizeToRecord(value).items
            || normalizeToRecord(value).cues;
        if (Array.isArray(inner) && inner.length > 0 && isLyricLineArray(inner)) {
            return inner as RawLyricLine[];
        }
    }

    return null;
}

export function parseLyricsFromDom(root: Document | HTMLElement = document): Array<{ time: number; text: string }> | null {
    const lyricContent = root.querySelector('.lyric-content');
    if (!lyricContent) return null;

    const items = lyricContent.querySelectorAll('.q-item');
    if (items.length === 0) return null;

    const lyrics: Array<{ time: number; text: string }> = [];
    const timestampRegex = /\[(\d+):(\d+)\.(\d+)\]/;

    for (const item of Array.from(items)) {
        const label = item.querySelector('.q-item__label');
        if (!label) continue;

        const caption = item.querySelector('.q-item__label--caption');
        const captionText = caption?.textContent?.trim() || '';
        const match = timestampRegex.exec(captionText);
        const labelText = label.textContent?.replace(captionText, '').trim() || '';
        if (!match || !labelText) continue;

        const minutes = parseInt(match[1], 10);
        const seconds = parseInt(match[2], 10);
        const centiseconds = parseInt(match[3], 10);
        lyrics.push({
            time: (minutes * 60 + seconds) * 1000 + centiseconds * 10,
            text: labelText,
        });
    }

    return lyrics.length > 0 ? lyrics : null;
}

export function findLyricsSourceFromVueDom(root: Document | HTMLElement = document): RawLyricLine[] | null {
    for (const selector of VUE_LYRICS_SELECTORS) {
        const el = root.querySelector(selector) as (HTMLElement & { __vue__?: VueLyricsInstance }) | null;
        if (!el?.__vue__) continue;

        const data = getVmLyricsCandidate(el.__vue__);
        if (Array.isArray(data) && data.length > 0) {
            return data as RawLyricLine[];
        }

        let parent = el.__vue__.$parent;
        for (let i = 0; i < 5 && parent; i++) {
            const parentData = getVmLyricsCandidate(parent);
            if (Array.isArray(parentData) && parentData.length > 0) {
                return parentData as RawLyricLine[];
            }
            parent = parent.$parent;
        }
    }

    return null;
}

export function findLyricsSource(
    audioPlayerState: AudioPlayerState | Record<string, unknown> | null | undefined,
    root: Document | HTMLElement = document,
): RawLyricLine[] | Array<{ time: number; text: string }> | null {
    const storeLyrics = getStoreLyricsSource(audioPlayerState);
    if (storeLyrics && storeLyrics.length > 0) return storeLyrics;

    const vueLyrics = findLyricsSourceFromVueDom(root);
    if (vueLyrics && vueLyrics.length > 0) return vueLyrics;

    return parseLyricsFromDom(root);
}

export function parseVttContent(content: string): LyricLine[] {
    const lyrics: LyricLine[] = [];
    const lines = content.split(/\r?\n/);
    const timestampRegex = /^(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})/;

    let i = 0;
    while (i < lines.length && !timestampRegex.test(lines[i])) i++;

    while (i < lines.length) {
        const match = timestampRegex.exec(lines[i]);
        if (!match) {
            i++;
            continue;
        }

        const startHours = match[1] ? parseInt(match[1], 10) : 0;
        const startMinutes = parseInt(match[2], 10);
        const startSeconds = parseInt(match[3], 10);
        const startMillis = parseInt(match[4], 10);
        const startTime = startHours * 3600 + startMinutes * 60 + startSeconds + startMillis / 1000;

        const endHours = match[5] ? parseInt(match[5], 10) : 0;
        const endMinutes = parseInt(match[6], 10);
        const endSeconds = parseInt(match[7], 10);
        const endMillis = parseInt(match[8], 10);
        const endTime = endHours * 3600 + endMinutes * 60 + endSeconds + endMillis / 1000;

        i++;
        const textLines: string[] = [];
        while (i < lines.length && lines[i].trim() !== '' && !timestampRegex.test(lines[i])) {
            if (!/^\d+$/.test(lines[i].trim())) {
                textLines.push(lines[i].trim());
            }
            i++;
        }

        const text = textLines.join(' ').trim();
        if (text) lyrics.push({ time: startTime, endTime, text });
    }

    return lyrics;
}

export function parseLrcContent(content: string): Array<{ time: number; text: string }> {
    const lyrics: Array<{ time: number; text: string }> = [];
    const lines = content.split(/\r?\n/);
    const timestampRegex = /\[(\d+):(\d+)(?:\.(\d+))?\]/g;

    for (const line of lines) {
        if (!line.trim()) continue;
        if (/^\[(ti|ar|al|by|offset|re|ve):/i.test(line)) continue;

        const timestamps: number[] = [];
        let text = line;
        let match: RegExpExecArray | null;

        while ((match = timestampRegex.exec(line)) !== null) {
            const minutes = parseInt(match[1], 10);
            const seconds = parseInt(match[2], 10);
            const centiseconds = match[3] ? parseInt(match[3].padEnd(2, '0').slice(0, 2), 10) : 0;
            timestamps.push(minutes * 60 + seconds + centiseconds / 100);
            text = text.replace(match[0], '');
        }

        text = text.trim();
        if (!text || timestamps.length === 0) continue;

        for (const time of timestamps) {
            lyrics.push({ time, text });
        }
    }

    lyrics.sort((a, b) => a.time - b.time);
    return lyrics;
}

export function parseSubtitleContent(content: string): LyricLine[] {
    const fromVtt = parseVttContent(content);
    return fromVtt.length > 0 ? fromVtt : parseLrcContent(content);
}

function normalizeTimeValue(value: unknown, fallback: number): number {
    const parsed = typeof value === 'number' ? value : parseFloat(String(value ?? fallback));
    if (!Number.isFinite(parsed)) return fallback;
    // Some host payloads report milliseconds, others report seconds.
    return parsed > 1000 ? parsed / 1000 : parsed;
}

function normalizeOptionalTimeValue(value: unknown): number | undefined {
    if (value == null) return undefined;
    const parsed = normalizeTimeValue(value, NaN);
    return Number.isFinite(parsed) ? parsed : undefined;
}

export function normalizeLyricLines(lines: Array<Record<string, unknown>>): LyricLine[] {
    const normalized = lines.map((line) => {
        const time = normalizeTimeValue(line.time ?? line.start ?? line.startTime, 0);
        const endTime = normalizeOptionalTimeValue(line.end ?? line.endTime);
        return {
            time,
            endTime: endTime != null && endTime > time ? endTime : undefined,
            text: String(line.text ?? line.content ?? line.lyric ?? ''),
            words: Array.isArray(line.words) ? line.words as LyricWord[] : undefined,
        } satisfies LyricLine;
    });
    normalized.sort((a, b) => a.time - b.time);
    return normalized;
}
