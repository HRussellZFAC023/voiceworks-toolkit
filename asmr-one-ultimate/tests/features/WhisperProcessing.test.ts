import { describe, expect, it } from 'vitest';
import {
    capRollingTranscriptRepetition,
    capPathologicalTextRepetition,
    cleanHallucinatedChunks,
    isWhisperHallucinationText,
    processRawChunks,
    restoreRollingTranscriptRepetitionRuns,
    sanitizeWhisperText,
    serializeRollingTranscriptRepetitionRuns,
} from '../../src/features/whisperProcessing';

describe('whisperProcessing pathological repetition cap', () => {
    it('preserves short repeated ASMR vocalisations', () => {
        expect(capPathologicalTextRepetition('う'.repeat(11))).toBe('う'.repeat(11));
        expect(capPathologicalTextRepetition('あっ'.repeat(6))).toBe('あっ'.repeat(6));
        expect(capPathologicalTextRepetition('うううう、気持ちいい')).toBe('うううう、気持ちいい');
    });

    it('caps long tiny-pattern runs and retains distinct following speech', () => {
        expect(capPathologicalTextRepetition(`${'う'.repeat(80)}大丈夫？`))
            .toBe(`${'う'.repeat(6)}…大丈夫？`);
        expect(capPathologicalTextRepetition(`${'あっ'.repeat(20)}もうだめ`))
            .toBe(`${'あっ'.repeat(6)}…もうだめ`);
    });

    it('caps repetition inside segment text without changing its timestamps', () => {
        expect(processRawChunks([{
            text: `${'う'.repeat(80)}大丈夫？`,
            timestamp: [12.5, 42.75],
        }], undefined, 'segment')).toEqual([{
            text: `${'う'.repeat(6)}…大丈夫？`,
            timestamp: [12.5, 42.75],
        }]);
    });

    it('samples both ends of repeated segment runs and keeps later distinct segments', () => {
        const repeated = Array.from({ length: 20 }, (_, index) => ({
            text: 'う',
            timestamp: [index, index + 1] as [number, number],
        }));
        const processed = processRawChunks([
            ...repeated,
            { text: '大丈夫？', timestamp: [20, 22] },
        ], undefined, 'segment');

        expect(processed).toEqual([
            { text: 'う', timestamp: [0, 1] },
            { text: 'う', timestamp: [1, 2] },
            { text: 'う', timestamp: [2, 3] },
            { text: 'う', timestamp: [17, 18] },
            { text: 'う', timestamp: [18, 19] },
            { text: 'う', timestamp: [19, 20] },
            { text: '大丈夫？', timestamp: [20, 22] },
        ]);
    });

    it('preserves the temporal bounds and following text for word-timestamp runs', () => {
        const repeated = Array.from({ length: 20 }, (_, index) => ({
            text: 'う',
            timestamp: [index, index + 1] as [number, number],
        }));
        const processed = processRawChunks([
            ...repeated,
            { text: '大丈夫？', timestamp: [20, 22] },
        ], undefined, 'word');

        expect(processed[0]).toMatchObject({
            text: 'ううう',
            timestamp: [0, 3],
        });
        expect(processed.at(-1)).toMatchObject({
            text: 'ううう大丈夫？',
            timestamp: [17, 22],
        });
        expect(processed.flatMap(segment => segment.words || []).map(word => word.text)).toEqual([
            'う', 'う', 'う', 'う', 'う', 'う', '大丈夫？',
        ]);
    });

    it('caps one rolling loop split across disjoint worker windows', () => {
        const firstWindow = Array.from({ length: 7 }, (_, index) => ({
            text: 'う',
            start: index * 8,
            end: index * 8 + 1,
        }));
        const secondWindow = Array.from({ length: 7 }, (_, index) => ({
            text: 'う',
            start: (index + 7) * 8,
            end: (index + 7) * 8 + 1,
        }));

        const capped = capRollingTranscriptRepetition([
            ...firstWindow,
            ...secondWindow,
        ]);

        expect(capped).toEqual([
            ...firstWindow.slice(0, 3),
            ...secondWindow.slice(-3),
        ]);
        expect(capped[0].start).toBe(0);
        expect(capped.at(-1)?.end).toBe(105);
    });

    it('stays bounded across one hundred cumulative worker merges', () => {
        let capped: Array<{ text: string; start: number; end: number }> = [];
        for (let index = 0; index < 100; index++) {
            capped = capRollingTranscriptRepetition([
                ...capped,
                {
                    text: 'う',
                    start: index * 8,
                    end: index * 8 + 1,
                },
            ]);
        }

        expect(capped).toHaveLength(6);
        expect(capped.map(segment => segment.start)).toEqual([
            0, 8, 16, 776, 784, 792,
        ]);
    });

    it('stays bounded after cache serialization removes symbol metadata', () => {
        const observed = Array.from({ length: 20 }, (_, index) => ({
            text: 'う',
            start: index * 8,
            end: index * 8 + 1,
        }));
        const capped = capRollingTranscriptRepetition(observed);
        const serialized = JSON.parse(JSON.stringify({
            segments: capped,
            runs: serializeRollingTranscriptRepetitionRuns(capped),
        }));
        let restored = restoreRollingTranscriptRepetitionRuns(
            serialized.segments,
            serialized.runs,
        );

        for (let index = 20; index < 60; index++) {
            restored = capRollingTranscriptRepetition([
                ...restored,
                {
                    text: 'う',
                    start: index * 8,
                    end: index * 8 + 1,
                },
            ]);
        }

        expect(restored).toHaveLength(6);
        expect(restored.map(segment => segment.start)).toEqual([
            0, 8, 16, 456, 464, 472,
        ]);
    });

    it('ignores malformed cache metadata for a legitimate short repetition', () => {
        const legitimate = Array.from({ length: 6 }, (_, index) => ({
            text: 'あっ',
            start: index,
            end: index + 0.5,
        }));
        const restored = restoreRollingTranscriptRepetitionRuns(legitimate, [{
            fingerprint: 'あっ',
            runStart: 0,
            observedCount: 11,
            retainedStarts: legitimate.map(segment => segment.start),
        }]);

        expect(capRollingTranscriptRepetition([
            ...restored,
            { text: 'あっ', start: 6, end: 6.5 },
        ])).toHaveLength(7);
    });

    it.each([
        'よしよし',
        '大丈夫だよ',
        'これは本当に大丈夫ですか？',
    ])('does not cap the repeated ASMR phrase %s', (phrase) => {
        const repeated = Array.from({ length: 20 }, (_, index) => ({
            text: phrase,
            start: index * 8,
            end: index * 8 + 2,
        }));

        expect(capRollingTranscriptRepetition(repeated)).toEqual(repeated);
    });

    it('does not join shorter or temporally-separated ASMR repetitions', () => {
        const shortRun = Array.from({ length: 11 }, (_, index) => ({
            text: 'あっ',
            start: index,
            end: index + 0.5,
        }));
        const separated = [
            ...Array.from({ length: 6 }, (_, index) => ({
                text: 'う',
                start: index,
                end: index + 0.5,
            })),
            ...Array.from({ length: 6 }, (_, index) => ({
                text: 'う',
                start: index + 60,
                end: index + 60.5,
            })),
        ];

        expect(capRollingTranscriptRepetition(shortRun)).toEqual(shortRun);
        expect(capRollingTranscriptRepetition(separated)).toEqual(separated);
    });
});

