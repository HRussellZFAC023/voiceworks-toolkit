import { DEFAULT_API_PROXY } from '../core/Constants';
import {
    SEMANTIC_BASELINE_CUTOFF,
    SEMANTIC_EMBEDDING_DIMENSION,
    SEMANTIC_EMBEDDING_MODEL,
    SEMANTIC_EMBEDDING_MODEL_REVISION,
    SEMANTIC_EMBEDDING_DTYPE,
    SEMANTIC_MODEL_ONNX_SHA256,
    SEMANTIC_SHARD_FORMAT,
    SEMANTIC_INDEX_SCHEMA_VERSION,
    SEMANTIC_PAYLOAD_RECIPE_VERSION,
    semanticCompatibilityFingerprint,
    type SemanticBaselineManifest,
    type SemanticBaselineShard,
    type SemanticVectorEntry,
} from './vectorSearchIndexTypes';
import { isValidSemanticReleaseDate } from './vectorSearchDeltaPolicy';
import { VectorSearchRepository } from './vectorSearchRepository';
import { decodeSemanticBinaryShard } from './vectorSearchBinaryShard';

export const DEFAULT_SEMANTIC_BASELINE_MANIFEST_URL = `${DEFAULT_API_PROXY}/semantic-index/manifest.json`;
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_ENCODED_SHARD_BYTES = 8 * 1024 * 1024;
const MAX_DECODED_SHARD_BYTES = 8 * 1024 * 1024;
const MAX_SHARDS = 512;
const MAX_BASELINE_ENTRIES = 250_000;
const MAX_BASELINE_TOTAL_BYTES = 512 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SHARD_KEY_PATTERN = /^\/semantic-index\/objects\/[a-f0-9]{64}\.bin\.gz$/;

export type BaselineSyncResult =
    | { status: 'activated' | 'cached'; datasetId: string; entries: number }
    | { status: 'unavailable'; error: string };

type FetchLike = typeof fetch;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNonNegativeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseShard(value: unknown): SemanticBaselineShard {
    if (!isRecord(value)
        || typeof value.key !== 'string' || !SHARD_KEY_PATTERN.test(value.key)
        || typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)
        || !finiteNonNegativeInteger(value.bytes) || value.bytes <= 0 || value.bytes > MAX_ENCODED_SHARD_BYTES
        || !finiteNonNegativeInteger(value.decodedBytes) || value.decodedBytes <= 0 || value.decodedBytes > MAX_DECODED_SHARD_BYTES
        || !finiteNonNegativeInteger(value.entryCount) || value.entryCount <= 0) {
        throw new Error('Invalid semantic baseline shard descriptor');
    }
    if (!value.key.includes(value.sha256)) throw new Error('Shard key does not match its SHA-256');
    return { key: value.key, sha256: value.sha256, bytes: value.bytes, decodedBytes: value.decodedBytes, entryCount: value.entryCount };
}

