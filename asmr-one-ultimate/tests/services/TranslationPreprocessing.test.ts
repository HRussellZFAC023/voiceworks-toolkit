import { describe, it, expect, vi, beforeAll } from 'vitest';

// Mock dependencies before importing
vi.mock('../../src/core/Config', () => ({
    Config: { get: vi.fn().mockReturnValue(true) },
    I18n: { lang: 'en', t: (k: string) => k, format: (k: string) => k },
}));
vi.mock('../../src/core/EventBus', () => ({
    EventBus: { on: vi.fn().mockReturnValue(() => {}), off: vi.fn(), emit: vi.fn() },
}));
vi.mock('../../src/core/Logger', () => ({
    Logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/core/Cache', () => ({
    SharedCache: { get: vi.fn().mockReturnValue(null), set: vi.fn(), delete: vi.fn() },
    CacheKeys: { translation: (t: string, l: string, s: string) => `${s}:${l}:${t}`, translationPreferredDtype: () => 'dtype' },
}));
vi.mock('../../src/core/DeviceCapabilities', () => ({
    DeviceCapabilities: { budget: { translationIdleMs: 900000 } },
}));
vi.mock('../../src/core/GpuScheduler', () => ({
    GpuScheduler: { enqueue: vi.fn() },
    Priority: { REALTIME: 0, HIGH: 1, NORMAL: 2, LOW: 3 },
}));

import { _testExports } from '../../src/services/TranslationService';
const { normalizeForModel, splitForModel, isLikelyGarbage, glossaryPreProcess } = _testExports;

// ============================================================================
// normalizeForModel
// ============================================================================
describe('normalizeForModel', () => {
    it('passes plain Japanese text through unchanged', () => {
        expect(normalizeForModel('耳舐め')).toBe('耳舐め');
    });

    it('passes plain English text through unchanged', () => {
        expect(normalizeForModel('hello world')).toBe('hello world');
    });

    it('converts 「」 to double quotes', () => {
        expect(normalizeForModel('「こんにちは」')).toBe('"こんにちは"');
    });

    it('converts 『』 to double quotes', () => {
        expect(normalizeForModel('『テスト』')).toBe('"テスト"');
    });

    it('strips 〜 wave dash (causes hallucinations)', () => {
        // 〜 between ださ and い collapses: ださ〜い〜 → ださい (not ださいい)
        expect(normalizeForModel('来てくださ〜い〜')).toBe('来てください');
    });

    it('strips ～ fullwidth tilde', () => {
        expect(normalizeForModel('～甘くとろける～')).toBe('甘くとろける');
    });

    it('converts … to ...', () => {
        expect(normalizeForModel('あの…')).toBe('あの...');
    });

    it('converts × to comma-space separator', () => {
        expect(normalizeForModel('純愛×催眠')).toBe('純愛, 催眠');
    });

    it('converts ・ (middle dot) to comma-space separator', () => {
        expect(normalizeForModel('耳かき・踏み踏み')).toBe('耳かき, 踏み踏み');
    });

    it('strips decorative characters ♡♥♪♫★☆', () => {
        expect(normalizeForModel('エッチ♡大好き♪')).toBe('エッチ大好き');
        expect(normalizeForModel('★スペシャル☆')).toBe('スペシャル');
        expect(normalizeForModel('♥♫テスト')).toBe('テスト');
    });

    it('strips emoji ✨💕🌙 and other Unicode decorations', () => {
        expect(normalizeForModel('✨癒し✨')).toBe('癒し');
        expect(normalizeForModel('甘々💕エッチ🌙')).toBe('甘々エッチ');
        expect(normalizeForModel('💖💗💓テスト💘')).toBe('テスト');
    });

    it('collapses multiple spaces', () => {
        expect(normalizeForModel('hello   world')).toBe('hello world');
    });

    it('trims whitespace', () => {
        expect(normalizeForModel('  hello  ')).toBe('hello');
    });

    it('handles complex DLsite title', () => {
        const input = '「純愛×催眠」～甘々エッチ♡～';
        const result = normalizeForModel(input);
        // 「→", 」→", ～ stripped, × → ", ", ♡ stripped — no space inserted between " and 甘
        expect(result).toBe('"純愛, 催眠"甘々エッチ');
    });

    it('handles real card title with wave dash and decorative chars', () => {
        const input = '洗脳アプリをくれたJKと、洗脳ベロチューあまあまエッチ。～ダウナー×催眠×純愛H♡一途な添い寝';
        const result = normalizeForModel(input);
        // 〜 stripped, × → ", ", ♡ stripped — no space between H and 一途 (♡ removed in-place)
        expect(result).toBe('洗脳アプリをくれたJKと、洗脳ベロチューあまあまエッチ。ダウナー, 催眠, 純愛H一途な添い寝');
    });

    it('preserves 【】 brackets (let model handle them)', () => {
        expect(normalizeForModel('【催眠】エッチ')).toBe('【催眠】エッチ');
    });

    it('preserves multi-bracket text', () => {
        const input = '【お下品オナ鳴き】オナサポ♡【ロリオナ育成ASMR】';
        // ♡ stripped, but brackets preserved
        expect(normalizeForModel(input)).toBe('【お下品オナ鳴き】オナサポ【ロリオナ育成ASMR】');
    });

    it('preserves 。 period', () => {
        expect(normalizeForModel('文A。文B')).toBe('文A。文B');
    });
});

