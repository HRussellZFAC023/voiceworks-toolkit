/**
 * Measured contrast for the player, subtitle, gallery and lightbox surfaces.
 *
 * These were all reported as "impossible to see in light mode" / "unreadable",
 * so the specs compute WCAG 2.1 ratios from the shipped declarations rather
 * than asserting on hand-picked colour literals.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    BLACK,
    WHITE,
    composite,
    contrastRatio,
    controlContrast,
    readDeclaration,
    type Rgb,
} from './uiContrast';

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

const learnerCss = read('src/styles/components/_learner.css');
const fixesCss = read('src/styles/fixes.css');
const mediaViewerCss = read('src/styles/components/_media_viewer.css');
const galleryComponent = read('src/features/components/PlayerGallery.vue');
const fullscreenCss = read('src/styles/components/_player_fullscreen.css');

/** Semantic palette from src/styles/variables.css. */
const THEMES = {
    light: {
        surface: WHITE,
        textSecondary: '#444444',
    },
    dark: {
        // --asmr-bg-primary resolves to --q-dark-page (#121212) in Quasar's dark mode.
        surface: [18, 18, 18] as Rgb,
        textSecondary: 'rgba(255, 255, 255, 0.9)',
    },
} as const;

/** WCAG 2.1: 4.5:1 for body text, 3:1 for UI components and large text. */
const TEXT_MIN = 4.5;
const CONTROL_MIN = 3;

function strokeColor(value: string): string {
    const match = /(rgba?\([^)]+\)|#[0-9a-f]{3,6})/i.exec(value);
    if (!match) throw new Error(`No colour in stroke declaration: ${value}`);
    return match[1];
}

describe('subtitle status and helper text', () => {
    it('keeps the "delayed transcription" label above the small-text floor in both themes', () => {
        // 0.68rem is small text, so it needs the full 4.5:1. The previous
        // opacity: 0.72 resolved it to #787878 on white — 4.40:1.
        const rule = /\.learner-whisper-delayed\s*\{([^}]*)\}/.exec(learnerCss);
        expect(rule).not.toBeNull();
        expect(rule?.[1]).not.toMatch(/(^|;)\s*opacity\s*:/);

        for (const theme of Object.values(THEMES)) {
            const text = composite(theme.textSecondary, theme.surface);
            expect(contrastRatio(text, theme.surface)).toBeGreaterThanOrEqual(TEXT_MIN);
        }
    });

    it('uses a quiet activity dot while keeping visible error copy theme-readable', () => {
        expect(readDeclaration(learnerCss, '.learner-whisper-activity-dot', 'background'))
            .toBe('var(--asmr-accent)');
        expect(readDeclaration(learnerCss, '.learner-whisper-activity--error', 'color'))
            .toBe('var(--asmr-text-primary)');
        expect(learnerCss).toContain('.learner-visually-hidden');
    });

    it('makes the "show full subtitles" control visible instead of a 2.7:1 ghost', () => {
        const opacity = Number(readDeclaration(learnerCss, '.learner-subtitle-expand', 'opacity'));
        expect(opacity).toBe(1);
        expect(readDeclaration(learnerCss, '.learner-subtitle-expand', 'background'))
            .toBe('transparent');

        for (const theme of Object.values(THEMES)) {
            expect(controlContrast({
                foreground: theme.textSecondary,
                background: 'transparent',
                backdrop: theme.surface,
                opacity,
            })).toBeGreaterThanOrEqual(CONTROL_MIN);
        }
    });
});

describe('legacy Whisper status overlay', () => {
    const scrim = readDeclaration(fixesCss, '.whisper-status--overlay', 'background');

    it('is legible over both light and dark artwork', () => {
        // It used var(--asmr-accent) (#7c4dff) on rgba(0,0,0,0.68): 1.6:1 over
        // a pale cover.
        const color = readDeclaration(fixesCss, '.whisper-loading-indicator', 'color');
        expect(color).toBe('#fff');

        for (const artwork of [WHITE, BLACK]) {
            expect(controlContrast({
                foreground: color,
                background: scrim,
                backdrop: artwork,
            })).toBeGreaterThanOrEqual(TEXT_MIN);
        }
    });

    it('tints the error indicator so it clears 4.5:1 on the same scrim', () => {
        const color = readDeclaration(
            fixesCss,
            '.whisper-status--overlay .whisper-error-indicator',
            'color',
        );
        for (const artwork of [WHITE, BLACK]) {
            expect(controlContrast({
                foreground: color,
                background: scrim,
                backdrop: artwork,
            })).toBeGreaterThanOrEqual(TEXT_MIN);
        }
    });

    it('reserves a compact slot rather than a 72px band under the artwork', () => {
        expect(readDeclaration(fixesCss, '.whisper-status--inline', 'height')).toBe('28px');
        expect(readDeclaration(fixesCss, '.whisper-status--inline', 'min-height')).toBe('28px');
    });
});

