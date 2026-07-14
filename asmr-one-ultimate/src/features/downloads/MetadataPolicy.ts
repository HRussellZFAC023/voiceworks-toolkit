import type { MetadataWritePolicy } from './DownloadDomain';

export type AudioTagValue = string | string[];
export type AudioTags = Record<string, AudioTagValue>;

export interface EmbeddedArtwork {
    mimeType: string;
    data: Uint8Array;
    description?: string;
}

export interface MetadataMergeInput {
    sourceTags: AudioTags;
    generatedTags: AudioTags;
    sourceArtwork?: EmbeddedArtwork[];
    generatedArtwork?: EmbeddedArtwork;
    policy: MetadataWritePolicy;
    includeArtwork: boolean;
}

const MANAGED_TAGS = new Set([
    'title', 'album', 'artist', 'albumartist', 'tracknumber', 'discnumber', 'genre',
    'composer', 'copyright', 'encodedby', 'organization', 'publisher', 'subtitle',
    'website', 'rating', 'date', 'comment', 'description', 'grouping', 'language',
    'work_type', 'platforms', 'age_rating', 'circle_id', 'price', 'file_size',
    'supported_langs', 'options', 'machines',
]);

const TAG_KEY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
    album_artist: 'albumartist', 'album artist': 'albumartist',
    track: 'tracknumber', track_number: 'tracknumber', 'track number': 'tracknumber',
    disc: 'discnumber', disc_number: 'discnumber', 'disc number': 'discnumber',
    encoded_by: 'encodedby', 'encoded by': 'encodedby',
});
function normalizedKey(key: string): string {
    const normalized = key.trim().toLocaleLowerCase('en-US');
    return TAG_KEY_ALIASES[normalized] || normalized;
}
function hasMetadataValue(value: AudioTagValue): boolean {
    return Array.isArray(value) ? value.some(item => item.trim().length > 0) : value.trim().length > 0;
}

/** Unknown/custom source tags are preserved in both modes. */
export function mergeAudioMetadata(input: MetadataMergeInput): { tags: AudioTags; artwork: EmbeddedArtwork[] } {
    const tags: AudioTags = { ...input.sourceTags };
    const existingByNormalized = new Map(Object.keys(tags).map(key => [normalizedKey(key), key]));
    for (const [generatedKey, value] of Object.entries(input.generatedTags)) {
        const normalized = normalizedKey(generatedKey);
        const existingKey = existingByNormalized.get(normalized);
        if (input.policy === 'additive' && existingKey && hasMetadataValue(tags[existingKey])) continue;
        if (existingKey && existingKey !== generatedKey) delete tags[existingKey];
        tags[generatedKey] = value;
        existingByNormalized.set(normalized, generatedKey);
    }
    if (input.policy === 'overwrite') {
        // Managed fields absent from the new canonical set are removed; unrelated custom fields survive.
        const generated = new Set(Object.keys(input.generatedTags).map(normalizedKey));
        for (const key of Object.keys(tags)) {
            const normalized = normalizedKey(key);
            if (MANAGED_TAGS.has(normalized) && !generated.has(normalized)) delete tags[key];
        }
    }

    const sourceArtwork = input.sourceArtwork || [];
    const artwork = !input.includeArtwork ? sourceArtwork
        : input.policy === 'overwrite' && input.generatedArtwork ? [input.generatedArtwork]
            : sourceArtwork.length ? sourceArtwork
                : input.generatedArtwork ? [input.generatedArtwork] : [];
    return { tags, artwork };
}
