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
    const opacity = Number(readDeclaration(galleryComponent, '.asmr-gallery-nav', 'opacity'));

    it('keeps the resting surface transparent without fading its dual-tone glyph', () => {
        expect(scrim).toBe('transparent');
        expect(opacity).toBe(1);
        expect(readDeclaration(
            galleryComponent,
            '.asmr-gallery-nav :deep(.material-icons)',
            '-webkit-text-stroke',
        )).toBe('1px rgba(0, 0, 0, 0.92)');
        expect(readDeclaration(galleryComponent, '.asmr-gallery-nav:hover', 'opacity')).toBe('1');
        expect(readDeclaration(galleryComponent, '.asmr-gallery-nav:focus-visible', 'opacity')).toBe('1');
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

    it('keeps the fullscreen glyph dual-tone while its resting surface is transparent', () => {
        expect(readDeclaration(fullscreenCss, '.audio-player .asmr-fullscreen-btn', 'background'))
            .toBe('transparent');
        expect(readDeclaration(fullscreenCss, '.audio-player .asmr-fullscreen-btn', 'opacity'))
            .toBe('1');
        expect(readDeclaration(
            fullscreenCss,
            '.audio-player .asmr-fullscreen-btn .material-icons',
            '-webkit-text-stroke',
        )).toBe('1px rgba(0, 0, 0, 0.92)');
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