export function parseSemanticBaselineManifest(value: unknown): SemanticBaselineManifest {
    if (!isRecord(value) || !Array.isArray(value.shards)) throw new Error('Invalid semantic baseline manifest');
    if (value.schemaVersion !== SEMANTIC_INDEX_SCHEMA_VERSION
        || typeof value.datasetId !== 'string' || !/^[a-zA-Z0-9._-]{1,96}$/.test(value.datasetId)
        || typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt))
        || value.cutoffInclusive !== SEMANTIC_BASELINE_CUTOFF
        || value.model !== SEMANTIC_EMBEDDING_MODEL
        || value.modelRevision !== SEMANTIC_EMBEDDING_MODEL_REVISION
        || value.dtype !== SEMANTIC_EMBEDDING_DTYPE
        || value.modelOnnxSha256 !== SEMANTIC_MODEL_ONNX_SHA256
        || value.shardFormat !== SEMANTIC_SHARD_FORMAT
        || value.dimension !== SEMANTIC_EMBEDDING_DIMENSION
        || value.metric !== 'dot'
        || value.normalized !== true
        || value.payloadRecipeVersion !== SEMANTIC_PAYLOAD_RECIPE_VERSION
        || !finiteNonNegativeInteger(value.entryCount) || value.entryCount <= 0 || value.entryCount > MAX_BASELINE_ENTRIES
        || value.shards.length > MAX_SHARDS) {
        throw new Error('Incompatible semantic baseline manifest');
    }
    const shards = value.shards.map(parseShard);
    const describedEntries = shards.reduce((total, shard) => total + shard.entryCount, 0);
    if (describedEntries !== value.entryCount) throw new Error('Manifest entry count does not match its shards');
    const encodedBytes = shards.reduce((total, shard) => total + shard.bytes, 0);
    const decodedBytes = shards.reduce((total, shard) => total + shard.decodedBytes, 0);
    if (encodedBytes > MAX_BASELINE_TOTAL_BYTES || decodedBytes > MAX_BASELINE_TOTAL_BYTES) {
        throw new Error('Semantic baseline exceeds global size limit');
    }
    return {
        schemaVersion: value.schemaVersion,
        datasetId: value.datasetId,
        generatedAt: value.generatedAt,
        cutoffInclusive: value.cutoffInclusive,
        model: value.model,
        modelRevision: value.modelRevision,
        dtype: value.dtype,
        modelOnnxSha256: value.modelOnnxSha256,
        shardFormat: value.shardFormat,
        dimension: value.dimension,
        metric: value.metric,
        normalized: value.normalized,
        payloadRecipeVersion: value.payloadRecipeVersion,
        entryCount: value.entryCount,
        shards,
    };
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > 512
        || value.some((item) => typeof item !== 'string' || item.length > 512)) {
        throw new Error(`Invalid baseline entry ${field}`);
    }
    return value;
}

