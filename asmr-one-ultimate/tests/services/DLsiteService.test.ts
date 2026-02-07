import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DLsiteServiceImpl } from '../../src/services/DLsiteService';
import type { DLsiteUserReview } from '../../src/types/dlsite';

// We test private helper methods through (instance as any) — standard pattern for unit-testing
// pure logic that's hidden behind access modifiers.
let svc: any;

beforeEach(() => {
    svc = new DLsiteServiceImpl();
});

// ==========================================================================
// cleanHtmlToText
// ==========================================================================
describe('cleanHtmlToText', () => {
    it('should strip HTML tags', () => {
        expect(svc.cleanHtmlToText('<p>Hello <b>world</b></p>')).toBe('Hello world');
    });

    it('should convert <br> to newlines', () => {
        expect(svc.cleanHtmlToText('line1<br>line2<br/>line3')).toBe('line1\nline2\nline3');
    });

    it('should decode common HTML entities', () => {
        expect(svc.cleanHtmlToText('A &amp; B &lt; C &gt; D &quot;E&quot;')).toBe('A & B < C > D "E"');
    });

    it('should convert &nbsp; to space', () => {
        expect(svc.cleanHtmlToText('hello&nbsp;world')).toBe('hello world');
    });

    it('should collapse multiple spaces', () => {
        expect(svc.cleanHtmlToText('hello     world')).toBe('hello world');
    });

    it('should collapse excessive newlines', () => {
        expect(svc.cleanHtmlToText('a\n\n\n\n\nb')).toBe('a\n\nb');
    });

    it('should trim whitespace', () => {
        expect(svc.cleanHtmlToText('  hello  ')).toBe('hello');
    });

    it('should preserve <a> links as markdown', () => {
        const html = '<a href="https://example.com">Click here</a>';
        expect(svc.cleanHtmlToText(html)).toBe('[Click here](https://example.com)');
    });

    it('should strip tabs', () => {
        // Tabs are removed (not replaced with space)
        expect(svc.cleanHtmlToText('hello\tworld')).toBe('helloworld');
    });

    it('should handle empty string', () => {
        expect(svc.cleanHtmlToText('')).toBe('');
    });

    it('should handle complex mixed HTML', () => {
        const html = '<div><p>First&nbsp;paragraph</p><br><p>Second <a href="/link">link</a> here</p></div>';
        const result = svc.cleanHtmlToText(html);
        expect(result).toContain('First paragraph');
        expect(result).toContain('[link](/link)');
        expect(result).toContain('Second');
    });
});

// ==========================================================================
// looksLikeCode
// ==========================================================================
describe('looksLikeCode', () => {
    it('should detect jQuery-style code', () => {
        expect(svc.looksLikeCode('$(".class").html("text")')).toBe(true);
    });

    it('should detect function declarations', () => {
        expect(svc.looksLikeCode('function() { return 42; }')).toBe(true);
    });

    it('should detect var declarations', () => {
        expect(svc.looksLikeCode('var myVar = 123;')).toBe(true);
    });

    it('should detect .get() calls', () => {
        expect(svc.looksLikeCode('axios.get("/api/data")')).toBe(true);
    });

    it('should detect template syntax', () => {
        expect(svc.looksLikeCode('{{ myVariable }}')).toBe(true);
    });

    it('should detect swiper/slider code', () => {
        expect(svc.looksLikeCode('breakpoints: { 768: { slidesPerView: 3 } }')).toBe(true);
    });

    it('should return false for normal Japanese text', () => {
        expect(svc.looksLikeCode('この作品はとても良い音声作品です。')).toBe(false);
    });

    it('should return false for normal English text', () => {
        expect(svc.looksLikeCode('This is a great audio work with relaxing content.')).toBe(false);
    });
});

