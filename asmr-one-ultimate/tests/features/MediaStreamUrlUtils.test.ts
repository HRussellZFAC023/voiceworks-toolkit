import { describe, expect, it } from 'vitest';
import {
    buildMediaDownloadUrl,
    buildMediaPathFromHash,
    buildMediaStreamUrl,
    resolveMediaApiBaseUrl,
} from '../../src/features/media/mediaStreamUrlUtils';

const DEFAULT_API = 'https://api.asmr-200.com';

describe('mediaStreamUrlUtils', () => {
    it('builds an absolute public API stream URL for opaque hash segments', () => {
        expect(buildMediaStreamUrl('abc123', undefined, 'jwt'))
            .toBe(`${DEFAULT_API}/api/media/stream/abc123`);
        expect(buildMediaStreamUrl('1052162/319502', undefined, 'jwt'))
            .toBe(`${DEFAULT_API}/api/media/stream/1052162/319502`);
        expect(buildMediaStreamUrl('作品 1/画像.jpg', undefined, 'jwt'))
            .toBe(`${DEFAULT_API}/api/media/stream/%E4%BD%9C%E5%93%81%201/%E7%94%BB%E5%83%8F.jpg`);
    });

    it('keeps hash separators intact when building host-relative media paths', () => {
        // `<workId>/<trackIndex>` hashes must not collapse into a single
        // percent-encoded segment: `%2F` is rejected by the host-API URL guards
        // that native subtitle discovery relies on.
        expect(buildMediaPathFromHash('12345/7', 'stream')).toBe('/api/media/stream/12345/7');
        expect(buildMediaPathFromHash('opaque-hash', 'stream')).toBe('/api/media/stream/opaque-hash');
        expect(buildMediaPathFromHash('12345/7', 'download')).toBe('/api/media/download/12345/7');
        expect(buildMediaPathFromHash('作品 1/画像.jpg', 'stream'))
            .toBe('/api/media/stream/%E4%BD%9C%E5%93%81%201/%E7%94%BB%E5%83%8F.jpg');
        expect(buildMediaPathFromHash('12345/7', 'stream')).not.toContain('%2F');

        for (const unsafe of [
            '',
            '../secret',
            '12345/../../admin',
            '%2e%2e/secret',
            'safe/%2fetc',
            'safe//image',
            '/leading',
            'trailing/',
            'safe\\image',
            'safe?token=bad',
            'safe#fragment',
        ]) {
            expect(buildMediaPathFromHash(unsafe, 'stream')).toBe('');
        }
    });

    it('canonicalizes both media stream path forms onto the selected API origin', () => {
        const apiBase = resolveMediaApiBaseUrl('https://api.asmr-100.com/v1');
        expect(buildMediaStreamUrl(
            'unused',
            { mediaStreamUrl: '/media/stream/abc123' },
            'jwt',
            apiBase,
        )).toBe('https://api.asmr-100.com/api/media/stream/abc123');
        expect(buildMediaStreamUrl(
            'unused',
            { media_stream_url: '/api/media/stream/abc123' },
            'jwt',
            apiBase,
        )).toBe('https://api.asmr-100.com/api/media/stream/abc123');
        expect(buildMediaStreamUrl(
            'unused',
            { mediaStreamUrl: 'media/stream/abc123' },
            'jwt',
            apiBase,
        )).toBe('https://api.asmr-100.com/api/media/stream/abc123');
    });

    it('rewrites frontend media routes instead of requesting the gated SPA origin', () => {
        const apiBase = 'https://api.asmr-300.com';
        expect(buildMediaStreamUrl(
            'unused',
            { mediaStreamUrl: 'https://asmr.one/api/media/stream/1052162/319502' },
            '',
            apiBase,
        )).toBe('https://api.asmr-300.com/api/media/stream/1052162/319502');
        expect(buildMediaStreamUrl(
            'unused',
            { mediaStreamUrl: 'https://www.asmr.one/media/stream/x' },
            '',
            apiBase,
        )).toBe('https://api.asmr-300.com/api/media/stream/x');
    });

    it('does not let frontend-root placeholders override a valid stream hash', () => {
        const apiBase = 'https://api.asmr-100.com';
        for (const source of [
            '/',
            '/?source=work-tree#gallery',
            'https://asmr.one',
            'https://www.asmr.one/?source=work-tree#gallery',
        ]) {
            expect(buildMediaStreamUrl(
                '1052162/319495',
                { mediaStreamUrl: source },
                '',
                apiBase,
            )).toBe('https://api.asmr-100.com/api/media/stream/1052162/319495');
        }
    });

    it('uses an exact API host allowlist and rejects deceptive hosts', () => {
        for (const accepted of [
            'https://api.asmr.one/api',
            'https://api.asmr-100.com',
            'https://api.asmr-200.com/v1',
            'https://api.asmr-300.com/',
        ]) {
            expect(resolveMediaApiBaseUrl(accepted)).toBe(new URL(accepted).origin);
        }

        for (const rejected of [
            'https://api.asmr-999.com',
            'https://asmr.com',
            'https://www.asmr-999.one',
            'https://api.asmr-200.com.attacker.example',
            'http://api.asmr-200.com',
            'https://attacker.example',
        ]) {
            expect(resolveMediaApiBaseUrl(rejected)).toBe(DEFAULT_API);
        }
    });

    it('never adds the host JWT to public, raw, or external media URLs', () => {
        expect(buildMediaStreamUrl(
            'x',
            { mediaStreamUrl: '/api/media/stream/x?token=old&quality=full#page=2' },
            'local-jwt',
            'https://api.asmr-100.com',
        )).toBe('https://api.asmr-100.com/api/media/stream/x?quality=full#page=2');
        expect(buildMediaStreamUrl(
            'x',
            { mediaStreamUrl: 'https://raw.kiko-play-niptan.one/file.jpg' },
            'local-jwt',
        )).toBe('https://raw.kiko-play-niptan.one/file.jpg');
        expect(buildMediaStreamUrl(
            'x',
            { mediaStreamUrl: 'https://cdn.example.com/file.jpg?signature=abc' },
            'local-jwt',
        )).toBe('https://cdn.example.com/file.jpg?signature=abc');
        expect(buildMediaStreamUrl('x', { mediaStreamUrl: 'blob:abc' }, 'local-jwt'))
            .toBe('blob:abc');
    });

    it('preserves non-media absolute sources without granting them credentials', () => {
        expect(buildMediaStreamUrl(
            'x',
            { mediaStreamUrl: 'https://attacker.example/api/media/stream/x' },
            'local-jwt',
        )).toBe('https://attacker.example/api/media/stream/x');
        expect(buildMediaStreamUrl(
            'x',
            { mediaStreamUrl: 'https://asmr.one/statics/icons/favicon.png' },
            'local-jwt',
        )).toBe('https://asmr.one/statics/icons/favicon.png');
        expect(buildMediaStreamUrl(
            'x',
            { mediaStreamUrl: 'https://cdn.example.com/' },
            'local-jwt',
        )).toBe('https://cdn.example.com/');
    });

    it('rejects traversal, encoded separators, empty segments, and controls in hashes', () => {
        for (const hash of [
            '',
            '../secret',
            '1052162/../../admin',
            '%2e%2e/secret',
            '%252e%252e/secret',
            '%2525252e%2525252e/secret',
            `${'%25'.repeat(17)}2e/secret`,
            'safe/%2fetc',
            'safe//image',
            '/leading',
            'trailing/',
            'safe\\image',
            'safe?token=bad',
            'safe#fragment',
            'safe\u0000image',
        ]) {
            expect(buildMediaStreamUrl(hash, undefined, 'local-jwt')).toBe('');
        }
    });

    it('rejects unsafe stream paths before URL normalization', () => {
        for (const source of [
            '/api/media/stream/../admin',
            '/api/media/stream/%2e%2e/admin',
            'https://asmr.one/api/media/stream/safe/%2fadmin',
            'https://api.asmr-200.com/media/stream/safe//image',
        ]) {
            expect(buildMediaStreamUrl('', { mediaStreamUrl: source }, 'local-jwt')).toBe('');
        }
    });

    it('falls back to a safe hash for executable and local-file source protocols', () => {
        for (const source of [
            'javascript:alert(1)',
            ' \n\tjavascript:alert(1)',
            'java\tscript:alert(1)',
            'data:text/html,<script>alert(1)</script>',
            'file:///tmp/audio.wav',
        ]) {
            expect(buildMediaStreamUrl('safe-hash', { mediaStreamUrl: source }, 'jwt'))
                .toBe(`${DEFAULT_API}/api/media/stream/safe-hash`);
        }
    });

    it('builds safe public download URLs without disclosing the local JWT', () => {
        expect(buildMediaDownloadUrl(
            '1052162/319502',
            undefined,
            'local-jwt',
            'https://api.asmr-100.com',
        )).toBe('https://api.asmr-100.com/api/media/download/1052162/319502');
        expect(buildMediaDownloadUrl(
            'unused',
            {
                mediaDownloadUrl:
                    'https://raw.kiko-play-niptan.one/file.jpg?signature=keep',
            },
            'local-jwt',
        )).toBe('https://raw.kiko-play-niptan.one/file.jpg?signature=keep');
        expect(buildMediaDownloadUrl(
            'unused',
            { media_download_url: 'https://asmr.one/media/download/file?token=old' },
            'local-jwt',
            'https://api.asmr-300.com',
        )).toBe('https://api.asmr-300.com/api/media/download/file');
        expect(buildMediaDownloadUrl(
            '1052162/319495',
            { mediaDownloadUrl: 'https://asmr.one/' },
            'local-jwt',
            'https://api.asmr-100.com',
        )).toBe('https://api.asmr-100.com/api/media/download/1052162/319495');
        expect(buildMediaDownloadUrl(
            'unused',
            { mediaDownloadUrl: 'https://cdn.example.com/' },
            'local-jwt',
        )).toBe('https://cdn.example.com/');
    });

    it('rejects unsafe download sources and invalid fallback hashes', () => {
        expect(buildMediaDownloadUrl(
            '../secret',
            { mediaDownloadUrl: 'javascript:alert(1)' },
            'local-jwt',
        )).toBe('');
        expect(buildMediaDownloadUrl(
            'safe',
            { mediaDownloadUrl: 'http://attacker.example/file.jpg' },
            'local-jwt',
        )).toBe(`${DEFAULT_API}/api/media/download/safe`);
    });
});
