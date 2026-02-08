import { describe, it, expect } from 'vitest';
import { buildSegments, sliceSegments, segmentsToHtml } from '../../src/lib/jpdb-segments';
import type { JPDBToken, JPDBCard } from '../../src/types/jpdb';
import { JPDBCardState } from '../../src/types/jpdb';

// ============================================================================
// Helpers
// ============================================================================

function makeCard(overrides: Partial<JPDBCard> = {}): JPDBCard {
    return {
        vid: 1,
        sid: 1,
        rid: 1,
        spelling: '漢字',
        reading: 'かんじ',
        frequencyRank: 100,
        partOfSpeech: ['noun'],
        meanings: [{ glosses: ['kanji'], partOfSpeech: ['noun'] }],
        cardState: [JPDBCardState.NEW],
        pitchAccent: [],
        wordWithReading: null,
        ...overrides,
    };
}

function makeToken(overrides: Partial<JPDBToken> & Pick<JPDBToken, 'start' | 'end' | 'length'>): JPDBToken {
    return {
        card: makeCard(),
        rubies: [],
        pitchClass: '',
        ...overrides,
    };
}

// ============================================================================
// buildSegments
// ============================================================================

describe('buildSegments', () => {
    it('returns empty for empty inputs', () => {
        expect(buildSegments('', [])).toEqual([]);
        expect(buildSegments('hello', [])).toEqual([]);
    });

    it('creates plain segment for token without rubies', () => {
        // "食べる" — token covers entire text, no furigana
        const text = '食べる';
        const token = makeToken({
            start: 0, end: 3, length: 3,
            card: makeCard({ spelling: '食べる', reading: 'たべる', vid: 10, sid: 20 }),
            rubies: [],
            pitchClass: 'nakadaka',
        });

        const segments = buildSegments(text, [token]);
        expect(segments).toHaveLength(1);
        expect(segments[0].base).toBe('食べる');
        expect(segments[0].rt).toBeUndefined();
        expect(segments[0].vid).toBe(10);
        expect(segments[0].sid).toBe(20);
        expect(segments[0].pitchClass).toBe('nakadaka');
        expect(segments[0].charStart).toBe(0);
        expect(segments[0].charEnd).toBe(3);
    });

    it('creates ruby segment for token with furigana', () => {
        // "漢字" with furigana "かんじ" over both kanji
        const text = '漢字';
        const token = makeToken({
            start: 0, end: 2, length: 2,
            card: makeCard({ spelling: '漢字', reading: 'かんじ' }),
            rubies: [{ text: 'かんじ', start: 0, end: 2, length: 2 }],
        });

        const segments = buildSegments(text, [token]);
        expect(segments).toHaveLength(1);
        expect(segments[0].base).toBe('漢字');
        expect(segments[0].rt).toBe('かんじ');
        expect(segments[0].charStart).toBe(0);
        expect(segments[0].charEnd).toBe(2);
    });

    it('handles gap text before first token', () => {
        // "あの漢字" — "あの" is a gap, "漢字" is the token
        const text = 'あの漢字';
        const token = makeToken({
            start: 2, end: 4, length: 2,
            card: makeCard({ spelling: '漢字', reading: 'かんじ' }),
            rubies: [{ text: 'かんじ', start: 2, end: 4, length: 2 }],
        });

        const segments = buildSegments(text, [token]);
        expect(segments).toHaveLength(2);
        expect(segments[0].base).toBe('あの');
        expect(segments[0].rt).toBeUndefined();
        expect(segments[0].vid).toBeUndefined();
        expect(segments[1].base).toBe('漢字');
        expect(segments[1].rt).toBe('かんじ');
    });

    it('handles trailing text after last token', () => {
        const text = '漢字です';
        const token = makeToken({
            start: 0, end: 2, length: 2,
            card: makeCard({ spelling: '漢字' }),
            rubies: [{ text: 'かんじ', start: 0, end: 2, length: 2 }],
        });

        const segments = buildSegments(text, [token]);
        expect(segments).toHaveLength(2);
        expect(segments[0].base).toBe('漢字');
        expect(segments[0].rt).toBe('かんじ');
        expect(segments[1].base).toBe('です');
        expect(segments[1].vid).toBeUndefined();
    });

    it('handles mixed kanji+kana token (e.g. 食べる)', () => {
        // "食べる" — ruby only on "食" (the kanji), "べる" is kana
        const text = '食べる';
        const card = makeCard({ spelling: '食べる', reading: 'たべる', vid: 5, sid: 5 });
        const token = makeToken({
            start: 0, end: 3, length: 3,
            card,
            rubies: [{ text: 'た', start: 0, end: 1, length: 1 }],
            pitchClass: 'nakadaka',
        });

        const segments = buildSegments(text, [token]);
        // Should produce: [ruby: 食(た), plain: べる]
        expect(segments).toHaveLength(2);
        expect(segments[0].base).toBe('食');
        expect(segments[0].rt).toBe('た');
        expect(segments[0].vid).toBe(5);
        expect(segments[1].base).toBe('べる');
        expect(segments[1].rt).toBeUndefined();
        expect(segments[1].vid).toBe(5); // Still part of same word
    });

    it('handles multiple tokens in sequence', () => {
        // "日本語" — two tokens: "日本"(にほん) and "語"(ご)
        const text = '日本語';
        const card1 = makeCard({ spelling: '日本', reading: 'にほん', vid: 1, sid: 1 });
        const card2 = makeCard({ spelling: '語', reading: 'ご', vid: 2, sid: 2 });
        const tokens: JPDBToken[] = [
            makeToken({
                start: 0, end: 2, length: 2, card: card1,
                rubies: [{ text: 'にほん', start: 0, end: 2, length: 2 }],
            }),
            makeToken({
                start: 2, end: 3, length: 1, card: card2,
                rubies: [{ text: 'ご', start: 2, end: 3, length: 1 }],
            }),
        ];

        const segments = buildSegments(text, tokens);
        expect(segments).toHaveLength(2);
        expect(segments[0].base).toBe('日本');
        expect(segments[0].rt).toBe('にほん');
        expect(segments[0].vid).toBe(1);
        expect(segments[1].base).toBe('語');
        expect(segments[1].rt).toBe('ご');
        expect(segments[1].vid).toBe(2);
    });

    it('assigns card state class', () => {
        const text = '漢字';
        const token = makeToken({
            start: 0, end: 2, length: 2,
            card: makeCard({ cardState: [JPDBCardState.LEARNING] }),
            rubies: [],
        });

        const segments = buildSegments(text, [token]);
        expect(segments[0].stateClass).toBe('jpdb-learning');
    });
});