function optionalFiniteNumber(value: unknown, field: string): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid baseline entry ${field}`);
    return value;
}

export function parseSemanticVectorEntry(value: unknown): SemanticVectorEntry {
    if (!isRecord(value)
        || typeof value.id !== 'string' || !value.id.trim() || value.id.length > 128
        || typeof value.title !== 'string' || value.title.length > 2_048
        || typeof value.description !== 'string' || value.description.length > 2_000
        || !Array.isArray(value.tags) || value.tags.length > 512
        || value.tags.some((tag) => typeof tag !== 'string' || tag.length > 512)
        || !isValidSemanticReleaseDate(value.release) || value.release > SEMANTIC_BASELINE_CUTOFF
        || !(Array.isArray(value.vector) || value.vector instanceof Float32Array)
        || value.vector.length !== SEMANTIC_EMBEDDING_DIMENSION
        || Array.from(value.vector).some((component) => typeof component !== 'number' || !Number.isFinite(component))) {
        throw new Error('Invalid semantic baseline entry');
    }
    let squaredNorm = 0;
    for (const component of value.vector) squaredNorm += component * component;
    const norm = Math.sqrt(squaredNorm);
    if (norm < 0.98 || norm > 1.02) throw new Error('Baseline vector is not normalized');
    const entry: SemanticVectorEntry = {
        id: value.id,
        title: value.title,
        description: value.description,
        tags: [...value.tags] as string[],
        vector: value.vector instanceof Float32Array ? value.vector : new Float32Array(value.vector),
        release: value.release,
    };
    const stringFields = ['circle', 'series', 'searchText', 'cover'] as const;
    for (const field of stringFields) {
        const fieldValue = value[field];
        if (fieldValue !== undefined && (typeof fieldValue !== 'string' || fieldValue.length > 8_192)) {
            throw new Error(`Invalid baseline entry ${field}`);
        }
        if (typeof fieldValue === 'string') entry[field] = fieldValue;
    }
    entry.searchTags = optionalStringArray(value.searchTags, 'searchTags');
    entry.vas = optionalStringArray(value.vas, 'vas');
    entry.dlCount = optionalFiniteNumber(value.dlCount, 'dlCount');
    entry.rating = optionalFiniteNumber(value.rating, 'rating');
    if (value.nsfw !== undefined && typeof value.nsfw !== 'boolean') throw new Error('Invalid baseline entry nsfw');
    if (value.hasSubtitle !== undefined && typeof value.hasSubtitle !== 'boolean') throw new Error('Invalid baseline entry hasSubtitle');
    if (typeof value.nsfw === 'boolean') entry.nsfw = value.nsfw;
    if (typeof value.hasSubtitle === 'boolean') entry.hasSubtitle = value.hasSubtitle;
    return entry;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
    // Response.arrayBuffer() may originate in a different JavaScript realm
    // (notably jsdom/extension bridges). Older Web Crypto implementations
    // reject cross-realm BufferSource objects, so copy into this realm first.
    const localBytes = new Uint8Array(bytes.byteLength);
    localBytes.set(new Uint8Array(bytes));
    const digest = await crypto.subtle.digest('SHA-256', localBytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readBoundedResponse(response: Response, maximum: number): Promise<ArrayBuffer> {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maximum) throw new Error('Semantic baseline response exceeds size limit');
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > maximum) throw new Error('Semantic baseline response exceeds size limit');
    return bytes;
}

async function decompressGzipBounded(compressed: ArrayBuffer, maximum: number): Promise<ArrayBuffer> {
    if (typeof globalThis.DecompressionStream !== 'function') {
        throw new Error('This browser cannot decompress the semantic baseline');
    }
    const body = new Response(compressed).body;
    if (!body) throw new Error('Unable to read compressed semantic shard');
    const stream = body.pipeThrough(new DecompressionStream('gzip'));
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maximum) {
            await reader.cancel();
            throw new Error('Decoded semantic shard exceeds size limit');
        }
        chunks.push(value);
    }
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output.buffer;
}

async function hasObviousStorageCapacity(manifest: SemanticBaselineManifest): Promise<boolean> {
    if (typeof navigator === 'undefined') return true;
    const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
    if (!estimate?.quota || estimate.usage === undefined) return true;
    const decodedBytes = manifest.shards.reduce((total, shard) => total + shard.decodedBytes, 0);
    // IndexedDB stores one structured-cloned object per work, including an
    // ArrayBuffer and index keys. Browser usage is materially larger than the
    // packed shard, and the old generation coexists while a new one is staged.
    const required = decodedBytes * 2.25 + manifest.entryCount * 4_096 + 32 * 1024 * 1024;
    return estimate.quota - estimate.usage >= required;
}

export class VectorSearchBaselineClient {
    constructor(
        private readonly repository: VectorSearchRepository,
        private readonly manifestUrl = DEFAULT_SEMANTIC_BASELINE_MANIFEST_URL,
        private readonly fetchImpl: FetchLike = fetch,
    ) {}

    async synchronize(signal?: AbortSignal): Promise<BaselineSyncResult> {
        let importingDataset: string | undefined;
        try {
            const state = await this.repository.getState();
            const headers: Record<string, string> = { Accept: 'application/json' };
            if (state.manifestEtag) headers['If-None-Match'] = state.manifestEtag;
            const response = await this.fetchImpl(this.manifestUrl, { headers, cache: 'no-cache', signal });
            if (response.status === 304) {
                if (!state.activeDatasetId
                    || !Number.isSafeInteger(state.expectedBaselineCount) || (state.expectedBaselineCount ?? 0) <= 0
                    || typeof state.activeManifestSha256 !== 'string' || !SHA256_PATTERN.test(state.activeManifestSha256)) {
                    await this.repository.updateState({
                        activeDatasetId: undefined,
                        expectedBaselineCount: undefined,
                        activeManifestSha256: undefined,
                        compatibilityFingerprint: undefined,
                        manifestEtag: undefined,
                    });
                    throw new Error('Baseline returned 304 without a verified active dataset');
                }
                const count = await this.repository.countDataset(state.activeDatasetId);
                if (count !== state.expectedBaselineCount) {
                    await this.repository.updateState({
                        activeDatasetId: undefined,
                        expectedBaselineCount: undefined,
                        activeManifestSha256: undefined,
                        compatibilityFingerprint: undefined,
                        manifestEtag: undefined,
                    });
                    throw new Error('Active baseline dataset count does not match its manifest');
                }
                await this.repository.updateState({ lastCheckedAt: Date.now() });
                return {
                    status: 'cached',
                    datasetId: state.activeDatasetId,
                    entries: count,
                };
            }
            if (!response.ok) throw new Error(`Baseline manifest HTTP ${response.status}`);
            const manifestBytes = await readBoundedResponse(response, MAX_MANIFEST_BYTES);
            const manifestSha256 = await sha256Hex(manifestBytes);
            const manifest = parseSemanticBaselineManifest(JSON.parse(new TextDecoder().decode(manifestBytes)));
            const etag = response.headers.get('etag') || undefined;
            if (state.activeDatasetId === manifest.datasetId) {
                const count = await this.repository.countDataset(manifest.datasetId);
                const hasVerifiedIdentity = Number.isSafeInteger(state.expectedBaselineCount)
                    && (state.expectedBaselineCount ?? 0) > 0
                    && typeof state.activeManifestSha256 === 'string'
                    && SHA256_PATTERN.test(state.activeManifestSha256);
                if (!hasVerifiedIdentity) {
                    await this.repository.updateState({
                        activeDatasetId: undefined,
                        expectedBaselineCount: undefined,
                        activeManifestSha256: undefined,
                        compatibilityFingerprint: undefined,
                        manifestEtag: undefined,
                    });
                } else if (state.activeManifestSha256 !== manifestSha256) {
                    await this.repository.updateState({ manifestEtag: undefined });
                    throw new Error('Semantic manifest changed without a new dataset ID');
                } else if (count === manifest.entryCount && state.expectedBaselineCount === manifest.entryCount) {
                    await this.repository.updateState({
                        expectedBaselineCount: manifest.entryCount,
                        activeManifestSha256: manifestSha256,
                        manifestEtag: etag,
                        lastCheckedAt: Date.now(),
                    });
                    return { status: 'cached', datasetId: manifest.datasetId, entries: manifest.entryCount };
                } else {
                    await this.repository.updateState({
                        activeDatasetId: undefined,
                        expectedBaselineCount: undefined,
                        activeManifestSha256: undefined,
                        compatibilityFingerprint: undefined,
                        manifestEtag: undefined,
                    });
                }
            }

            if (!await hasObviousStorageCapacity(manifest)) throw new Error('Insufficient browser storage for semantic baseline');

            importingDataset = manifest.datasetId;
            await this.repository.prepareDataset(manifest.datasetId);
            const seen = new Set<string>();
            let imported = 0;
            for (const shard of manifest.shards) {
                if (signal?.aborted) throw new DOMException('Baseline import aborted', 'AbortError');
                const shardUrl = new URL(shard.key, this.manifestUrl).toString();
                const shardResponse = await this.fetchImpl(shardUrl, { cache: 'force-cache', signal });
                if (!shardResponse.ok) throw new Error(`Baseline shard HTTP ${shardResponse.status}`);
                const shardBytes = await readBoundedResponse(shardResponse, Math.min(MAX_ENCODED_SHARD_BYTES, shard.bytes));
                if (shardBytes.byteLength !== shard.bytes) throw new Error('Baseline shard byte length mismatch');
                if (await sha256Hex(shardBytes) !== shard.sha256) throw new Error('Baseline shard integrity check failed');
                const decodedBytes = await decompressGzipBounded(shardBytes, Math.min(MAX_DECODED_SHARD_BYTES, shard.decodedBytes));
                if (decodedBytes.byteLength !== shard.decodedBytes) throw new Error('Decoded baseline shard byte length mismatch');
                const decoded = decodeSemanticBinaryShard(decodedBytes);
                if (decoded.dimension !== SEMANTIC_EMBEDDING_DIMENSION || decoded.count !== shard.entryCount) {
                    throw new Error('Baseline shard header mismatch');
                }
                const entries = decoded.entries.map(parseSemanticVectorEntry);
                for (const entry of entries) {
                    if (seen.has(entry.id)) throw new Error(`Duplicate baseline entry: ${entry.id}`);
                    seen.add(entry.id);
                }
                await this.repository.putBaselineBatch(manifest.datasetId, entries);
                imported += entries.length;
            }
            if (signal?.aborted) throw new DOMException('Baseline import aborted', 'AbortError');
            if (imported !== manifest.entryCount) throw new Error('Imported baseline count mismatch');
            await this.repository.activateDataset(
                manifest.datasetId,
                manifest.entryCount,
                semanticCompatibilityFingerprint(manifest),
                etag,
                manifestSha256,
            );
            importingDataset = undefined;
            void this.repository.cleanupInactiveDatasets();
            return { status: 'activated', datasetId: manifest.datasetId, entries: imported };
        } catch (error) {
            if (importingDataset) await this.repository.removeDataset(importingDataset).catch(() => undefined);
            return { status: 'unavailable', error: error instanceof Error ? error.message : String(error) };
        }
    }
}
