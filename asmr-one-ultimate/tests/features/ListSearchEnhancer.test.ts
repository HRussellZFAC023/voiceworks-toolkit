import { describe, expect, it, vi, beforeEach } from 'vitest';

// Since ListSearchEnhancer's logic is tightly coupled to KikoeruBridge/Vue,
// we test the core helper logic and data transformation patterns.

/** Mirrors the looksJapanese check in ListSearchEnhancer */
function looksJapanese(text: string): boolean {
    return /[\u3040-\u30ff\u4e00-\u9faf]/.test(text);
}

/** Mirrors the hasExistingRomanization check from TranslatedTags */
function hasExistingRomanization(text: string): boolean {
    return /\([A-Za-z][A-Za-z\s.,!?;:'"…-]*\)\s*$/.test(text);
}

/** Simulates formatPair from TranslationService */
function formatPair(original: string, translated: string): string {
    return `${original} (${translated})`;
}

interface MockItem {
    id: number | string;
    name: string;
    count: number;
    _origName?: string;
}

const LIST_ROUTES = new Set(['/tags', '/circles', '/vas']);

function isListPage(path: string): boolean {
    return LIST_ROUTES.has(path);
}

/** Simulate the tag augmentation logic */
function augmentTagItems(
    items: MockItem[],
    enMap: Map<number, string>,
): number {
    let augmented = 0;
    for (const item of items) {
        if (item._origName) continue;
        const id = typeof item.id === 'string' ? parseInt(item.id, 10) : item.id;
        const en = enMap.get(id);
        if (en && looksJapanese(item.name)) {
            item._origName = item.name;
            item.name = formatPair(item.name, en);
            augmented++;
        }
    }
    return augmented;
}

/** Simulate the restore logic */
function restoreOriginalNames(items: MockItem[]): number {
    let restored = 0;
    for (const item of items) {
        if (item._origName) {
            item.name = item._origName;
            delete item._origName;
            restored++;
        }
    }
    return restored;
}

describe('ListSearchEnhancer', () => {
    describe('isListPage', () => {
        it('returns true for /tags', () => {
            expect(isListPage('/tags')).toBe(true);
        });
        it('returns true for /circles', () => {
            expect(isListPage('/circles')).toBe(true);
        });
        it('returns true for /vas', () => {
            expect(isListPage('/vas')).toBe(true);
        });
        it('returns false for /works', () => {
            expect(isListPage('/works')).toBe(false);
        });
        it('returns false for /work/RJ123456', () => {
            expect(isListPage('/work/RJ123456')).toBe(false);
        });
        it('returns false for empty path', () => {
            expect(isListPage('')).toBe(false);
        });
    });

    describe('looksJapanese', () => {
        it('detects hiragana', () => {
            expect(looksJapanese('せみなっつ')).toBe(true);
        });
        it('detects katakana', () => {
            expect(looksJapanese('アイボイス')).toBe(true);
        });
        it('detects kanji', () => {
            expect(looksJapanese('巨乳大好き屋')).toBe(true);
        });
        it('returns false for pure Latin', () => {
            expect(looksJapanese('Whisp')).toBe(false);
        });
        it('returns false for empty', () => {
            expect(looksJapanese('')).toBe(false);
        });
        it('detects mixed Latin + Japanese', () => {
            expect(looksJapanese('Aボイス')).toBe(true);
        });
    });

    describe('augmentTagItems', () => {
        let items: MockItem[];
        let enMap: Map<number, string>;

        beforeEach(() => {
            items = [
                { id: 1, name: '耳舐め', count: 542 },
                { id: 2, name: 'ASMR', count: 300 },
                { id: 3, name: '催眠', count: 200 },
            ];
            enMap = new Map([
                [1, 'Ear Licking'],
                [3, 'Hypnosis'],
            ]);
        });

        it('augments Japanese items with English translations', () => {
            const count = augmentTagItems(items, enMap);
            expect(count).toBe(2);
            expect(items[0].name).toBe('耳舐め (Ear Licking)');
            expect(items[0]._origName).toBe('耳舐め');
            expect(items[2].name).toBe('催眠 (Hypnosis)');
            expect(items[2]._origName).toBe('催眠');
        });

        it('skips non-Japanese items even with translation available', () => {
            enMap.set(2, 'ASMR English');
            const count = augmentTagItems(items, enMap);
            expect(count).toBe(2); // ASMR skipped (not Japanese)
            expect(items[1].name).toBe('ASMR');
            expect(items[1]._origName).toBeUndefined();
        });

        it('skips already-augmented items', () => {
            items[0]._origName = '耳舐め';
            items[0].name = '耳舐め (Ear Licking)';
            const count = augmentTagItems(items, enMap);
            expect(count).toBe(1); // Only 催眠 augmented
            expect(items[0].name).toBe('耳舐め (Ear Licking)');
        });

        it('skips items without translations', () => {
            enMap.clear();
            const count = augmentTagItems(items, enMap);
            expect(count).toBe(0);
        });

        it('handles string IDs', () => {
            items[0].id = '1';
            const count = augmentTagItems(items, enMap);
            expect(count).toBe(2);
            expect(items[0].name).toBe('耳舐め (Ear Licking)');
        });
    });

    describe('restoreOriginalNames', () => {
        it('restores augmented items to original names', () => {
            const items: MockItem[] = [
                { id: 1, name: '耳舐め (Ear Licking)', count: 542, _origName: '耳舐め' },
                { id: 2, name: 'ASMR', count: 300 },
                { id: 3, name: '催眠 (Hypnosis)', count: 200, _origName: '催眠' },
            ];
            const count = restoreOriginalNames(items);
            expect(count).toBe(2);
            expect(items[0].name).toBe('耳舐め');
            expect(items[0]._origName).toBeUndefined();
            expect(items[1].name).toBe('ASMR');
            expect(items[2].name).toBe('催眠');
            expect(items[2]._origName).toBeUndefined();
        });

        it('handles empty array', () => {
            const count = restoreOriginalNames([]);
            expect(count).toBe(0);
        });
    });

    describe('search matching via augmented names', () => {
        it('matches English search term against augmented name', () => {
            const items: MockItem[] = [
                { id: 1, name: 'アイボイス (ivoice)', count: 978, _origName: 'アイボイス' },
                { id: 2, name: 'Whisp', count: 572 },
                { id: 3, name: 'せみなっつ (Seminatsu)', count: 503, _origName: 'せみなっつ' },
            ];
            const keyword = 'ivoice';
            const filtered = items.filter(item =>
                item.name.toLowerCase().indexOf(keyword.toLowerCase()) !== -1
            );
            expect(filtered).toHaveLength(1);
            expect(filtered[0].id).toBe(1);
        });

        it('matches Japanese search term against augmented name', () => {
            const items: MockItem[] = [
                { id: 1, name: 'アイボイス (ivoice)', count: 978, _origName: 'アイボイス' },
                { id: 3, name: 'せみなっつ (Seminatsu)', count: 503, _origName: 'せみなっつ' },
            ];
            const keyword = 'アイボイス';
            const filtered = items.filter(item =>
                item.name.toLowerCase().indexOf(keyword.toLowerCase()) !== -1
            );
            expect(filtered).toHaveLength(1);
            expect(filtered[0].id).toBe(1);
        });

        it('matches partial English term', () => {
            const items: MockItem[] = [
                { id: 1, name: '耳舐め (Ear Licking)', count: 542, _origName: '耳舐め' },
                { id: 2, name: '催眠 (Hypnosis)', count: 200, _origName: '催眠' },
            ];
            const keyword = 'ear';
            const filtered = items.filter(item =>
                item.name.toLowerCase().indexOf(keyword.toLowerCase()) !== -1
            );
            expect(filtered).toHaveLength(1);
            expect(filtered[0].name).toContain('Ear Licking');
        });
    });

    describe('stripTranslationsFromKeyword', () => {
        /** Mirrors the regex in ListSearchEnhancer */
        function stripTranslationsFromKeyword(keyword: string): string {
            return keyword.replace(
                /(\$(?:circle|va|tag):.*?)\s+\([A-Za-z][-A-Za-z\s.,!?;:'"…()]*\)(\$)/g,
                '$1$2',
            );
        }

        it('strips English from $circle: keyword', () => {
            expect(stripTranslationsFromKeyword('$circle:テグラユウキ (Tegra Yuki)$'))
                .toBe('$circle:テグラユウキ$');
        });

        it('strips English from $va: keyword', () => {
            expect(stripTranslationsFromKeyword('$va:佐倉江美 (Sakura Emi)$'))
                .toBe('$va:佐倉江美$');
        });

        it('strips English from $tag: keyword', () => {
            expect(stripTranslationsFromKeyword('$tag:耳舐め (Ear Licking)$'))
                .toBe('$tag:耳舐め$');
        });

        it('handles multiple keywords in one string', () => {
            const input = '$circle:ありがた屋 (Thank you)$ $va:佐倉江美 (Sakura Emi)$';
            expect(stripTranslationsFromKeyword(input))
                .toBe('$circle:ありがた屋$ $va:佐倉江美$');
        });

        it('does not touch keywords without English translation', () => {
            expect(stripTranslationsFromKeyword('$circle:テグラユウキ$'))
                .toBe('$circle:テグラユウキ$');
        });

        it('does not touch non-advanced-search text', () => {
            expect(stripTranslationsFromKeyword('plain search'))
                .toBe('plain search');
        });

        it('preserves parenthesized non-Latin content in names', () => {
            // Circle with Japanese in parentheses should NOT be stripped
            expect(stripTranslationsFromKeyword('$circle:Diebrust(ディーブルスト)$'))
                .toBe('$circle:Diebrust(ディーブルスト)$');
        });
    });

    describe('TranslatedTags coordination via hasExistingRomanization', () => {
        it('detects augmented items with parenthesized English', () => {
            expect(hasExistingRomanization('アイボイス (ivoice)')).toBe(true);
            expect(hasExistingRomanization('耳舐め (Ear Licking)')).toBe(true);
            expect(hasExistingRomanization('せみなっつ (Seminatsu)')).toBe(true);
        });

        it('does not match items without romanization', () => {
            expect(hasExistingRomanization('アイボイス')).toBe(false);
            expect(hasExistingRomanization('耳舐め')).toBe(false);
        });

        it('does not match items with non-Latin parenthesized content', () => {
            expect(hasExistingRomanization('Diebrust(ディーブルスト)')).toBe(false);
        });

        it('matches items with multi-word English translations', () => {
            expect(hasExistingRomanization('ケチャップ味のマヨネーズ (Ketchup flavored mayonnaise)')).toBe(true);
        });
    });
});
