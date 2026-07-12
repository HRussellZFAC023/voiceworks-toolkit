export interface SafeHtmlOptions {
    allowImages?: boolean;
}

const TEXT_TAGS = new Set([
    'A', 'BR', 'STRONG', 'EM', 'B', 'I',
    'P', 'DIV', 'SPAN', 'UL', 'OL', 'LI', 'BLOCKQUOTE',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
]);

function escapeHtmlFallback(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

export function toSafeHttpUrl(value: string): string | null {
    try {
        const base = globalThis.location?.href || 'https://invalid.local/';
        const parsed = new URL(value, base);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
    } catch {
        return null;
    }
}

/**
 * Sanitize the small HTML subset used by scraped DLsite content.
 * Unknown elements are unwrapped so their text survives. Attributes are
 * removed, then safe link/image attributes are rebuilt from scratch.
 */
export function sanitizeAllowedHtml(html: string, options: SafeHtmlOptions = {}): string {
    if (typeof document === 'undefined') return escapeHtmlFallback(html);

    const template = document.createElement('template');
    template.innerHTML = html;
    const elements = Array.from(template.content.querySelectorAll('*')).reverse();
    for (const element of elements) {
        const isImage = element.tagName === 'IMG' && options.allowImages === true;
        if (!TEXT_TAGS.has(element.tagName) && !isImage) {
            element.replaceWith(...Array.from(element.childNodes));
            continue;
        }

        if (element.tagName === 'A') {
            const href = toSafeHttpUrl(element.getAttribute('href') || '');
            if (!href) {
                element.replaceWith(...Array.from(element.childNodes));
                continue;
            }
            Array.from(element.attributes).forEach(attribute => element.removeAttribute(attribute.name));
            element.setAttribute('href', href);
            element.setAttribute('target', '_blank');
            element.setAttribute('rel', 'noopener noreferrer');
            continue;
        }

        if (isImage) {
            const src = toSafeHttpUrl(element.getAttribute('src') || '');
            if (!src) {
                element.remove();
                continue;
            }
            const alt = element.getAttribute('alt') || '';
            Array.from(element.attributes).forEach(attribute => element.removeAttribute(attribute.name));
            element.setAttribute('src', src);
            element.setAttribute('alt', alt);
            element.setAttribute('loading', 'lazy');
            element.setAttribute('referrerpolicy', 'no-referrer');
            continue;
        }

        Array.from(element.attributes).forEach(attribute => element.removeAttribute(attribute.name));
    }

    return template.innerHTML;
}
