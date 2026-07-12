import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const globalCss = readFileSync(
    resolve(process.cwd(), 'src/styles/components/_player_fullscreen.css'),
    'utf8',
);
const component = readFileSync(
    resolve(process.cwd(), 'src/features/components/PlayerFullscreen.vue'),
    'utf8',
);

describe('PlayerFullscreen button presentation', () => {
    it('keeps a transparent, low-emphasis light-mode control with a full touch target', () => {
        for (const source of [globalCss, component]) {
            expect(source).toMatch(/\.asmr-fullscreen-btn\s*\{[\s\S]*width:\s*44px\s*!important/);
            expect(source).toMatch(/\.asmr-fullscreen-btn\s*\{[\s\S]*height:\s*44px\s*!important/);
            expect(source).toMatch(/\.asmr-fullscreen-btn\s*\{[\s\S]*background:\s*transparent\s*!important/);
            expect(source).toMatch(/\.asmr-fullscreen-btn\s*\{[\s\S]*color:\s*#111827\s*!important/);
            expect(source).toMatch(/\.asmr-fullscreen-btn\s*\{[\s\S]*opacity:\s*0\.28\s*!important/);
        }
    });

    it('reveals on hover/focus and provides a white-on-dark icon override', () => {
        expect(globalCss).toMatch(/:is\(\.body--dark, \.q-dark, \[data-theme="dark"\]\)[\s\S]*\.asmr-fullscreen-btn[\s\S]*color:\s*#fff\s*!important/);
        expect(globalCss).toMatch(/\.asmr-fullscreen-btn:hover\s*\{[\s\S]*opacity:\s*1\s*!important/);
        expect(globalCss).toMatch(/\.asmr-fullscreen-btn:focus-visible\s*\{[\s\S]*outline:\s*3px solid #1976d2\s*!important/);
    });
});
