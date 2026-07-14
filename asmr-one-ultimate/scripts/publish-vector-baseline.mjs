import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { BASELINE_BUILD_CONFIG } from './build-vector-baseline.mjs';
import { decodeSemanticBinaryShard } from '../src/features/vectorSearchBinaryShard.js';

const execFileAsync = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_SHARD_BYTES = 8 * 1024 * 1024;
const MAX_SHARDS = 512;
const MAX_ENTRIES = 250_000;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

function hash(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

function safeInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
    return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function validRelease(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
        && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value
        && value <= BASELINE_BUILD_CONFIG.cutoffInclusive;
}

function optionalStringArray(value, maximumLength = 512) {
    return value === undefined || (Array.isArray(value) && value.length <= maximumLength
        && value.every((item) => typeof item === 'string' && item.length <= 512));
}

function validateDecodedEntry(entry, seenIds) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || typeof entry.id !== 'string' || !entry.id.trim() || entry.id.length > 128 || seenIds.has(entry.id)
        || typeof entry.title !== 'string' || entry.title.length > 2_048
        || typeof entry.description !== 'string' || entry.description.length > 2_000
        || !Array.isArray(entry.tags) || entry.tags.length > 512
        || entry.tags.some((tag) => typeof tag !== 'string' || tag.length > 512)
        || !optionalStringArray(entry.searchTags) || !optionalStringArray(entry.vas)
        || !validRelease(entry.release)
        || !(entry.vector instanceof Float32Array) || entry.vector.length !== BASELINE_BUILD_CONFIG.dimension
        || Array.from(entry.vector).some((component) => !Number.isFinite(component))) {
        throw new Error(`Invalid decoded baseline entry: ${String(entry?.id || '(unknown)')}`);
    }
    for (const field of ['circle', 'series', 'searchText', 'cover']) {
        if (entry[field] !== undefined && (typeof entry[field] !== 'string' || entry[field].length > 8_192)) {
            throw new Error(`Invalid decoded baseline entry ${field}: ${entry.id}`);
        }
    }
    for (const field of ['dlCount', 'rating']) {
        if (entry[field] !== undefined && (typeof entry[field] !== 'number' || !Number.isFinite(entry[field]))) {
            throw new Error(`Invalid decoded baseline entry ${field}: ${entry.id}`);
        }
    }
    for (const field of ['nsfw', 'hasSubtitle']) {
        if (entry[field] !== undefined && typeof entry[field] !== 'boolean') {
            throw new Error(`Invalid decoded baseline entry ${field}: ${entry.id}`);
        }
    }
    let squaredNorm = 0;
    for (const component of entry.vector) squaredNorm += component * component;
    const norm = Math.sqrt(squaredNorm);
    if (norm < 0.98 || norm > 1.02) throw new Error(`Non-normalized decoded baseline entry: ${entry.id}`);
    seenIds.add(entry.id);
}

function validateManifest(manifest) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
        || typeof manifest.datasetId !== 'string' || !/^[a-zA-Z0-9._-]{1,96}$/.test(manifest.datasetId)
        || typeof manifest.generatedAt !== 'string' || !Number.isFinite(Date.parse(manifest.generatedAt))
        || !safeInteger(manifest.entryCount, MAX_ENTRIES)
        || !Array.isArray(manifest.shards) || !manifest.shards.length || manifest.shards.length > MAX_SHARDS) {
        throw new Error('Invalid baseline manifest');
    }
    for (const [key, value] of Object.entries(BASELINE_BUILD_CONFIG)) {
        if (manifest[key] !== value) throw new Error(`Incompatible baseline manifest contract: ${key}`);
    }
    const descriptorKeys = new Set();
    let describedEntries = 0;
    let encodedBytes = 0;
    let decodedBytes = 0;
    for (const shard of manifest.shards) {
        if (!shard || typeof shard !== 'object' || Array.isArray(shard)
            || !SHA256.test(shard.sha256) || shard.key !== `/semantic-index/objects/${shard.sha256}.bin.gz`
            || descriptorKeys.has(shard.key)
            || !safeInteger(shard.bytes, MAX_SHARD_BYTES)
            || !safeInteger(shard.decodedBytes, MAX_SHARD_BYTES)
            || !safeInteger(shard.entryCount, MAX_ENTRIES)) {
            throw new Error('Invalid or duplicate manifest shard descriptor');
        }
        descriptorKeys.add(shard.key);
        describedEntries += shard.entryCount;
        encodedBytes += shard.bytes;
        decodedBytes += shard.decodedBytes;
    }
    if (describedEntries !== manifest.entryCount) throw new Error('Manifest entry count does not match its shards');
    if (encodedBytes > MAX_TOTAL_BYTES || decodedBytes > MAX_TOTAL_BYTES) throw new Error('Baseline exceeds global size limit');
}