describe('whisperProcessing decoder control tokens', () => {
    it('removes complete Whisper timestamp/control tokens without changing ordinary decimals', () => {
        expect(sanitizeWhisperText('<|0.00|>ちょっとだけ<|2.00|>')).toBe('ちょっとだけ');
        expect(sanitizeWhisperText('<|ja|><|transcribe|>お邪魔します<|endoftext|>')).toBe('お邪魔します');
        expect(sanitizeWhisperText('価格は0.00です')).toBe('価格は0.00です');
    });

    it('removes leading callback fragments and trailing incomplete control tokens', () => {
        expect(sanitizeWhisperText('00|>ちょっとだけ')).toBe('ちょっとだけ');
        expect(sanitizeWhisperText('|>ちょっとだけ')).toBe('ちょっとだけ');
        expect(sanitizeWhisperText('<|0.00')).toBe('');
    });

    it('sanitizes segment chunks and a full-text-only fallback', () => {
        expect(processRawChunks([
            { text: '<|0.00|>お邪魔します<|2.00|>', timestamp: [0, 2] },
        ], '<|0.00|>お邪魔します<|2.00|>')).toEqual([
            { text: 'お邪魔します', timestamp: [0, 2] },
        ]);

        expect(processRawChunks([], '<|0.00|>聞こえています<|2.00|>')).toEqual([]);
    });

    it('uses explicit timestamp granularity instead of a duration heuristic', () => {
        const shortChunks = [
            { text: 'お', timestamp: [0, 0.2] as [number, number] },
            { text: 'は', timestamp: [0.2, 0.4] as [number, number] },
            { text: 'よ', timestamp: [0.4, 0.6] as [number, number] },
        ];

        expect(processRawChunks(shortChunks, 'おはよ', 'segment')).toEqual([
            { text: 'お', timestamp: [0, 0.2] },
            { text: 'は', timestamp: [0.2, 0.4] },
            { text: 'よ', timestamp: [0.4, 0.6] },
        ]);
        expect(processRawChunks(shortChunks, 'おはよ', 'word')).toEqual([{
            text: 'おはよ',
            timestamp: [0, 0.6],
            words: [
                { text: 'お', start: 0, end: 0.2 },
                { text: 'は', start: 0.2, end: 0.4 },
                { text: 'よ', start: 0.4, end: 0.6 },
            ],
        }]);
    });
});