// ==========================================================================
// extractEntry
// ==========================================================================
describe('extractEntry', () => {
    it('should extract from array payload', () => {
        const payload = [{ work_name: 'Test' }];
        expect(svc.extractEntry(payload, 'RJ123456')).toEqual({ work_name: 'Test' });
    });

    it('should extract from data array', () => {
        const payload = { data: [{ work_name: 'Test' }] };
        expect(svc.extractEntry(payload, 'RJ123456')).toEqual({ work_name: 'Test' });
    });

    it('should extract from data object', () => {
        const payload = { data: { work_name: 'Test' } };
        expect(svc.extractEntry(payload, 'RJ123456')).toEqual({ work_name: 'Test' });
    });

    it('should extract from product key', () => {
        const payload = { product: { work_name: 'Test' } };
        expect(svc.extractEntry(payload, 'RJ123456')).toEqual({ work_name: 'Test' });
    });

    it('should extract from work key', () => {
        const payload = { work: { work_name: 'Test' } };
        expect(svc.extractEntry(payload, 'RJ123456')).toEqual({ work_name: 'Test' });
    });

    it('should extract by RJ code key', () => {
        const payload = { RJ123456: { work_name: 'Test' } };
        expect(svc.extractEntry(payload, 'RJ123456')).toEqual({ work_name: 'Test' });
    });

    it('should return null for empty array', () => {
        expect(svc.extractEntry([], 'RJ123456')).toBeNull();
    });

    it('should return null for empty object', () => {
        expect(svc.extractEntry({}, 'RJ123456')).toBeNull();
    });

    it('should extract from works array', () => {
        const payload = { works: [{ work_name: 'Test' }] };
        expect(svc.extractEntry(payload, 'RJ123456')).toEqual({ work_name: 'Test' });
    });

    it('should extract from items array', () => {
        const payload = { items: [{ work_name: 'Test' }] };
        expect(svc.extractEntry(payload, 'RJ123456')).toEqual({ work_name: 'Test' });
    });

    it('should extract from list array', () => {
        const payload = { list: [{ work_name: 'Test' }] };
        expect(svc.extractEntry(payload, 'RJ123456')).toEqual({ work_name: 'Test' });
    });

    it('should normalize rjCode to uppercase for lookup', () => {
        const payload = { RJ123456: { work_name: 'Test' } };
        expect(svc.extractEntry(payload, 'rj123456')).toEqual({ work_name: 'Test' });
    });
});

// ==========================================================================
// extractReviewItems
// ==========================================================================
describe('extractReviewItems', () => {
    it('should extract from review_list key', () => {
        const payload = { review_list: [{ id: 1 }, { id: 2 }] };
        expect(svc.extractReviewItems(payload)).toHaveLength(2);
    });

    it('should extract from data.review_list', () => {
        const payload = { data: { review_list: [{ id: 1 }] } };
        expect(svc.extractReviewItems(payload)).toHaveLength(1);
    });

    it('should extract from reviews key', () => {
        const payload = { reviews: [{ id: 1 }, { id: 2 }, { id: 3 }] };
        expect(svc.extractReviewItems(payload)).toHaveLength(3);
    });

    it('should extract from data array', () => {
        const payload = { data: [{ id: 1 }] };
        expect(svc.extractReviewItems(payload)).toHaveLength(1);
    });

    it('should extract from list key', () => {
        const payload = { list: [{ id: 1 }] };
        expect(svc.extractReviewItems(payload)).toHaveLength(1);
    });

    it('should handle array payload directly', () => {
        const payload = [{ id: 1 }, { id: 2 }];
        expect(svc.extractReviewItems(payload)).toHaveLength(2);
    });

    it('should return empty array for empty payload', () => {
        expect(svc.extractReviewItems({})).toEqual([]);
    });

    it('should return empty array when review_list is empty', () => {
        expect(svc.extractReviewItems({ review_list: [] })).toEqual([]);
    });

    it('should prefer review_list over data array', () => {
        const payload = { review_list: [{ from: 'list' }], data: [{ from: 'data' }] };
        expect(svc.extractReviewItems(payload)).toEqual([{ from: 'list' }]);
    });
});

// ==========================================================================
// isValidReview
// ==========================================================================
describe('isValidReview', () => {
    const makeReview = (overrides: Partial<DLsiteUserReview> = {}): DLsiteUserReview => ({
        username: 'TestUser',
        rating: 4,
        text: 'This is a good review with enough length.',
        date: '2024-01-15',
        source: 'dlsite',
        ...overrides,
    });

    it('should accept valid review', () => {
        expect(svc.isValidReview(makeReview())).toBe(true);
    });

    it('should reject empty text', () => {
        expect(svc.isValidReview(makeReview({ text: '' }))).toBe(false);
    });

    it('should reject very short text (< 3 chars)', () => {
        expect(svc.isValidReview(makeReview({ text: 'ab' }))).toBe(false);
    });

    it('should reject age gate text in review body', () => {
        expect(svc.isValidReview(makeReview({ text: 'あなたは18歳以上ですか' }))).toBe(false);
    });

    it('should reject age_verification marker', () => {
        expect(svc.isValidReview(makeReview({ text: 'Some text with age_verification in it' }))).toBe(false);
    });

    it('should reject content warning text', () => {
        expect(svc.isValidReview(makeReview({ text: '一般的な作品に加えて暴力表現・性描写など' }))).toBe(false);
    });

    it('should reject age gate text in username', () => {
        expect(svc.isValidReview(makeReview({ username: 'age_verification' }))).toBe(false);
    });

    it('should reject price-only text (yen)', () => {
        expect(svc.isValidReview(makeReview({ text: '660 円' }))).toBe(false);
    });

    it('should reject price-only text (JPY)', () => {
        expect(svc.isValidReview(makeReview({ text: '1,320 JPY' }))).toBe(false);
    });

    it('should accept text that mentions price as part of review', () => {
        expect(svc.isValidReview(makeReview({ text: 'Worth every penny at 660 円 for this work' }))).toBe(true);
    });

    it('should accept 3-char minimum text', () => {
        expect(svc.isValidReview(makeReview({ text: '良い！' }))).toBe(true);
    });
});