export async function validatePublicationDirectory(directory) {
    const root = resolve(directory);
    const manifestPath = join(root, 'semantic-index/manifest.json');
    const markerPath = join(root, 'semantic-index/complete.json');
    const manifestBytes = await readFile(manifestPath);
    if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) throw new Error('Manifest exceeds client size limit');
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    const manifestSha256 = hash(manifestBytes);
    if (marker?.markerVersion !== 1 || marker.manifestSha256 !== manifestSha256
        || marker.manifestBytes !== manifestBytes.byteLength || marker.datasetId !== manifest.datasetId
        || marker.entryCount !== manifest.entryCount) {
        throw new Error('Completion marker does not match manifest');
    }
    validateManifest(manifest);
    const objects = [];
    const seenIds = new Set();
    for (const shard of manifest.shards) {
        const path = join(root, shard.key.replace(/^\//, ''));
        const bytes = await readFile(path);
        if (bytes.byteLength !== shard.bytes || hash(bytes) !== shard.sha256) throw new Error(`Local shard verification failed: ${shard.key}`);
        let decodedBytes;
        try {
            decodedBytes = gunzipSync(bytes, { maxOutputLength: shard.decodedBytes });
        } catch {
            throw new Error(`Local shard decompression failed: ${shard.key}`);
        }
        if (decodedBytes.byteLength !== shard.decodedBytes) throw new Error(`Local decoded shard length mismatch: ${shard.key}`);
        let decoded;
        try {
            decoded = decodeSemanticBinaryShard(decodedBytes);
        } catch {
            throw new Error(`Local shard decoding failed: ${shard.key}`);
        }
        if (decoded.dimension !== BASELINE_BUILD_CONFIG.dimension || decoded.count !== shard.entryCount) {
            throw new Error(`Local decoded shard contract mismatch: ${shard.key}`);
        }
        for (const entry of decoded.entries) validateDecodedEntry(entry, seenIds);
        objects.push({ key: shard.key.replace(/^\//, ''), path, bytes: shard.bytes, sha256: shard.sha256 });
    }
    if (seenIds.size !== manifest.entryCount) throw new Error('Decoded baseline entry count mismatch');
    return { root, manifest, manifestPath, manifestBytes, manifestSha256, objects };
}

export async function publishVectorBaseline(options) {
    const validated = await validatePublicationDirectory(options.directory);
    const log = options.log || console.log;
    log(`[baseline-publish] validated ${validated.objects.length} object(s), manifest ${validated.manifestSha256}`);
    if (options.dryRun) {
        log('[baseline-publish] dry run complete; no remote writes performed');
        return { status: 'dry-run', objects: validated.objects.length, manifestSha256: validated.manifestSha256 };
    }
    if (!options.putObject || !options.getObject) throw new Error('Publisher requires remote put/get operations');
    for (const object of validated.objects) {
        await options.putObject({ ...object, contentType: 'application/octet-stream', cacheControl: 'public, max-age=31536000, immutable' });
        const remote = await options.getObject(object.key);
        if (remote.byteLength !== object.bytes || hash(remote) !== object.sha256) throw new Error(`Remote shard verification failed: ${object.key}`);
        log(`[baseline-publish] uploaded and verified ${object.key} (${object.bytes} bytes)`);
    }
    const manifestKey = 'semantic-index/manifest.json';
    await options.putObject({
        key: manifestKey,
        path: validated.manifestPath,
        bytes: validated.manifestBytes.byteLength,
        sha256: validated.manifestSha256,
        contentType: 'application/json',
        cacheControl: 'public, max-age=300, must-revalidate',
    });
    const remoteManifest = await options.getObject(manifestKey);
    if (remoteManifest.byteLength !== validated.manifestBytes.byteLength || hash(remoteManifest) !== validated.manifestSha256) {
        throw new Error('Remote manifest verification failed');
    }
    log('[baseline-publish] manifest uploaded last and verified');
    return { status: 'published', objects: validated.objects.length, manifestSha256: validated.manifestSha256 };
}

export function createWranglerR2Operations(bucket) {
    const run = async (args) => {
        await execFileAsync('npx', ['--yes', 'wrangler@4.110.0', ...args], { maxBuffer: 2 * 1024 * 1024 });
    };
    return {
        async putObject(object) {
            await run([
                'r2', 'object', 'put', `${bucket}/${object.key}`, '--file', object.path, '--remote', '--force',
                '--content-type', object.contentType, '--cache-control', object.cacheControl,
            ]);
        },
        async getObject(key) {
            const directory = await mkdtemp(join(tmpdir(), 'semantic-r2-verify-'));
            const path = join(directory, 'object');
            try {
                await run(['r2', 'object', 'get', `${bucket}/${key}`, '--file', path, '--remote']);
                return await readFile(path);
            } finally {
                await rm(directory, { recursive: true, force: true });
            }
        },
    };
}

export function parsePublisherCliArgs(args) {
    const unknownFlags = args.filter((argument) => argument.startsWith('-') && argument !== '--dry-run');
    if (unknownFlags.length) throw new Error(`Unknown option: ${unknownFlags[0]}`);
    const dryRunCount = args.filter((argument) => argument === '--dry-run').length;
    if (dryRunCount > 1) throw new Error('Duplicate --dry-run option');
    const positional = args.filter((argument) => argument !== '--dry-run');
    if (!positional[0] || positional.length > 2) {
        throw new Error('Usage: node scripts/publish-vector-baseline.mjs <output-dir> [bucket] [--dry-run]');
    }
    return { directory: positional[0], bucket: positional[1] || 'asmr-semantic-index', dryRun: dryRunCount === 1 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const { directory, bucket, dryRun } = parsePublisherCliArgs(process.argv.slice(2));
    const operations = dryRun ? {} : createWranglerR2Operations(bucket);
    await publishVectorBaseline({ directory, dryRun, ...operations });
}
