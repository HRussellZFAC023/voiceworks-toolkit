import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const component = readFileSync(
    resolve(process.cwd(), 'src/features/components/InfiniteScrollGrid.vue'),
    'utf8',
);
const fixes = readFileSync(resolve(process.cwd(), 'src/styles/fixes.css'), 'utf8');

describe('InfiniteScrollGrid fallback theme', () => {
    it('does not force dark Quasar utilities into fallback cards', () => {
        const start = component.indexOf('function appendWorksToHostGrid');
        const end = component.indexOf('// ============================================================================\n// Pagination Detection', start);
        const fallbackSource = component.slice(start, end);

        expect(fallbackSource).not.toMatch(/\b(?:q-card--dark|q-separator--dark|q-chip--dark|q-dark|text-white)\b/);
        expect(fallbackSource).toContain('asmr-infinite-fallback-card');
        expect(fallbackSource).toContain('asmr-infinite-fallback-separator');
        expect(fallbackSource).toContain('asmr-infinite-duration');
        expect(fallbackSource).toContain("col.dataset.asmrInfiniteFallback = 'true'");
    });

    it('styles fallback surfaces through light/dark semantic variables', () => {
        expect(fixes).toMatch(/\.asmr-infinite-fallback-card\s*\{[\s\S]*background:\s*var\(--asmr-bg-primary\)/);
        expect(fixes).toMatch(/\.asmr-infinite-fallback-card\s*\{[\s\S]*color:\s*var\(--asmr-text-primary\)/);
        expect(fixes).toMatch(/\.asmr-infinite-fallback-separator\s*\{[\s\S]*var\(--asmr-border-color\)/);
        expect(fixes).toMatch(/\.asmr-infinite-duration\s*\{[\s\S]*var\(--asmr-text-secondary\)/);
    });

    it('removes DOM fallback cards when the component is disabled or reattached', () => {
        expect(component).toMatch(/function cleanup\(\): void \{[\s\S]*\[data-asmr-infinite-fallback="true"\][\s\S]*\.remove\(\)/);
        expect(component).toMatch(/function cleanup\(\): void \{[\s\S]*injectedCardIds\.clear\(\)/);
    });
});
