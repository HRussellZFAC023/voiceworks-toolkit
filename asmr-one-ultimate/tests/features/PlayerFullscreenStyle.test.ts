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
const controller = readFileSync(
    resolve(process.cwd(), 'src/features/PlayerFullscreenController.ts'),
    'utf8',
);

describe('PlayerFullscreen injects no control of its own', () => {
    it('renders no fullscreen button, because the host player already ships one', () => {
        expect(component).not.toContain('asmr-fullscreen-btn');
        expect(component).not.toMatch(/<button/);
        expect(globalCss).not.toContain('asmr-fullscreen-btn');
    });

    it('keeps the fullscreen behaviour reachable without a duplicated button', () => {
        // Escape, swipe-down and the keyboard/programmatic entry points all
        // survive the button removal; only the redundant affordance is gone.
        expect(component).toContain("document.addEventListener('keydown', onKeydown, true)");
        expect(component).toContain('function onTouchEnd');
        expect(component).toContain('defineExpose({ syncFullscreenClass, toggleFullscreen, exit, isFullscreen })');
        expect(controller).toContain('exposed?.toggleFullscreen?.()');
    });

    it('drops the now-unused button labels from the component', () => {
        expect(component).not.toContain('fullscreenToggle');
        expect(component).not.toContain('fullscreenExit');
    });
});
