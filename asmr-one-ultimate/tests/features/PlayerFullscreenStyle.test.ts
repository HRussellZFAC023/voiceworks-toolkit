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

describe('PlayerFullscreen keeps a stable clickable control', () => {
    it('renders exactly one themed fullscreen toggle when the host control is absent', () => {
        expect(component.match(/class="asmr-fullscreen-btn"/g)).toHaveLength(1);
        expect(component).toContain(":aria-label=\"isFullscreen ? t('fullscreenExit') : t('fullscreenToggle')\"");
        expect(component).toContain(":aria-pressed=\"isFullscreen\"");
        expect(globalCss).toContain('.audio-player .asmr-fullscreen-btn');
    });

    it('keeps button, keyboard, swipe and programmatic entry points on one toggle', () => {
        expect(component).toContain('@click.stop="toggleFullscreen"');
        expect(component).toContain("document.addEventListener('keydown', onKeydown, true)");
        expect(component).toContain('function onTouchEnd');
        expect(component).toContain('defineExpose({ syncFullscreenClass, toggleFullscreen, exit, isFullscreen })');
        expect(controller).toContain('exposed?.toggleFullscreen?.()');
    });

    it('keeps the resting surface transparent without fading the outlined glyph', () => {
        const resting = /\.audio-player \.asmr-fullscreen-btn\s*\{([^}]*)\}/.exec(globalCss)?.[1] ?? '';
        expect(resting).toMatch(/background:\s*transparent/);
        expect(resting).toMatch(/opacity:\s*1/);
        expect(globalCss).toContain('-webkit-text-stroke: 1px rgba(0, 0, 0, 0.92)');
        const interactive = /\.audio-player \.asmr-fullscreen-btn:hover,[\s\S]*?\.audio-player \.asmr-fullscreen-btn:focus-visible\s*\{([^}]*)\}/
            .exec(globalCss)?.[1] ?? '';
        expect(interactive).toMatch(/opacity:\s*1/);
    });
});
