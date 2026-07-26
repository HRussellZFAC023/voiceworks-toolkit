/**
 * Host session token access.
 *
 * The Kikoeru host persists its JWT through Quasar's LocalStorage plugin, which
 * writes a type-tagged value rather than the bare string — `jwt-token` reads
 * back as `__q_strn|eyJhbGciOi...`. Passing that through verbatim produces
 * `Authorization: Bearer __q_strn|eyJ...`, which every authenticated endpoint
 * rejects, so any caller reading localStorage directly must normalise it first.
 */

/** Quasar LocalStorage type tags: `__q_strn|`, `__q_objt|`, `__q_date|`, etc. */
const QUASAR_TYPE_TAG = /^__q_[a-z]{4}\|/;

/** A JWT is three base64url segments; anything else is not usable as a bearer. */
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/**
 * Strip Quasar's type tag and surrounding quotes/whitespace from a stored token.
 * Returns '' when nothing usable remains.
 */
export function normalizeHostAuthToken(raw: unknown): string {
    let token = String(raw ?? '').trim();
    if (!token) return '';
    if (QUASAR_TYPE_TAG.test(token)) token = token.slice(token.indexOf('|') + 1).trim();
    // Some host builds JSON-encode the value, leaving literal quotes behind.
    if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
        token = token.slice(1, -1).trim();
    }
    // Reject anything with characters that cannot appear in an HTTP header
    // value, so a corrupted entry can never produce a malformed request.
    if (!token || /[^\x21-\x7e]/.test(token)) return '';
    return token;
}

/** Read the host session token from localStorage, normalised. */
export function readHostAuthToken(): string {
    try {
        return normalizeHostAuthToken(globalThis.localStorage?.getItem('jwt-token'));
    } catch {
        return '';
    }
}

/** True when the token at least has JWT shape (cheap sanity check, not validation). */
export function looksLikeJwt(token: string): boolean {
    return JWT_SHAPE.test(token);
}
