import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { encodeSemanticBinaryShard } from '../src/features/vectorSearchBinaryShard.js';

export const BASELINE_BUILD_CONFIG = Object.freeze({
    schemaVersion: 2,
    cutoffInclusive: '2026-07-14',
    model: 'Xenova/multilingual-e5-small',
    modelRevision: 'hf:761b726dd34fb83930e26aab4e9ac3899aa1fa78;transformersjs:4.0.0-next.4',
    dtype: 'q8',
    modelOnnxSha256: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193',
    shardFormat: 'gzip-f32le-v1',
    dimension: 384,
    metric: 'dot',
    normalized: true,
    payloadRecipeVersion: 'vector-entry-v5-canonical-640',
});

const DEFAULT_DECODED_SHARD_BYTES = 8 * 1024 * 1024;

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
    return JSON.stringify(stableValue(value));
}

function validDate(value) {
    const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    return date.toISOString().slice(0, 10) === value;
}

function validateEntry(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || typeof entry.id !== 'string' || !entry.id
        || typeof entry.title !== 'string' || typeof entry.description !== 'string'
        || !Array.isArray(entry.tags) || entry.tags.some((tag) => typeof tag !== 'string')
        || !validDate(entry.release) || entry.release > BASELINE_BUILD_CONFIG.cutoffInclusive
        || !(Array.isArray(entry.vector) || entry.vector instanceof Float32Array)
        || entry.vector.length !== BASELINE_BUILD_CONFIG.dimension
        || Array.from(entry.vector).some((component) => typeof component !== 'number' || !Number.isFinite(component))) {
        throw new Error(`Invalid baseline entry: ${String(entry?.id || '(unknown)')}`);
    }
    const norm = Math.sqrt(entry.vector.reduce((sum, component) => sum + component * component, 0));
    if (norm < 0.98 || norm > 1.02) throw new Error(`Non-normalized baseline vector: ${entry.id}`);
}

export function buildVectorBaseline(entries, options) {
    const datasetId = String(options?.datasetId || '').trim();
    if (!/^[a-zA-Z0-9._-]{1,96}$/.test(datasetId)) throw new Error('A safe datasetId is required');
    const generatedAt = options?.generatedAt || new Date().toISOString();
    if (!Number.isFinite(Date.parse(generatedAt))) throw new Error('generatedAt must be ISO-compatible');
    const shardMaxBytes = options?.shardMaxBytes ?? DEFAULT_DECODED_SHARD_BYTES;
    if (!Number.isSafeInteger(shardMaxBytes) || shardMaxBytes < 1024) throw new Error('Invalid shard size');

    const unique = new Set();
    const sorted = [...entries].sort((left, right) => {
        const leftId = String(left.id);
        const rightId = String(right.id);
        return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
    if (sorted.length === 0) throw new Error('Baseline must contain at least one entry');
    const objects = new Map();
    const shards = [];
    let pending = [];
    let pendingDecodedBytes = 24 + 2;

    const flush = () => {
        if (!pending.length) return;
        const decoded = encodeSemanticBinaryShard(pending, BASELINE_BUILD_CONFIG.dimension);
        if (decoded.byteLength > shardMaxBytes) throw new Error('Decoded shard exceeds size limit');
        const body = gzipSync(decoded, { level: 9, mtime: 0 });
        const sha256 = createHash('sha256').update(body).digest('hex');
        const key = `/semantic-index/objects/${sha256}.bin.gz`;
        objects.set(key, body);
        shards.push({ key, sha256, bytes: body.byteLength, decodedBytes: decoded.byteLength, entryCount: pending.length });
        pending = [];
        pendingDecodedBytes = 24 + 2;
    };

    for (const entry of sorted) {
        validateEntry(entry);
        if (unique.has(entry.id)) throw new Error(`Duplicate baseline entry: ${entry.id}`);
        unique.add(entry.id);
        const { vector: _vector, ...metadata } = entry;
        const rowBytes = Buffer.byteLength(stableJson(metadata)) + BASELINE_BUILD_CONFIG.dimension * 4 + (pending.length ? 1 : 0);
        if (pending.length && pendingDecodedBytes + rowBytes > shardMaxBytes) flush();
        if (24 + 2 + Buffer.byteLength(stableJson(metadata)) + BASELINE_BUILD_CONFIG.dimension * 4 > shardMaxBytes) {
            throw new Error(`Entry exceeds shard size: ${entry.id}`);
        }
        pending.push(entry);
        pendingDecodedBytes += Buffer.byteLength(stableJson(metadata)) + BASELINE_BUILD_CONFIG.dimension * 4 + (pending.length > 1 ? 1 : 0);
    }
    flush();

    const manifest = {
        ...BASELINE_BUILD_CONFIG,
        datasetId,
        generatedAt,
        entryCount: sorted.length,
        shards,
    };
    return { manifest, objects };
}

export function parseBaselineBuildInput(parsed) {
    const entries = parsed?.entries;
    if (!Array.isArray(entries) || stableJson(parsed?.contract) !== stableJson(BASELINE_BUILD_CONFIG)) {
        throw new Error('Input must include entries and the exact baseline compatibility contract');
    }
    return entries;
}

export async function writeVectorBaseline(inputPath, outputDirectory, options) {
    const parsed = JSON.parse(await readFile(inputPath, 'utf8'));
    const entries = parseBaselineBuildInput(parsed);
    return writeBuiltVectorBaseline(entries, outputDirectory, options);
}

export async function writeBuiltVectorBaseline(entries, outputDirectory, options) {
    const built = buildVectorBaseline(entries, options);
    for (const [key, body] of built.objects) {
        const target = join(outputDirectory, key.replace(/^\//, ''));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, body);
    }
    const manifestPath = join(outputDirectory, 'semantic-index/manifest.json');
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, `${stableJson(built.manifest)}\n`);
    return built.manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const [, , inputPath, outputDirectory, datasetId] = process.argv;
    if (!inputPath || !outputDirectory || !datasetId) {
        throw new Error('Usage: node scripts/build-vector-baseline.mjs <entries.json> <output-dir> <dataset-id>');
    }
    const manifest = await writeVectorBaseline(inputPath, outputDirectory, { datasetId });
    process.stdout.write(`Built ${manifest.entryCount} entries in ${manifest.shards.length} shard(s) for ${manifest.datasetId}\n`);
}
