export const SEMANTIC_BASELINE_CUTOFF = '2026-07-14';
export const SEMANTIC_INDEX_SCHEMA_VERSION = 2;
export const SEMANTIC_INDEX_APP_VERSION = 5;
export const SEMANTIC_EMBEDDING_MODEL = 'Xenova/multilingual-e5-small';
export const SEMANTIC_MODEL_SOURCE_REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
export const SEMANTIC_EMBEDDING_MODEL_REVISION = `hf:${SEMANTIC_MODEL_SOURCE_REVISION};transformersjs:4.0.0-next.4`;
export const SEMANTIC_EMBEDDING_DTYPE = 'q8';
export const SEMANTIC_MODEL_ONNX_SHA256 = 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193';
export const SEMANTIC_SHARD_FORMAT = 'gzip-f32le-v1';
export const SEMANTIC_EMBEDDING_DIMENSION = 384;
export const SEMANTIC_PAYLOAD_RECIPE_VERSION = 'vector-entry-v5-canonical-640';
export const SEMANTIC_COMPATIBILITY_FINGERPRINT = [
    SEMANTIC_INDEX_SCHEMA_VERSION,
    SEMANTIC_EMBEDDING_MODEL,
    SEMANTIC_EMBEDDING_MODEL_REVISION,
    SEMANTIC_EMBEDDING_DTYPE,
    SEMANTIC_MODEL_ONNX_SHA256,
    SEMANTIC_SHARD_FORMAT,
    SEMANTIC_EMBEDDING_DIMENSION,
    'dot',
    true,
    SEMANTIC_PAYLOAD_RECIPE_VERSION,
    SEMANTIC_BASELINE_CUTOFF,
].join('|');

export interface SemanticVectorEntry {
    id: string;
    title: string;
    description: string;
    tags: string[];
    searchTags?: string[];
    circle?: string;
    vas?: string[];
    series?: string;
    searchText?: string;
    cover?: string;
    vector: number[] | Float32Array;
    release: string;
    dlCount?: number;
    rating?: number;
    nsfw?: boolean;
    hasSubtitle?: boolean;
}

export interface SemanticBaselineShard {
    key: string;
    sha256: string;
    bytes: number;
    decodedBytes: number;
    entryCount: number;
}

export interface SemanticBaselineManifest {
    schemaVersion: number;
    datasetId: string;
    generatedAt: string;
    cutoffInclusive: string;
    model: string;
    modelRevision: string;
    dtype: 'q8';
    modelOnnxSha256: string;
    shardFormat: 'gzip-f32le-v1';
    dimension: number;
    metric: 'dot';
    normalized: true;
    payloadRecipeVersion: string;
    entryCount: number;
    shards: SemanticBaselineShard[];
}

export interface SemanticIndexState {
    key: 'state';
    activeDatasetId?: string;
    expectedBaselineCount?: number;
    activeManifestSha256?: string;
    manifestEtag?: string;
    lastCheckedAt?: number;
    compatibilityFingerprint?: string;
}

export function semanticCompatibilityFingerprint(manifest: SemanticBaselineManifest): string {
    return [
        manifest.schemaVersion,
        manifest.model,
        manifest.modelRevision,
        manifest.dtype,
        manifest.modelOnnxSha256,
        manifest.shardFormat,
        manifest.dimension,
        manifest.metric,
        manifest.normalized,
        manifest.payloadRecipeVersion,
        manifest.cutoffInclusive,
    ].join('|');
}
