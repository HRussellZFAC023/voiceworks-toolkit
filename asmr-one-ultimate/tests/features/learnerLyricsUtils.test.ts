import { describe, expect, it } from 'vitest';
import {
    findLyricsSource,
    getStoreLyricsSource,
    normalizeLyricLines,
    parseLrcContent,
    parseLyricsFromDom,
    parseSubtitleContent,
    parseVttContent,
} from '../../src/features/learnerLyricsUtils';

describe('learnerLyricsUtils', () => {
    describe('getStoreLyricsSource', () => {
        it('reads nested subtitle line arrays from AudioPlayer state', () => {
            const source = getStoreLyricsSource({
                subtitle: {
                    lines: [{ time: 1, text: 'line one' }],
                },
            });
            expect(source).toEqual([{ time: 1, text: 'line one' }]);
        });

        it('returns null when no lyric-like arrays exist', () => {
            const source = getStoreLyricsSource({ foo: [{ id: 1 }] });
            expect(source).toBeNull();
        });
    });

    describe('parseLyricsFromDom', () => {
        it('parses timestamped lyric rows from lyric-content panel', () => {
            document.body.innerHTML = `
                <div class="lyric-content">
                    <div class="q-item">
                        <div class="q-item__label">
                            <div class="q-item__label--caption">[00:12.34]</div>
                            Hello world
                        </div>
                    </div>
                </div>
            `;

            const parsed = parseLyricsFromDom(document);
            expect(parsed).toEqual([{ time: 12340, text: 'Hello world' }]);
        });
    });

    describe('findLyricsSource', () => {
        it('prefers store lyrics over DOM/Vue fallbacks', () => {
            document.body.innerHTML = `
                <div class="lyric-content">
                    <div class="q-item">
                        <div class="q-item__label">
                            <div class="q-item__label--caption">[00:00.10]</div>
                            fallback
                        </div>
                    </div>
                </div>
            `;

            const source = findLyricsSource({ lrcLines: [{ time: 2, text: 'from store' }] }, document);
            expect(source).toEqual([{ time: 2, text: 'from store' }]);
        });

        it('finds Vue instance lyric arrays when store is empty', () => {
            document.body.innerHTML = `<div id="lyric"></div>`;
            const host = document.querySelector('#lyric') as HTMLElement & { __vue__?: Record<string, unknown> };
            host.__vue__ = { lyrics: [{ time: 3, text: 'from vue' }] };

            const source = findLyricsSource({}, document);
            expect(source).toEqual([{ time: 3, text: 'from vue' }]);
        });
    });

    describe('subtitle parsing', () => {
        it('parses VTT cues with cue-number lines', () => {
            const content = [
                'WEBVTT',
                '',
                '1',
                '00:00:01.000 --> 00:00:03.000',
                'First line',
                '',
            ].join('\n');
            const parsed = parseVttContent(content);
            expect(parsed).toEqual([{ time: 1, endTime: 3, text: 'First line' }]);
        });

        it('parses LRC metadata, supports multi-timestamp lines, and sorts', () => {
            const content = [
                '[ti:Title]',
                '[00:05.00]Later',
                '[00:01.50][00:03.00]Early',
            ].join('\n');
            const parsed = parseLrcContent(content);
            expect(parsed).toEqual([
                { time: 1.5, text: 'Early' },
                { time: 3, text: 'Early' },
                { time: 5, text: 'Later' },
            ]);
        });

        it('parseSubtitleContent falls back to LRC when VTT is absent', () => {
            const parsed = parseSubtitleContent('[00:02.00]LRC line');
            expect(parsed).toEqual([{ time: 2, text: 'LRC line' }]);
        });
    });

    describe('normalizeLyricLines', () => {
        it('normalizes mixed seconds/milliseconds and end time aliases', () => {
            const normalized = normalizeLyricLines([
                { time: 1500, end: 2500, text: 'ms line' },
                { startTime: '3.2', endTime: '4.5', content: 's line' },
            ]);
            expect(normalized).toEqual([
                { time: 1.5, endTime: 2500, text: 'ms line' },
                { time: 3.2, endTime: 4.5, text: 's line' },
            ]);
        });
    });
});