describe('gallery controls over arbitrary album artwork', () => {
    const scrim = readDeclaration(galleryComponent, '.asmr-gallery-nav', 'background');

    it('keeps transparent resting controls subdued but edged on pale artwork', () => {
        expect(scrim).toBe('transparent');
        expect(readDeclaration(galleryComponent, '.asmr-gallery-nav', 'opacity')).toBe('1');
        expect(readDeclaration(galleryComponent, '.asmr-gallery-nav', 'border'))
            .toBe('1px solid transparent');
        expect(readDeclaration(galleryComponent, '.asmr-gallery-nav', 'box-shadow'))
            .toBe('none');
        const glyphColor = readDeclaration(
            galleryComponent,
            '.asmr-gallery-nav :deep(.material-icons)',
            'color',
        );
        expect(readDeclaration(
            galleryComponent,
            '.asmr-gallery-nav :deep(.material-icons)',
            'opacity',
        )).toBe('1');
        const edgeColor = strokeColor(readDeclaration(
            galleryComponent,
            '.asmr-gallery-nav :deep(.material-icons)',
            '-webkit-text-stroke',
        ));

        expect(contrastRatio(composite(glyphColor, BLACK), BLACK))
            .toBeGreaterThanOrEqual(CONTROL_MIN);
        expect(contrastRatio(composite(edgeColor, WHITE), WHITE))
            .toBeGreaterThanOrEqual(CONTROL_MIN);
        expect(readDeclaration(galleryComponent, '.asmr-gallery-nav:hover', 'opacity')).toBe('1');
        expect(readDeclaration(galleryComponent, '.asmr-gallery-nav:focus-visible', 'opacity')).toBe('1');
    });

    it('keeps touch controls transparent while strengthening only the edged glyph', () => {
        expect(galleryComponent).toMatch(
            /@media \(hover: none\), \(pointer: coarse\)\s*\{[\s\S]*?\.asmr-gallery-nav\s*\{[^}]*background:\s*transparent;/,
        );
        expect(galleryComponent).toMatch(
            /@media \(hover: none\), \(pointer: coarse\)\s*\{[\s\S]*?\.asmr-gallery-nav :deep\(\.material-icons\)\s*\{[^}]*color:\s*rgba\(255, 255, 255, 0\.68\);[^}]*opacity:\s*1;/,
        );
        expect(fullscreenCss).toMatch(
            /@media \(hover: none\)\s*\{[\s\S]*?\.asmr-gallery-nav,[\s\S]*?\.asmr-gallery-slideshow-toggle,[\s\S]*?\.asmr-gallery-exclude\s*\{[^}]*background:\s*transparent\s*!important;/,
        );
    });

    it('keeps the engaged nav glyph legible on white and black covers', () => {
        const engagedScrim = readDeclaration(galleryComponent, '.asmr-gallery-nav:hover', 'background');
        for (const artwork of [WHITE, BLACK]) {
            expect(controlContrast({
                foreground: '#fff',
                background: engagedScrim,
                backdrop: artwork,
                opacity: 1,
            })).toBeGreaterThanOrEqual(TEXT_MIN);
        }
    });

    it('uses a dark hover scrim rather than a translucent-white wash', () => {
        expect(readDeclaration(galleryComponent, '.asmr-gallery-nav:hover', 'background'))
            .toBe('rgba(17, 24, 39, 0.78)');
    });

    it('lets slideshow and exclude controls inherit the same edged glyph without a resting surface', () => {
        for (const selector of [
            '.asmr-gallery-slideshow-toggle',
            '.asmr-gallery-exclude',
        ]) {
            expect(readDeclaration(galleryComponent, selector, 'background')).toBe('transparent');
            expect(readDeclaration(galleryComponent, selector, 'border-color')).toBe('transparent');
        }

        for (const selector of [
            '.asmr-gallery-slideshow-toggle :deep(.material-icons)',
            '.asmr-gallery-exclude :deep(.material-icons)',
        ]) {
            const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const rule = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(galleryComponent)?.[1] ?? '';
            expect(rule).not.toMatch(/(?:^|;)\s*(?:color|opacity|-webkit-text-stroke)\s*:/);
        }
    });

    it('never reintroduces a translucent-white hover state that washes the glyph out', () => {
        expect(galleryComponent).not.toContain('background: rgba(255, 255, 255, 0.15)');
        expect(fullscreenCss).not.toContain('background: rgba(255, 255, 255, 0.15) !important');
    });

    it('keeps every gallery control at a 44px touch target', () => {
        for (const selector of [
            '.asmr-gallery-nav',
            '.asmr-gallery-slideshow-toggle',
            '.asmr-gallery-exclude',
        ]) {
            expect(readDeclaration(galleryComponent, selector, 'width')).toBe('44px');
            expect(readDeclaration(galleryComponent, selector, 'height')).toBe('44px');
        }
    });

    it('keeps the fullscreen control quiet at rest and fully legible when engaged', () => {
        expect(readDeclaration(fullscreenCss, '.audio-player .asmr-fullscreen-btn', 'background'))
            .toBe('transparent');
        expect(readDeclaration(fullscreenCss, '.audio-player .asmr-fullscreen-btn', 'opacity'))
            .toBe('1');
        expect(readDeclaration(fullscreenCss, '.audio-player .asmr-fullscreen-btn', 'border'))
            .toBe('1px solid transparent');
        expect(readDeclaration(fullscreenCss, '.audio-player .asmr-fullscreen-btn', 'box-shadow'))
            .toBe('none');
        const glyphColor = readDeclaration(
            fullscreenCss,
            '.audio-player .asmr-fullscreen-btn .material-icons',
            'color',
        );
        expect(readDeclaration(
            fullscreenCss,
            '.audio-player .asmr-fullscreen-btn .material-icons',
            'opacity',
        )).toBe('1');
        const edgeColor = strokeColor(readDeclaration(
            fullscreenCss,
            '.audio-player .asmr-fullscreen-btn .material-icons',
            '-webkit-text-stroke',
        ));
        expect(contrastRatio(composite(glyphColor, BLACK), BLACK))
            .toBeGreaterThanOrEqual(CONTROL_MIN);
        expect(contrastRatio(composite(edgeColor, WHITE), WHITE))
            .toBeGreaterThanOrEqual(CONTROL_MIN);
        expect(readDeclaration(
            fullscreenCss,
            '.audio-player .asmr-fullscreen-btn:focus-visible',
            'opacity',
        )).toBe('1');
    });

    it('keeps fullscreen delayed and upcoming copy readable on the dark media surface', () => {
        const surfaces: Rgb[] = [BLACK, [51, 51, 51]];
        for (const selector of [
            '.audio-player.asmr-player-fullscreen .karaoke-upcoming',
            '.audio-player.asmr-player-fullscreen .learner-whisper-delayed',
        ]) {
            const color = readDeclaration(fullscreenCss, selector, 'color');
            for (const surface of surfaces) {
                expect(contrastRatio(composite(color, surface), surface))
                    .toBeGreaterThanOrEqual(TEXT_MIN);
            }
        }
    });
});

describe('media lightbox', () => {
    it('keeps header text and error copy above 4.5:1 on the modal backdrop', () => {
        const backdrop = composite(
            readDeclaration(mediaViewerCss, '.media-viewer-modal', 'background'),
            BLACK,
        );
        for (const selector of ['.media-viewer-counter', '.media-viewer-title', '.media-viewer-error']) {
            const color = readDeclaration(mediaViewerCss, selector, 'color');
            expect(contrastRatio(composite(color, backdrop), backdrop))
                .toBeGreaterThanOrEqual(TEXT_MIN);
        }
    });

    it('keeps the download-failure copy comfortably legible, not a grey smudge', () => {
        // "Failed to download this media file" is the only place the lightbox
        // renders the word "download" as copy, and it was reported unreadable.
        const backdrop = composite(
            readDeclaration(mediaViewerCss, '.media-viewer-modal', 'background'),
            BLACK,
        );
        const color = readDeclaration(mediaViewerCss, '.media-viewer-error', 'color');
        expect(contrastRatio(composite(color, backdrop), backdrop)).toBeGreaterThanOrEqual(12);

        const iconOpacity = Number(
            readDeclaration(mediaViewerCss, '.media-viewer-error .material-icons', 'opacity'),
        );
        expect(controlContrast({
            foreground: color,
            background: 'transparent',
            backdrop,
            opacity: iconOpacity,
        })).toBeGreaterThanOrEqual(CONTROL_MIN);
    });

    it('keeps the download and other action glyphs above the control floor', () => {
        const backdrop = composite(
            readDeclaration(mediaViewerCss, '.media-viewer-modal', 'background'),
            BLACK,
        );
        expect(controlContrast({
            foreground: readDeclaration(mediaViewerCss, '.media-viewer-action', 'color'),
            background: readDeclaration(mediaViewerCss, '.media-viewer-action', 'background'),
            backdrop,
        })).toBeGreaterThanOrEqual(CONTROL_MIN);
    });
});
