import { describe, expect, it } from 'vitest';
import {
    buildLrcFromSegments,
    buildTranscriptFileName,
    buildVttFromSegments,
    formatLrcTimestamp,
    formatVttTimestamp,
} from '../../src/features/transcriptFileUtils';

describe('transcriptFileUtils', () => {
    it('formats LRC timestamps', () => {
        expect(formatLrcTimestamp(0)).toBe('00:00.00');
        expect(formatLrcTimestamp(61.23)).toBe('01:01.23');
        expect(formatLrcTimestamp(-1)).toBe('00:00.00');
    });

    it('builds LRC from segments', () => {
        const lrc = buildLrcFromSegments([
            { start: 0, end: 1, text: 'hello' } as any,
            { start: 1.5, end: 2, text: 'world' } as any,
        ]);
        expect(lrc).toContain('[00:00.00]hello');
        expect(lrc).toContain('[00:01.50]world');
    });

    it('formats VTT timestamps', () => {
        expect(formatVttTimestamp(0)).toBe('00:00:00.000');
        expect(formatVttTimestamp(65.432)).toBe('00:01:05.432');
        expect(formatVttTimestamp(-1)).toBe('00:00:00.000');
    });

    it('builds VTT with and without word timings', () => {
        const vtt = buildVttFromSegments([
            {
                start: 0,
                end: 1,
                text: 'hello',
                words: [{ start: 0, end: 0.5, text: 'he' }, { start: 0.5, end: 1, text: 'llo' }],
            } as any,
            {
                start: 1,
                end: 2,
                text: 'world',
            } as any,
        ]);

        expect(vtt.startsWith('WEBVTT')).toBe(true);
        expect(vtt).toContain('00:00:00.000 --> 00:00:01.000');
        expect(vtt).toContain('<00:00:00.000>he');
        expect(vtt).toContain('world');
    });

    it('builds safe transcript file names', () => {
        expect(buildTranscriptFileName('a:b/c*name', 'openai/whisper-small', 'en', 'lrc'))
            .toBe('a_b_c_name.en.whisper-small.lrc');
        expect(buildTranscriptFileName(undefined, undefined, 'ja', 'vtt'))
            .toBe('transcript.ja.whisper.vtt');
    });
});

