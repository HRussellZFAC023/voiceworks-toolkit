import { describe, expect, it } from 'vitest';
import {
    canonicalSemanticDocumentPayload,
    canonicalSemanticPassageModelInput,
    prepareSemanticWorkEntry,
    semanticDotProduct,
    SEMANTIC_DOCUMENT_MAX_CHARS,
} from '../../src/features/vectorSearchEntryUtils';

describe('canonical semantic document payload', () => {
    it('normalizes whitespace and applies the device-independent baseline limit', () => {
        const payload = canonicalSemanticDocumentPayload(`  title\n\t${'x'.repeat(1_000)}  `);
        expect(payload).toHaveLength(SEMANTIC_DOCUMENT_MAX_CHARS);
        expect(payload.startsWith('title x')).toBe(true);
        expect(payload).not.toContain('\n');
        expect(canonicalSemanticPassageModelInput('  title\nbody  ')).toBe('passage: title body');
    });

    it('keeps the browser and producer entry recipe on one golden payload', () => {
        const prepared = prepareSemanticWorkEntry({
            id: 42, title: '声の作品', description: '  Long\n description  ', release: '2026-07-14',
            circle: { name: 'Circle' }, series: { name: 'Series' }, vas: [{ name: 'VA' }],
            tags: [{ id: 7, name: '耳かき', i18n: { 'en-us': { name: 'Ear cleaning' }, 'ja-jp': { name: '耳かき' } } }],
            language_editions: [{ lang: 'JPN' }], age_category_string: 'adult', dl_count: 12,
        }, { resolveTagAliases: () => ['Dictionary alias'] });

        expect(prepared).not.toBeNull();
        expect(prepared?.payload).toBe([
            'Title: 声の作品', 'Circle: Circle', 'Series: Series', 'VAs: VA',
            'Tags: Dictionary alias, 耳かき, Ear cleaning', 'Category: adult',
            'Languages: JPN', 'Description:   Long\n description  ',
        ].join('\n'));
        expect(canonicalSemanticPassageModelInput(prepared!.payload)).toBe(
            'passage: Title: 声の作品 Circle: Circle Series: Series VAs: VA Tags: Dictionary alias, 耳かき, Ear cleaning Category: adult Languages: JPN Description: Long description',
        );
        expect(prepared?.entry).toMatchObject({ id: '42', tags: ['耳かき'], dlCount: 12, vector: [] });
        expect(semanticDotProduct(new Float32Array([0.5, 0.25]), [2, 4])).toBe(2);
    });
});
