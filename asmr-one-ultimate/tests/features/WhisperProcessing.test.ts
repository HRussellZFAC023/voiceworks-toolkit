import { describe, expect, it } from 'vitest';
import { cleanHallucinatedChunks } from '../../src/features/whisperProcessing';

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
