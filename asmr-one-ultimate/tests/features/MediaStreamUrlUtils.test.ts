import { describe, expect, it } from 'vitest';
import { buildMediaStreamUrl } from '../../src/features/media/mediaStreamUrlUtils';

describe('mediaStreamUrlUtils', () => {
    it('builds default api stream url for hash ids', () => {
        expect(buildMediaStreamUrl('abc123', undefined, 'jwt'))
            .toBe('/api/media/stream/abc123?token=jwt');
    });

    it('supports media/stream paths and appends token', () => {
        expect(buildMediaStreamUrl('/media/stream/abc123', undefined, 'jwt'))
            .toBe('/media/stream/abc123?token=jwt');
        expect(buildMediaStreamUrl('media/stream/abc123', undefined, 'jwt'))
            .toBe('/media/stream/abc123?token=jwt');
    });

    it('uses mediaStreamUrl/media_stream_url source fields when present', () => {
        expect(buildMediaStreamUrl('x', { mediaStreamUrl: '/api/media/stream/x' }, 'jwt'))
            .toBe('/api/media/stream/x?token=jwt');
        expect(buildMediaStreamUrl('x', { media_stream_url: '/media/stream/x' }, 'jwt'))
            .toBe('/media/stream/x?token=jwt');
    });

    it('does not append token to external or blob urls', () => {
        expect(buildMediaStreamUrl('x', { mediaStreamUrl: 'https://cdn.example.com/file.jpg' }, 'jwt'))
            .toBe('https://cdn.example.com/file.jpg');
        expect(buildMediaStreamUrl('x', { mediaStreamUrl: 'blob:abc' }, 'jwt'))
            .toBe('blob:abc');
    });

    it('appends token for same-origin absolute api/media stream urls', () => {
        expect(buildMediaStreamUrl('x', { mediaStreamUrl: 'https://asmr.one/api/media/stream/x' }, 'jwt'))
            .toBe('https://asmr.one/api/media/stream/x?token=jwt');
        expect(buildMediaStreamUrl('x', { mediaStreamUrl: 'https://asmr.one/media/stream/x' }, 'jwt'))
            .toBe('https://asmr.one/media/stream/x?token=jwt');
    });

    it('preserves hash fragment when appending token', () => {
        expect(buildMediaStreamUrl('x', { mediaStreamUrl: '/api/media/stream/x#page=2' }, 'jwt'))
            .toBe('/api/media/stream/x?token=jwt#page=2');
    });

    it('does not duplicate token query if already present', () => {
        expect(buildMediaStreamUrl('x', { mediaStreamUrl: '/api/media/stream/x?token=old' }, 'new'))
            .toBe('/api/media/stream/x?token=old');
    });

    it('rejects executable and local-file source protocols', () => {
        for (const source of [
            'javascript:alert(1)',
            ' \n\tjavascript:alert(1)',
            'java\tscript:alert(1)',
            'data:text/html,<script>alert(1)</script>',
            'file:///tmp/audio.wav',
        ]) {
            expect(buildMediaStreamUrl('safe-hash', { mediaStreamUrl: source }, 'jwt'))
                .toBe('/api/media/stream/safe-hash?token=jwt');
        }
    });
});