// ============================================================================
// sliceSegments
// ============================================================================

describe('sliceSegments', () => {
    const segments = [
        { base: 'あの', charStart: 0, charEnd: 2 },
        { base: '漢字', rt: 'かんじ', vid: 1, sid: 1, charStart: 2, charEnd: 4 },
        { base: 'です', charStart: 4, charEnd: 6 },
    ];

    it('returns empty for null input', () => {
        expect(sliceSegments(null, 0, 5)).toEqual([]);
    });

    it('returns empty when from >= to', () => {
        expect(sliceSegments(segments, 3, 3)).toEqual([]);
        expect(sliceSegments(segments, 5, 3)).toEqual([]);
    });

    it('returns full segments within range', () => {
        const result = sliceSegments(segments, 2, 4);
        expect(result).toHaveLength(1);
        expect(result[0].base).toBe('漢字');
        expect(result[0].rt).toBe('かんじ');
    });

    it('returns all segments for full range', () => {
        const result = sliceSegments(segments, 0, 6);
        expect(result).toHaveLength(3);
    });

    it('clips segment at start boundary', () => {
        // Slice from char 1 to 6 — should clip "あの" to "の"
        const result = sliceSegments(segments, 1, 6);
        expect(result).toHaveLength(3);
        expect(result[0].base).toBe('の');
        expect(result[0].charStart).toBe(1);
        expect(result[0].charEnd).toBe(2);
    });

    it('clips segment at end boundary', () => {
        // Slice from 0 to 5 — should clip "です" to "で"
        const result = sliceSegments(segments, 0, 5);
        expect(result).toHaveLength(3);
        expect(result[2].base).toBe('で');
        expect(result[2].charStart).toBe(4);
        expect(result[2].charEnd).toBe(5);
    });

    it('splits ruby segment mid-character', () => {
        // Slice from 0 to 3 — clips "漢字" to "漢"
        const result = sliceSegments(segments, 0, 3);
        expect(result).toHaveLength(2);
        expect(result[0].base).toBe('あの');
        expect(result[1].base).toBe('漢');
        expect(result[1].rt).toBe('かんじ'); // rt kept since clipStart === 0
    });

    it('removes ruby when clipping from middle of ruby group', () => {
        // Slice from 3 to 6 — clips "漢字" to "字" (second half)
        const result = sliceSegments(segments, 3, 6);
        expect(result).toHaveLength(2);
        expect(result[0].base).toBe('字');
        expect(result[0].rt).toBeUndefined(); // rt removed — not the start of ruby group
        expect(result[1].base).toBe('です');
    });
});

// ============================================================================
// segmentsToHtml
// ============================================================================

describe('segmentsToHtml', () => {
    it('renders plain segment as escaped text', () => {
        const html = segmentsToHtml([
            { base: 'hello', charStart: 0, charEnd: 5 },
        ]);
        expect(html).toBe('hello');
    });

    it('renders segment with vid as jpdb-word span', () => {
        const html = segmentsToHtml([
            { base: 'abc', vid: 1, sid: 2, charStart: 0, charEnd: 3 },
        ]);
        expect(html).toContain('class="jpdb-word"');
        expect(html).toContain('data-vid="1"');
        expect(html).toContain('data-sid="2"');
        expect(html).toContain('data-jpdb="true"');
        expect(html).toContain('abc');
    });

    it('renders ruby segment with rt', () => {
        const html = segmentsToHtml([
            { base: '漢字', rt: 'かんじ', vid: 1, sid: 1, charStart: 0, charEnd: 2 },
        ]);
        expect(html).toContain('<ruby>漢字<rt class="jpdb-furi">かんじ</rt></ruby>');
        expect(html).toContain('data-vid="1"');
    });

    it('includes pitch and state classes', () => {
        const html = segmentsToHtml([
            { base: '漢字', vid: 1, sid: 1, pitchClass: 'heiban', stateClass: 'jpdb-new', charStart: 0, charEnd: 2 },
        ]);
        expect(html).toContain('jpdb-word');
        expect(html).toContain('jpdb-new');
        expect(html).toContain('heiban');
    });

    it('escapes HTML entities in base text', () => {
        const html = segmentsToHtml([
            { base: '<b>bold</b>', charStart: 0, charEnd: 11 },
        ]);
        expect(html).toBe('&lt;b&gt;bold&lt;/b&gt;');
        expect(html).not.toContain('<b>');
    });
});
