import { afterEach, describe, expect, it, vi } from 'vitest';
import { looksLikeJwt, normalizeHostAuthToken, readHostAuthToken } from '../../src/core/hostAuthToken';

const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJIZXJvU2xheWVyIn0.BLTIbKG5Lt9uEFCtCj7HSYqAvN';

describe('normalizeHostAuthToken', () => {
    it('strips the Quasar LocalStorage type tag', () => {
        // The host persists the JWT through Quasar's LocalStorage plugin, so the
        // raw value is type-tagged. Passing it through verbatim produced
        // `Authorization: Bearer __q_strn|eyJ...`, which every authenticated
        // media and playlist endpoint rejects.
        expect(normalizeHostAuthToken(`__q_strn|${JWT}`)).toBe(JWT);
    });

    it('strips other Quasar type tags', () => {
        expect(normalizeHostAuthToken(`__q_objt|${JWT}`)).toBe(JWT);
        expect(normalizeHostAuthToken(`__q_date|${JWT}`)).toBe(JWT);
    });

    it('passes an untagged token through unchanged', () => {
        expect(normalizeHostAuthToken(JWT)).toBe(JWT);
    });

    it('unwraps a JSON-encoded value', () => {
        expect(normalizeHostAuthToken(`"${JWT}"`)).toBe(JWT);
        expect(normalizeHostAuthToken(`__q_strn|"${JWT}"`)).toBe(JWT);
    });

    it('trims surrounding whitespace', () => {
        expect(normalizeHostAuthToken(`  __q_strn|${JWT}  `)).toBe(JWT);
    });

    it('rejects empty and non-string input', () => {
        expect(normalizeHostAuthToken('')).toBe('');
        expect(normalizeHostAuthToken(null)).toBe('');
        expect(normalizeHostAuthToken(undefined)).toBe('');
        expect(normalizeHostAuthToken('__q_strn|')).toBe('');
    });

    it('rejects values that cannot appear in an HTTP header', () => {
        // A corrupted entry must never be able to produce a malformed request.
        expect(normalizeHostAuthToken('abc\ndef')).toBe('');
        expect(normalizeHostAuthToken('abc def')).toBe('');
        expect(normalizeHostAuthToken('トークン')).toBe('');
    });
});

describe('readHostAuthToken', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('reads and normalizes the host session token', () => {
        vi.stubGlobal('localStorage', {
            getItem: (k: string) => (k === 'jwt-token' ? `__q_strn|${JWT}` : null),
        });
        expect(readHostAuthToken()).toBe(JWT);
    });

    it('returns empty when localStorage throws', () => {
        vi.stubGlobal('localStorage', {
            getItem: () => { throw new Error('blocked by privacy settings'); },
        });
        expect(readHostAuthToken()).toBe('');
    });

    it('returns empty when no token is stored', () => {
        vi.stubGlobal('localStorage', { getItem: () => null });
        expect(readHostAuthToken()).toBe('');
    });
});

describe('looksLikeJwt', () => {
    it('accepts a three-segment base64url token', () => {
        expect(looksLikeJwt(JWT)).toBe(true);
    });

    it('rejects a Quasar-tagged token, which is the exact shape that was being sent', () => {
        expect(looksLikeJwt(`__q_strn|${JWT}`)).toBe(false);
    });
});