// ==========================================================================
// parseReviewBlock (HTML → review object)
// ==========================================================================
describe('parseReviewBlock', () => {
    it('should extract rating from star class', () => {
        const block = '<span class="star_4"></span><div class="review_text">Great work</div>';
        const review = svc.parseReviewBlock(block);
        expect(review).not.toBeNull();
        expect(review!.rating).toBe(4);
    });

    it('should extract rating from numeric pattern', () => {
        const block = '<span>3/5</span><div class="review_text">Average work</div>';
        const review = svc.parseReviewBlock(block);
        expect(review).not.toBeNull();
        expect(review!.rating).toBe(3);
    });

    it('should extract username from reviewer class', () => {
        const block = '<span class="reviewer">TestUser</span><div class="review_text">Good</div>';
        const review = svc.parseReviewBlock(block);
        expect(review).not.toBeNull();
        expect(review!.username).toBe('TestUser');
    });

    it('should extract text from review_text class', () => {
        const block = '<div class="review_text">This is the review content</div>';
        const review = svc.parseReviewBlock(block);
        expect(review).not.toBeNull();
        expect(review!.text).toBe('This is the review content');
    });

    it('should extract date', () => {
        const block = '<span>2024/01/15</span><div class="review_text">Good work</div>';
        const review = svc.parseReviewBlock(block);
        expect(review).not.toBeNull();
        expect(review!.date).toBe('2024/01/15');
    });

    it('should return null for blocks with no text', () => {
        const block = '<span class="star_5"></span>';
        expect(svc.parseReviewBlock(block)).toBeNull();
    });

    it('should return null for very short text', () => {
        const block = '<div class="review_text">ab</div>';
        expect(svc.parseReviewBlock(block)).toBeNull();
    });

    it('should fallback to p tag for text extraction', () => {
        const block = '<p>This is review content from p tag</p>';
        const review = svc.parseReviewBlock(block);
        expect(review).not.toBeNull();
        expect(review!.text).toBe('This is review content from p tag');
    });

    it('should count filled star icons as rating fallback', () => {
        const block = '<span class="star_on"></span><span class="star_on"></span><span class="star_on"></span><span class="star_off"></span><div class="review_text">Decent work</div>';
        const review = svc.parseReviewBlock(block);
        expect(review).not.toBeNull();
        expect(review!.rating).toBe(3);
    });

    it('should set source to dlsite', () => {
        const block = '<div class="review_text">Review text here</div>';
        const review = svc.parseReviewBlock(block);
        expect(review!.source).toBe('dlsite');
    });
});

// ==========================================================================
// parseJsonResponse
// ==========================================================================
describe('parseJsonResponse', () => {
    it('should return response object directly if available', () => {
        const res = { response: { key: 'value' }, responseText: '{"other": true}' };
        expect(svc.parseJsonResponse(res, 'test')).toEqual({ key: 'value' });
    });

    it('should parse responseText as JSON', () => {
        const res = { response: null, responseText: '{"hello": "world"}' };
        expect(svc.parseJsonResponse(res, 'test')).toEqual({ hello: 'world' });
    });

    it('should throw on empty response', () => {
        const res = { response: null, responseText: '', status: 200 };
        expect(() => svc.parseJsonResponse(res, 'test')).toThrow('Empty response');
    });

    it('should throw on HTML response', () => {
        const res = { response: null, responseText: '<html><body>Not JSON</body></html>', status: 200 };
        expect(() => svc.parseJsonResponse(res, 'test')).toThrow('HTML response instead of JSON');
    });

    it('should throw on invalid JSON', () => {
        const res = { response: null, responseText: '{invalid json}' };
        expect(() => svc.parseJsonResponse(res, 'test')).toThrow();
    });

    it('should handle string response property as text', () => {
        const res = { response: '{"from": "string"}', responseText: '' };
        expect(svc.parseJsonResponse(res, 'test')).toEqual({ from: 'string' });
    });
});

