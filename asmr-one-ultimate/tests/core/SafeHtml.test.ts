import { describe, expect, it } from 'vitest';
import { sanitizeAllowedHtml, toSafeHttpUrl } from '../../src/core/SafeHtml';

describe('sanitizeAllowedHtml', () => {
    it('accepts only HTTP(S) navigation targets', () => {
        expect(toSafeHttpUrl('https://example.com/image.jpg')).toBe('https://example.com/image.jpg');
        expect(toSafeHttpUrl('javascript:alert(1)')).toBeNull();
        expect(toSafeHttpUrl('data:text/html,unsafe')).toBeNull();
    });

    it('removes executable markup and rebuilds safe links', () => {
        const output = sanitizeAllowedHtml(
            '<svg onload="alert(1)"><text>kept</text></svg>'
            + '<a href="javascript:alert(2)" onclick="alert(3)">unsafe</a>'
            + '<a href="https://example.com/path" style="color:red">safe</a>',
        );

        expect(output).not.toMatch(/svg|onload|onclick|javascript:|style=/i);
        expect(output).toContain('kept');
        expect(output).toContain('unsafe');
        expect(output).toContain('href="https://example.com/path"');
        expect(output).toContain('rel="noopener noreferrer"');
    });

    it('allows only safe, attribute-scrubbed images when explicitly enabled', () => {
        const output = sanitizeAllowedHtml(
            '<img src="https://img.example/cover.jpg" alt="cover" onerror="alert(1)" style="position:fixed">'
            + '<img src="data:text/html,bad" onload="alert(2)">',
            { allowImages: true },
        );

        expect(output).toContain('src="https://img.example/cover.jpg"');
        expect(output).toContain('alt="cover"');
        expect(output).toContain('loading="lazy"');
        expect(output).not.toMatch(/onerror|onload|style=|data:text/i);
        expect(output.match(/<img/g)).toHaveLength(1);
    });

    it('removes images from text-only surfaces', () => {
        expect(sanitizeAllowedHtml('<img src="https://img.example/x.jpg">text')).toBe('text');
    });
});