describe('whisperProcessing Chinese filtering', () => {
    it('drops Simplified and Traditional Chinese non-speech annotations', () => {
        const cleaned = cleanHallucinatedChunks([
            { text: '[音乐]' },
            { text: '[笑聲]' },
            { text: '正常对白' },
        ]);
        expect(cleaned).toEqual([{ text: '正常对白' }]);
    });

    it('drops common Chinese subtitle-training hallucinations', () => {
        const cleaned = cleanHallucinatedChunks([
            { text: '谢谢观看！' },
            { text: '請訂閱。' },
            { text: '真实语音内容' },
        ]);
        expect(cleaned).toEqual([{ text: '真实语音内容' }]);
    });
});

describe('whisperProcessing Japanese subtitle hallucinations', () => {
    it('uses one anchored predicate for the observed Firefox silence output', () => {
        expect(isWhisperHallucinationText('ご視聴ありがとうございました')).toBe(true);
        expect(isWhisperHallucinationText('最後までご視聴ありがとうございました。また明日ね')).toBe(false);
    });

    it('drops the past-tense viewing-thanks hallucination from split raw chunks and full text', () => {
        const processed = processRawChunks([
            { text: 'ご視聴', timestamp: [0, 0.5] },
            { text: 'ありがとう', timestamp: [0.5, 1] },
            { text: 'ございました', timestamp: [1, 1.5] },
        ], 'ご視聴ありがとうございました');

        expect(processed).toEqual([]);
    });

    it('removes an isolated hallucination chunk without suppressing surrounding speech', () => {
        const processed = processRawChunks([
            { text: '今日は来てくれて嬉しいです', timestamp: [0, 2] },
            { text: 'ご視聴ありがとうございました。', timestamp: [2, 4] },
            { text: 'また明日ね', timestamp: [4, 6] },
        ], '今日は来てくれて嬉しいです。ご視聴ありがとうございました。また明日ね');

        expect(processed.map(segment => segment.text)).toEqual([
            '今日は来てくれて嬉しいです',
            'また明日ね',
        ]);
    });
});
