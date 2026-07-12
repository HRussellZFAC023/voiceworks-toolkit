import { describe, it, expect, vi } from 'vitest';

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
    SharedCache: {
        get: vi.fn().mockReturnValue(null),
        set: vi.fn(),
        getMemory: vi.fn().mockReturnValue(null),
        setMemory: vi.fn(),
        delete: vi.fn(),
    },
    CacheKeys: { translation: (t: string, l: string, s: string) => `${s}:${l}:${t}` },
}));
import { _testExports } from '../../src/services/TranslationService';
import { correctWhisperText } from '../../src/data/nsfw-glossary';
const { normalizeForModel, isLikelyGarbage, isLikelyUntranslated, extractCustomTranslation, glossaryPreProcess } = _testExports;

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
        expect(processed).toContain('track 2');  // space-padded to avoid "track2" concatenation
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
// glossaryPreProcess on real DLsite title segment
// ============================================================================
describe('glossaryPreProcess on DLsite title', () => {
    const segment = '男嫌いのダウナー高身長美人行商人を常識改変催眠で性処理を義務と思わせ嗅ぎ舐め交尾可の生オナホへ';

    it('substitutes key terms in long title segment', () => {
        const [result, modified] = glossaryPreProcess(segment, 'en');
        expect(modified).toBe(true);
        // Verify key domain terms get substituted
        expect(result).toContain('man-hater');         // 男嫌い
        expect(result).toContain('downer');             // ダウナー
        expect(result).toContain('tall');               // 高身長
        expect(result).toContain('beautiful woman');    // 美人
        expect(result).toContain('merchant');           // 行商人
        expect(result).toContain('common sense alteration'); // 常識改変
        expect(result).toContain('hypnosis');           // 催眠
        expect(result).toContain('sexual service');     // 性処理
        expect(result).toContain('duty');               // 義務
        expect(result).toContain('mating');             // 交尾
        expect(result).toContain('onahole');            // オナホ
    });

    it('substitutes in bracket-split segments too', () => {
        const [r1] = glossaryPreProcess('常識改変特化', 'en');
        expect(r1).toContain('common sense alteration');
        expect(r1).toContain('specialized');

        const [r2] = glossaryPreProcess('おまけトラック"のみ"オホ声', 'en');
        expect(r2).toContain('bonus');
        expect(r2).toContain('track');
        expect(r2).toContain('ahegao voice');
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

    it('rejects repeated punctuation (same character 4+)', () => {
        expect(isLikelyGarbage('テスト', 'What!!!!!')).toBe(true);
        expect(isLikelyGarbage('テスト', 'Huh????')).toBe(true);
        expect(isLikelyGarbage('テスト', 'Wait.......')).toBe(true);
    });

    it('allows mixed punctuation like ...! and ...? (common in JA→EN)', () => {
        expect(isLikelyGarbage('大好き…!そして', 'I love it...! And then')).toBe(false);
        expect(isLikelyGarbage('本当…?', 'Really...?')).toBe(false);
        expect(isLikelyGarbage('何…!?', 'What...!?')).toBe(false);
    });

    it('rejects repeated words (4+)', () => {
        expect(isLikelyGarbage('テスト', 'the the the the thing')).toBe(true);
    });
    it('rejects repeated character runs', () => {
        expect(isLikelyGarbage('カード', 'Cardssssssssssssssssss')).toBe(true);
    });

    it('rejects repeated n-gram loops', () => {
        expect(isLikelyGarbage(
            'サンプル',
            'without voices recording audio without voices recording audio without voices recording audio',
        )).toBe(true);
    });
    it('detects first-person hallucination from non-first-person input', () => {
        expect(isLikelyGarbage(
            '【耳かき・踏み踏み】あやかし郷愁譚 ～あかしゃぐま すみ～【蒸しタオル】',
            "I'm sorry, but I don't want to be a burden.",
        )).toBe(true);
    });

    it('detects VA name hallucinations', () => {
        expect(isLikelyGarbage('陽向葵ゆか', "I'm sorry., but you don't have to be a fan of this.")).toBe(true);
        expect(isLikelyGarbage('秋野かえで', "I'm not a doctor., but you know.")).toBe(true);
    });

    it('allows first-person output when input has first-person pronouns', () => {
        expect(isLikelyGarbage('私は好きです', 'I like it.')).toBe(false);
        expect(isLikelyGarbage('僕の耳かき', "I'm cleaning my ears.")).toBe(false);
        expect(isLikelyGarbage('我喜欢掏耳朵', 'I like ear cleaning.')).toBe(false);
        expect(isLikelyGarbage('我们喜欢耳语', 'We like whispering.')).toBe(false);
    });

    it('allows first-person output for long zero-pronoun Japanese sentences', () => {
        // Japanese commonly drops the subject pronoun — long sentences with implied
        // first person should not be flagged as hallucinations
        expect(isLikelyGarbage(
            '大人赤ちゃんのための保育園「甘園房」のシリーズ初めての作品から真面目に利用している大ファンなので、再来園verのレビューであります',
            "I'm a big fan who has been seriously using this since the first work in the nursery series for adult babies.",
        )).toBe(false);
    });
});

describe('custom translation response handling', () => {
    it('extracts OpenAI-compatible and simple translation responses', () => {
        expect(extractCustomTranslation({ choices: [{ message: { content: 'Hello' } }] })).toBe('Hello');
        expect(extractCustomTranslation({ translatedText: '你好' })).toBe('你好');
    });

    it('detects source echoes only when source and target languages differ', () => {
        expect(isLikelyUntranslated('今日は雨です。', '今日は雨です', 'en')).toBe(true);
        expect(isLikelyUntranslated('今日は雨です。', '今日は雨です — It is raining today.', 'en')).toBe(true);
        expect(isLikelyUntranslated('今日は雨です。', '今日は雨ですけど', 'en')).toBe(true);
        expect(isLikelyUntranslated('今日は雨です。', 'It is raining today.', 'en')).toBe(false);
        expect(isLikelyUntranslated('今日は雨です。', 'きょうは雨です。', 'zh-CN')).toBe(true);
        expect(isLikelyUntranslated('今日は雨です。', '今天下雨。', 'zh-CN')).toBe(false);
        expect(isLikelyUntranslated('中文', '中文', 'zh')).toBe(false);
    });
});

// ============================================================================
// Whisper correction preprocessing
// ============================================================================
describe('correctWhisperText', () => {
    it('fixes known NSFW mishearing 尋抱 -> ちんぽ', () => {
        expect(correctWhisperText('尋抱して')).toBe('ちんぽして');
    });

    it.each([
        ['写生したい', '射精したい'],
        ['お寿司が好き', 'おちんぽが好き'],
        ['寿司って言うな', 'ちんぽって言うな'],
        ['Sushiって言うな', 'ちんぽって言うな'],
        ['Snack じゃない', 'ちんぽ じゃない'],
        ['同程です', '童貞です'],
        ['同定です', '童貞です'],
        ['virginじゃない', '童貞じゃない'],
        ['doteiじゃない', '童貞じゃない'],
    ])('applies whisper correction %s -> %s', (input, expected) => {
        expect(correctWhisperText(input)).toBe(expected);
    });

    it('does not strip plain English words unless explicitly corrected', () => {
        expect(correctWhisperText('archipelago')).toBe('archipelago');
        expect(correctWhisperText('algorithm')).toBe('algorithm');
    });
});
