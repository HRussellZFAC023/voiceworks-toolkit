import { describe, expect, it } from 'vitest';
import { mergeAudioMetadata } from '../../src/features/downloads/MetadataPolicy';

const oldArt = { mimeType: 'image/jpeg', data: new Uint8Array([1]) };
const newArt = { mimeType: 'image/png', data: new Uint8Array([2]) };

describe('mergeAudioMetadata', () => {
    it('additive mode preserves existing fields/artwork and fills missing fields', () => {
        const result = mergeAudioMetadata({
            sourceTags: { TITLE: 'Original title', custom_private: 'keep' },
            generatedTags: { title: 'Translated title', album: 'Work album' },
            sourceArtwork: [oldArt], generatedArtwork: newArt, policy: 'additive', includeArtwork: true,
        });
        expect(result.tags).toMatchObject({ TITLE: 'Original title', album: 'Work album', custom_private: 'keep' });
        expect(result.artwork).toEqual([oldArt]);
    });

    it('overwrite mode replaces managed fields and artwork but preserves unknown tags', () => {
        const result = mergeAudioMetadata({
            sourceTags: { TITLE: 'Old', artist: 'Old artist', custom_private: 'keep' },
            generatedTags: { title: 'Canonical' },
            sourceArtwork: [oldArt], generatedArtwork: newArt, policy: 'overwrite', includeArtwork: true,
        });
        expect(result.tags).toEqual({ title: 'Canonical', custom_private: 'keep' });
        expect(result.artwork).toEqual([newArt]);
    });

    it('retains source artwork when no replacement is available', () => {
        const result = mergeAudioMetadata({
            sourceTags: {}, generatedTags: {}, sourceArtwork: [oldArt],
            policy: 'overwrite', includeArtwork: true,
        });
        expect(result.artwork).toEqual([oldArt]);
    });

    it('fills whitespace and empty-array fields in additive mode', () => {
        const result = mergeAudioMetadata({
            sourceTags: { title: '   ', artist: [] }, generatedTags: { title: 'Title', artist: ['VA'] },
            policy: 'additive', includeArtwork: true,
        });
        expect(result.tags).toMatchObject({ title: 'Title', artist: ['VA'] });
    });

    it('treats common container tag aliases as the same managed field', () => {
        const additive = mergeAudioMetadata({
            sourceTags: { album_artist: 'Source circle' }, generatedTags: { albumartist: 'Generated circle' },
            policy: 'additive', includeArtwork: true,
        });
        expect(additive.tags).toEqual({ album_artist: 'Source circle' });
        const overwrite = mergeAudioMetadata({
            sourceTags: { album_artist: 'Source circle', track: '9' },
            generatedTags: { albumartist: 'Generated circle', tracknumber: '1' },
            policy: 'overwrite', includeArtwork: true,
        });
        expect(overwrite.tags).toEqual({ albumartist: 'Generated circle', tracknumber: '1' });
    });
});
