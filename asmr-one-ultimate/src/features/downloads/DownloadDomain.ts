export type DownloadMediaCategory = 'audio' | 'video' | 'image' | 'text' | 'unknown';

export interface DownloadFileFilters {
    audio: boolean;
    video: boolean;
    image: boolean;
    text: boolean;
    unknown: boolean;
}

/** Controls the work-title portion used in destination names and generated tags. */
export type WorkTitleMode = 'original' | 'translated' | 'original-bracketed-translation' | 'none';

export type MetadataWritePolicy = 'additive' | 'overwrite';

export interface DownloadMetadataOptions {
    /** Additive only fills missing fields; overwrite is an explicit consistency choice. */
    writePolicy: MetadataWritePolicy;
    includeWorkMetadata: boolean;
    includeArtwork: boolean;
    preserveSourceMetadata: boolean;
}

export interface DownloadOpusOptions {
    enabled: boolean;
    bitrateKbps: number;
    preserveSourceMetadata: boolean;
    embedArtwork: boolean;
}

export interface DownloadProfile {
    filters: DownloadFileFilters;
    titleMode: WorkTitleMode;
    /** BCP-47-ish language selected by the user's interface setting (for example, zh-CN). */
    targetLanguage: string;
    metadata: DownloadMetadataOptions;
    opus: DownloadOpusOptions;
}

export const DEFAULT_DOWNLOAD_PROFILE: Readonly<DownloadProfile> = Object.freeze({
    filters: Object.freeze({
        audio: true,
        video: false,
        image: true,
        text: true,
        unknown: false,
    }),
    titleMode: 'original-bracketed-translation',
    targetLanguage: 'en',
    metadata: Object.freeze({
        writePolicy: 'additive',
        includeWorkMetadata: true,
        includeArtwork: true,
        preserveSourceMetadata: true,
    }),
    opus: Object.freeze({
        enabled: false,
        bitrateKbps: 64,
        preserveSourceMetadata: true,
        embedArtwork: true,
    }),
});

function normalizeOpusBitrate(value: number): number {
    if (!Number.isFinite(value)) return DEFAULT_DOWNLOAD_PROFILE.opus.bitrateKbps;
    return Math.max(16, Math.min(256, Math.round(value)));
}

export function createDownloadProfile(
    targetLanguage: string,
    overrides: Partial<Omit<DownloadProfile, 'filters' | 'metadata' | 'opus'>> & {
        filters?: Partial<DownloadFileFilters>;
        metadata?: Partial<DownloadMetadataOptions>;
        opus?: Partial<DownloadOpusOptions>;
    } = {},
): DownloadProfile {
    const language = targetLanguage.trim() || DEFAULT_DOWNLOAD_PROFILE.targetLanguage;
    return {
        filters: { ...DEFAULT_DOWNLOAD_PROFILE.filters, ...overrides.filters },
        titleMode: overrides.titleMode ?? DEFAULT_DOWNLOAD_PROFILE.titleMode,
        targetLanguage: overrides.targetLanguage?.trim() || language,
        metadata: { ...DEFAULT_DOWNLOAD_PROFILE.metadata, ...overrides.metadata },
        opus: {
            ...DEFAULT_DOWNLOAD_PROFILE.opus,
            ...overrides.opus,
            bitrateKbps: normalizeOpusBitrate(
                overrides.opus?.bitrateKbps ?? DEFAULT_DOWNLOAD_PROFILE.opus.bitrateKbps,
            ),
        },
    };
}

export function categoryIsEnabled(category: DownloadMediaCategory, filters: DownloadFileFilters): boolean {
    return filters[category];
}