// ==========================================================================
// extractDescriptionBody
// ==========================================================================
describe('extractDescriptionBody', () => {
    it('should extract text from work_parts_container', () => {
        const html = `
            <div class="work_parts_container">
                <div class="work_parts_multitype_item type_text"><p>Description text here</p></div>
            </div>
            <div class="work_buy_container"></div>
        `;
        expect(svc.extractDescriptionBody(html)).toBe('Description text here');
    });

    it('should return null when no work_parts_container found', () => {
        expect(svc.extractDescriptionBody('<html><body>No container</body></html>')).toBeNull();
    });

    it('should join multiple text parts with double newline', () => {
        const html = `
            <div class="work_parts_container">
                <div class="work_parts_multitype_item type_text"><p>Part 1</p></div>
                <div class="work_parts_multitype_item type_text"><p>Part 2</p></div>
            </div>
            <div class="work_buy_container"></div>
        `;
        expect(svc.extractDescriptionBody(html)).toBe('Part 1\n\nPart 2');
    });

    it('should strip script and style tags from description', () => {
        // The container and boundary must be close together; scripts inside the container range
        const html = '<div class="work_parts_container"><script>alert("xss")</script><style>.hidden{display:none}</style><div class="work_parts_multitype_item type_text"><p>Clean text</p></div></div><div class="work_buy_container"></div>';
        expect(svc.extractDescriptionBody(html)).toBe('Clean text');
    });

    it('should fallback to p tags if no type_text blocks found', () => {
        const html = `
            <div class="work_parts_container">
                <p>This is a long enough paragraph that should be extracted by the fallback logic.</p>
            </div>
            <div class="work_buy_container"></div>
        `;
        const result = svc.extractDescriptionBody(html);
        expect(result).toContain('long enough paragraph');
    });

    it('should filter out code-like paragraphs in fallback', () => {
        const html = `
            <div class="work_parts_container">
                <p>var myVar = slidesPerView + breakpoints</p>
                <p>This is a real description paragraph that is long enough to keep.</p>
            </div>
            <div class="work_buy_container"></div>
        `;
        const result = svc.extractDescriptionBody(html);
        expect(result).not.toContain('myVar');
        expect(result).toContain('real description');
    });
});

// ==========================================================================
// fetchProductApi — input validation only
// ==========================================================================
describe('fetchProductApi input validation', () => {
    it('should return null for empty rjCode', async () => {
        expect(await svc.fetchProductApi('')).toBeNull();
    });

    it('should return null for invalid rjCode format', async () => {
        expect(await svc.fetchProductApi('INVALID')).toBeNull();
    });

    it('should return null for too short numeric code', async () => {
        expect(await svc.fetchProductApi('1234')).toBeNull();
    });

    it('should accept valid RJ codes', async () => {
        // This will fail at the network layer, but the validation should pass
        // We expect it to return null (network failure) not throw
        const result = await svc.fetchProductApi('RJ123456');
        expect(result).toBeNull(); // Network mocked globally to return non-JSON
    });

    it('should accept bare numeric codes (5+ digits)', async () => {
        const result = await svc.fetchProductApi('12345');
        expect(result).toBeNull();
    });

    it('should accept VJ and BJ prefixes', async () => {
        expect(await svc.fetchProductApi('VJ12345')).toBeNull();
        expect(await svc.fetchProductApi('BJ12345')).toBeNull();
    });
});

// ==========================================================================
// fetchDynamicApi — input validation only
// ==========================================================================
describe('fetchDynamicApi input validation', () => {
    it('should return null for empty rjCode', async () => {
        expect(await svc.fetchDynamicApi('')).toBeNull();
    });

    it('should return null for invalid format', async () => {
        expect(await svc.fetchDynamicApi('INVALID')).toBeNull();
    });
});

// ==========================================================================
// fetchProductPageBody — input validation only
// ==========================================================================
describe('fetchProductPageBody input validation', () => {
    it('should return null for empty rjCode', async () => {
        expect(await svc.fetchProductPageBody('')).toBeNull();
    });

    it('should return null for invalid format', async () => {
        expect(await svc.fetchProductPageBody('abc')).toBeNull();
    });
});

// ==========================================================================
// fetchProductPageReviews — input validation only
// ==========================================================================
describe('fetchProductPageReviews input validation', () => {
    it('should return empty array for empty rjCode', async () => {
        expect(await svc.fetchProductPageReviews('')).toEqual([]);
    });

    it('should return empty array for invalid format', async () => {
        expect(await svc.fetchProductPageReviews('NOTVALID')).toEqual([]);
    });
});
