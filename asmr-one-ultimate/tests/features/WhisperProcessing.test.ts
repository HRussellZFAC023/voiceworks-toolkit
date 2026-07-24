import { describe, expect, it } from 'vitest';
import {
    cleanHallucinatedChunks,
    isWhisperHallucinationText,
    processRawChunks,
    sanitizeWhisperText,
} from '../../src/features/whisperProcessing';

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
