import { describe, expect, it } from 'vitest';
import {
    DEFAULT_DOWNLOAD_PROFILE,
    categoryIsEnabled,
    createDownloadProfile,
} from '../../src/features/downloads/DownloadDomain';

describe('download profiles', () => {
    it('defaults to safe additive metadata and preserves metadata/artwork through Opus', () => {
        const profile = createDownloadProfile('zh-CN');

        expect(profile.targetLanguage).toBe('zh-CN');
        expect(profile.titleMode).toBe('original-bracketed-translation');
        expect(profile.metadata).toMatchObject({
            writePolicy: 'additive',
            includeArtwork: true,
            preserveSourceMetadata: true,
        });
        expect(profile.opus).toMatchObject({
            enabled: false,
            preserveSourceMetadata: true,
            embedArtwork: true,
        });
        expect(categoryIsEnabled('audio', profile.filters)).toBe(true);
        expect(categoryIsEnabled('video', profile.filters)).toBe(false);
    });

    it('creates independent profiles and permits explicit consistency overwrites', () => {
        const profile = createDownloadProfile('cn', {
            titleMode: 'translated',
            metadata: { writePolicy: 'overwrite' },
            opus: { enabled: true, bitrateKbps: 96 },
            filters: { video: true },
        });

        expect(profile).toMatchObject({
            targetLanguage: 'cn',
            titleMode: 'translated',
            metadata: { writePolicy: 'overwrite' },
            opus: { enabled: true, bitrateKbps: 96 },
            filters: { video: true },
        });
        expect(DEFAULT_DOWNLOAD_PROFILE.metadata.writePolicy).toBe('additive');
        expect(DEFAULT_DOWNLOAD_PROFILE.opus.enabled).toBe(false);
    });

    it('normalizes invalid encoder bitrates at the profile boundary', () => {
        expect(createDownloadProfile('en', { opus: { bitrateKbps: -1 } }).opus.bitrateKbps).toBe(16);
        expect(createDownloadProfile('en', { opus: { bitrateKbps: 999 } }).opus.bitrateKbps).toBe(256);
        expect(createDownloadProfile('en', { opus: { bitrateKbps: Number.NaN } }).opus.bitrateKbps).toBe(64);
    });
});