// ============================================================================
// glossaryPreProcess
// ============================================================================
describe('glossaryPreProcess', () => {
    it('replaces トラック in mixed short track titles', () => {
        const [processed, modified] = glossaryPreProcess('トラック2ヘッドマッサージ・手足湯.mp3', 'en');
        expect(modified).toBe(true);
        expect(processed).toContain('track2');
        expect(processed).not.toContain('トラック');
    });

    it('keeps non-glossary text unchanged', () => {
        const input = '静かな雨音ASMR';
        const [processed, modified] = glossaryPreProcess(input, 'en');
        expect(modified).toBe(false);
        expect(processed).toBe(input);
    });
});

// ============================================================================
// splitForModel
// ============================================================================
describe('splitForModel', () => {
    it('returns null for single sentence', () => {
        expect(splitForModel('耳舐め')).toBeNull();
    });

    it('returns null for trailing 。 with no following sentence', () => {
        expect(splitForModel('音声作品。')).toBeNull();
    });

    it('splits on 。 between two sentences', () => {
        expect(splitForModel('音声作品。収録:KU100')).toEqual(['音声作品', '収録:KU100']);
    });

    it('splits multiple sentence boundaries and drops empties', () => {
        expect(splitForModel('文A。文B。文C。')).toEqual(['文A', '文B', '文C']);
    });

    it('preserves bracketed segments within each split sentence', () => {
        expect(splitForModel('【催眠】エッチ。【添い寝】癒し')).toEqual(['【催眠】エッチ', '【添い寝】癒し']);
    });
});

// ============================================================================
// isLikelyGarbage (hallucination detection)
// ============================================================================
describe('isLikelyGarbage', () => {
    it('accepts valid translation', () => {
        expect(isLikelyGarbage('耳舐め', 'Ear licking')).toBe(false);
    });

    it('rejects empty output', () => {
        expect(isLikelyGarbage('耳舐め', '')).toBe(true);
        expect(isLikelyGarbage('耳舐め', '   ')).toBe(true);
    });

    it('rejects excessive length', () => {
        const long = 'word '.repeat(200);
        expect(isLikelyGarbage('短い', long)).toBe(true);
    });

    it('rejects repeated punctuation', () => {
        expect(isLikelyGarbage('テスト', 'What!!!!!')).toBe(true);
    });

    it('rejects repeated words (4+)', () => {
        expect(isLikelyGarbage('テスト', 'the the the the thing')).toBe(true);
    });

    it('detects first-person hallucination from non-first-person input', () => {
        // The exact hallucination from the screenshot
        expect(isLikelyGarbage(
            '【耳かき・踏み踏み】あやかし郷愁譚 ～あかしゃぐま すみ～【蒸しタオル】',
            "I'm sorry, but I don't want to be a burden.",
        )).toBe(true);
    });

    it('detects other first-person hallucination patterns', () => {
        expect(isLikelyGarbage('催眠音声', "I don't know what to do.")).toBe(true);
        expect(isLikelyGarbage('添い寝', "I can't believe it.")).toBe(true);
        expect(isLikelyGarbage('耳舐め', "I have a dream.")).toBe(true);
        expect(isLikelyGarbage('癒し系', "I want to go home.")).toBe(true);
    });

    it('allows first-person output when input has first-person pronouns', () => {
        expect(isLikelyGarbage('私は好きです', 'I like it.')).toBe(false);
        expect(isLikelyGarbage('僕の耳かき', "I'm cleaning my ears.")).toBe(false);
        expect(isLikelyGarbage('俺のターン', "I don't care."  )).toBe(false);
    });
});
