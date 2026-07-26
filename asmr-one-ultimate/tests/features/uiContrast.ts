/**
 * Minimal WCAG 2.1 contrast helpers.
 *
 * The player, subtitle and gallery surfaces sit on top of album artwork whose
 * colour we do not control, so "does this look OK" is not a check we can make
 * by eye. These helpers let the specs assert the two worst cases explicitly:
 * pure white artwork and pure black artwork.
 */

export type Rgb = readonly [number, number, number];

export const WHITE: Rgb = [255, 255, 255];
export const BLACK: Rgb = [0, 0, 0];

/** Parse `#rgb`, `#rrggbb`, `rgb(...)` or `rgba(...)`; alpha is returned separately. */
const NAMED_COLORS: Record<string, { rgb: Rgb; alpha: number }> = {
    transparent: { rgb: BLACK, alpha: 0 },
    white: { rgb: WHITE, alpha: 1 },
    black: { rgb: BLACK, alpha: 1 },
};

export function parseColor(value: string): { rgb: Rgb; alpha: number } {
    const text = value.trim();

    const named = NAMED_COLORS[text.toLowerCase()];
    if (named) return named;

    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
    if (hex) {
        const digits = hex[1].length === 3
            ? hex[1].split('').map(char => char + char).join('')
            : hex[1];
        return {
            rgb: [
                parseInt(digits.slice(0, 2), 16),
                parseInt(digits.slice(2, 4), 16),
                parseInt(digits.slice(4, 6), 16),
            ],
            alpha: 1,
        };
    }

    const fn = /^rgba?\(([^)]+)\)$/i.exec(text);
    if (!fn) throw new Error(`Unsupported colour: ${value}`);
    const parts = fn[1].split(/[,/]/).map(part => Number(part.trim()));
    if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) {
        throw new Error(`Unsupported colour: ${value}`);
    }
    return {
        rgb: [parts[0], parts[1], parts[2]],
        alpha: parts.length > 3 && !Number.isNaN(parts[3]) ? parts[3] : 1,
    };
}

/** Composite `source` (which may be translucent) over an opaque `backdrop`. */
export function composite(source: string, backdrop: Rgb): Rgb {
    const { rgb, alpha } = parseColor(source);
    return [
        rgb[0] * alpha + backdrop[0] * (1 - alpha),
        rgb[1] * alpha + backdrop[1] * (1 - alpha),
        rgb[2] * alpha + backdrop[2] * (1 - alpha),
    ];
}

/** Apply a CSS `opacity` to an already-composited layer. */
export function fade(layer: Rgb, opacity: number, backdrop: Rgb): Rgb {
    return [
        layer[0] * opacity + backdrop[0] * (1 - opacity),
        layer[1] * opacity + backdrop[1] * (1 - opacity),
        layer[2] * opacity + backdrop[2] * (1 - opacity),
    ];
}

function relativeLuminance([r, g, b]: Rgb): number {
    const channel = (raw: number): number => {
        const value = raw / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
    const [light, dark] = [relativeLuminance(a), relativeLuminance(b)]
        .sort((x, y) => y - x);
    return (light + 0.05) / (dark + 0.05);
}

/**
 * Contrast of `foreground` painted on `background`, where `background` may be
 * translucent over an arbitrary `backdrop` and the whole control may carry a
 * CSS `opacity`. Both layers fade towards the backdrop together, which is
 * exactly why element opacity cannot be used to make a control "quiet".
 */
export function controlContrast(options: {
    foreground: string;
    background: string;
    backdrop: Rgb;
    opacity?: number;
}): number {
    const opacity = options.opacity ?? 1;
    const bg = composite(options.background, options.backdrop);
    const fg = composite(options.foreground, bg);
    return contrastRatio(
        fade(fg, opacity, options.backdrop),
        fade(bg, opacity, options.backdrop),
    );
}

/** Read a single declaration out of the first rule whose selector text matches. */
export function readDeclaration(
    css: string,
    selector: string,
    property: string,
): string {
    const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rule = new RegExp(`(?:^|[,{}])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(source);
    if (!rule) throw new Error(`No rule found for selector ${selector}`);
    const declaration = new RegExp(`(?:^|[;{\\n])\\s*${property}\\s*:\\s*([^;\\n]+)`, 'i')
        .exec(rule[1]);
    if (!declaration) {
        throw new Error(`No ${property} declaration in rule for ${selector}`);
    }
    return declaration[1].replace(/!important/i, '').trim();
}
