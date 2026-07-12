import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(
    resolve(process.cwd(), 'src/features/components/ContinueListeningPanel.vue'),
    'utf8',
);

describe('ContinueListeningPanel theme', () => {
    it('does not force dark-only Quasar utilities in light mode', () => {
        expect(source).not.toMatch(/\b(?:q-card--dark|q-separator--dark|q-chip--dark|q-dark|text-white)\b/);
    });

    it('uses semantic variables for title, card, separator, and neutral chips', () => {
        expect(source).toMatch(/\.asmr-continue-title,[\s\S]*var\(--asmr-text-primary\)/);
        expect(source).toMatch(/\.asmr-continue-card\s*\{[\s\S]*var\(--asmr-bg-primary\)/);
        expect(source).toMatch(/\.asmr-continue-separator\s*\{[\s\S]*var\(--asmr-border-color\)/);
        expect(source).toMatch(/\.asmr-continue-neutral-chip\s*\{[\s\S]*var\(--asmr-bg-tertiary\)/);
    });
});
