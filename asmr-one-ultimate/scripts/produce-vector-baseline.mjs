import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BASELINE_BUILD_CONFIG, writeBuiltVectorBaseline } from './build-vector-baseline.mjs';
import { canonicalSemanticPassageModelInput, prepareSemanticWorkEntry } from '../src/features/vectorSearchEntryUtils.js';
import { decodeSemanticBinaryShard, encodeSemanticBinaryShard, stableSemanticJson } from '../src/features/vectorSearchBinaryShard.js';

export const PRODUCER_PAGE_SIZE = 500;
export const PRODUCER_PACING_MS = 200;
const MAX_RETRIES = 6;
const TRANSFORMERS_VERSION = '4.0.0-next.4';
const PINNED_MODEL_FILES = Object.freeze({
    'onnx/model_quantized.onnx': 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193',
    'config.json': 'cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1',
    'tokenizer.json': '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
    'tokenizer_config.json': 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b',
});

const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
const validDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;

async function atomicJson(path, value) {
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`);
    await rename(temporary, path);
}

async function atomicBytes(path, value) {
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, value);
    await rename(temporary, path);
}

function retryDelay(response, attempt) {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
        const dateDelay = Date.parse(retryAfter) - Date.now();
        if (Number.isFinite(dateDelay)) return Math.max(0, dateDelay);
    }
    return Math.min(30_000, 500 * (2 ** attempt));
}

export async function fetchWithRetry(url, options = {}) {
    const fetchImpl = options.fetchImpl || fetch;
    const sleepImpl = options.sleepImpl || sleep;
    for (let attempt = 0; attempt <= (options.maxRetries ?? MAX_RETRIES); attempt++) {
        try {
            const response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
            if (response.ok) return response;
            if (response.status !== 429 && response.status < 500) {
                const error = new Error(`Works API HTTP ${response.status}`);
                error.nonRetryable = true;
                throw error;
            }
            if (attempt === (options.maxRetries ?? MAX_RETRIES)) throw new Error(`Works API retry limit reached (${response.status})`);
            await sleepImpl(retryDelay(response, attempt));
        } catch (error) {
            if (error?.nonRetryable) throw error;
            if (attempt === (options.maxRetries ?? MAX_RETRIES)) throw error;
            await sleepImpl(Math.min(30_000, 500 * (2 ** attempt)));
        }
    }
    throw new Error('Works API retry loop exited unexpectedly');
}

function validatePage(raw, expectedPage) {
    const works = raw?.works;
    const pagination = raw?.pagination;
    if (!Array.isArray(works) || !pagination || pagination.currentPage !== expectedPage
        || pagination.pageSize !== PRODUCER_PAGE_SIZE || !Number.isSafeInteger(pagination.totalCount) || pagination.totalCount <= 0) {
        throw new Error(`Invalid works page ${expectedPage}`);
    }
    return { works, totalCount: pagination.totalCount };
}

function validateWork(work, seen) {
    const id = String(work?.id || '');
    if (!id || seen.has(id)) throw new Error(`Duplicate or invalid work ID: ${id || '(missing)'}`);
    if (!validDate(work.release) || work.release > BASELINE_BUILD_CONFIG.cutoffInclusive) {
        throw new Error(`Invalid or post-cutoff release for ${id}: ${String(work.release)}`);
    }
    seen.add(id);
}

async function loadPassPages(directory) {
    await mkdir(directory, { recursive: true });
    const names = (await readdir(directory)).filter((name) => /^page-\d{6}\.json$/.test(name)).sort();
    const pages = [];
    for (let index = 0; index < names.length; index++) {
        const expected = `page-${String(index + 1).padStart(6, '0')}.json`;
        if (names[index] !== expected) throw new Error('Non-contiguous crawl checkpoint');
        pages.push(JSON.parse(await readFile(join(directory, names[index]), 'utf8')));
    }
    return pages;
}

export async function crawlWorksPass(options) {
    const directory = options.directory;
    const log = options.log || console.log;
    const label = directory.split('/').pop();
    const startedAt = Date.now();
    const pages = await loadPassPages(directory);
    const works = [];
    const seen = new Set();
    let totalCount;
    for (let index = 0; index < pages.length; index++) {
        const page = validatePage(pages[index], index + 1);
        if (totalCount !== undefined && page.totalCount !== totalCount) throw new Error('Total count changed within crawl pass');
        totalCount = page.totalCount;
        for (const work of page.works) { validateWork(work, seen); works.push(work); }
    }
    if (pages.length) log(`[baseline] ${label}: resumed ${pages.length} page(s), ${works.length}/${totalCount} works`);
    let pageNumber = pages.length + 1;
    while (totalCount === undefined || works.length < totalCount) {
        if (pageNumber > 1) await (options.sleepImpl || sleep)(options.pacingMs ?? PRODUCER_PACING_MS);
        const url = new URL('/api/works', options.apiBase);
        url.searchParams.set('page', String(pageNumber));
        url.searchParams.set('pageSize', String(PRODUCER_PAGE_SIZE));
        url.searchParams.set('order', 'id');
        url.searchParams.set('sort', 'asc');
        const response = await fetchWithRetry(url, options);
        const raw = await response.json();
        const page = validatePage(raw, pageNumber);
        if (totalCount !== undefined && page.totalCount !== totalCount) throw new Error('Total count changed within crawl pass');
        totalCount = page.totalCount;
        for (const work of page.works) { validateWork(work, seen); works.push(work); }
        await atomicJson(join(directory, `page-${String(pageNumber).padStart(6, '0')}.json`), raw);
        const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
        log(`[baseline] ${label} page ${pageNumber}: ${works.length}/${totalCount} works, ${elapsedSeconds.toFixed(1)}s, ${(works.length / elapsedSeconds).toFixed(1)} works/s`);
        if (page.works.length === 0 && works.length < totalCount) throw new Error('Works API ended before advertised total count');
        pageNumber += 1;
    }
    if (works.length !== totalCount) throw new Error(`Crawl count mismatch: ${works.length} != ${totalCount}`);
    return { works, totalCount };
}

export function reconcileCrawlPasses(first, second) {
    const firstEntries = first.works.map(prepareProducerEntry).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    const secondEntries = second.works.map(prepareProducerEntry).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    if (first.totalCount !== second.totalCount || firstEntries.length !== secondEntries.length
        || firstEntries.some((entry, index) => entry.id !== secondEntries[index].id || entry.fingerprint !== secondEntries[index].fingerprint)) {
        throw new Error('Works changed between reconciliation passes');
    }
    return second.works.slice().sort((left, right) => {
        const leftId = String(left.id);
        const rightId = String(right.id);
        return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
}

export function prepareProducerEntry(work) {
    const prepared = prepareSemanticWorkEntry(work);
    if (!prepared) throw new Error(`Work ${String(work?.id || '(missing)')} produced an empty semantic document`);
    const modelInput = canonicalSemanticPassageModelInput(prepared.payload);
    const fingerprint = createHash('sha256').update(stableSemanticJson({ entry: prepared.entry, modelInput })).digest('hex');
    return { id: prepared.entry.id, prepared, modelInput, fingerprint };
}

function isCatalogMutationError(error) {
    return /changed|count mismatch|Duplicate|ended before advertised/i.test(String(error?.message || error));
}

export async function crawlStableCatalog(options) {
    const maximumCycles = options.maximumReconciliationCycles ?? 3;
    const firstDirectory = join(options.stateDirectory, 'crawl-pass-1');
    const secondDirectory = join(options.stateDirectory, 'crawl-pass-2');
    for (let cycle = 1; cycle <= maximumCycles; cycle++) {
        try {
            const first = await crawlWorksPass({ ...options, directory: firstDirectory });
            const second = await crawlWorksPass({ ...options, directory: secondDirectory });
            return { works: reconcileCrawlPasses(first, second), totalCount: first.totalCount };
        } catch (error) {
            if (!isCatalogMutationError(error) || cycle === maximumCycles) throw error;
            await Promise.all([rm(firstDirectory, { recursive: true, force: true }), rm(secondDirectory, { recursive: true, force: true })]);
        }
    }
    throw new Error('Unable to reconcile a stable works catalog');
}

async function sha256File(path) {
    return createHash('sha256').update(await readFile(path)).digest('hex');
}

export async function createPinnedEmbedder(modelDirectory) {
    for (const [relativePath, expectedHash] of Object.entries(PINNED_MODEL_FILES)) {
        if (await sha256File(join(modelDirectory, relativePath)) !== expectedHash) throw new Error(`Pinned model asset SHA-256 mismatch: ${relativePath}`);
    }
    let transformers;
    try {
        transformers = await import('@huggingface/transformers');
    } catch {
        throw new Error('Install @huggingface/transformers@4.0.0-next.4 locally before running the producer');
    }
    const modulePath = fileURLToPath(import.meta.resolve('@huggingface/transformers'));
    const packageJson = JSON.parse(await readFile(join(dirname(modulePath), '..', 'package.json'), 'utf8'));
    if (packageJson.version !== TRANSFORMERS_VERSION) throw new Error(`Transformers.js version mismatch: ${String(packageJson.version)}`);
    transformers.env.allowRemoteModels = false;
    transformers.env.allowLocalModels = true;
    const extractor = await transformers.pipeline('feature-extraction', modelDirectory, {
        dtype: BASELINE_BUILD_CONFIG.dtype,
        device: 'cpu',
        local_files_only: true,
    });
    const embed = async (inputs) => {
        const tensor = await extractor(inputs, { pooling: 'mean', normalize: true });
        try {
            return tensor.tolist();
        } finally {
            tensor.dispose?.();
        }
    };
    embed.dispose = async () => { await extractor.dispose?.(); };
    return embed;
}

async function loadEntryBatches(directory) {
    await mkdir(directory, { recursive: true });
    const names = (await readdir(directory)).filter((name) => /^batch-\d{6}\.bin$/.test(name)).sort();
    const entries = [];
    for (let index = 0; index < names.length; index++) {
        const expected = `batch-${String(index + 1).padStart(6, '0')}.bin`;
        if (names[index] !== expected) throw new Error('Non-contiguous embedding checkpoint');
        const batch = decodeSemanticBinaryShard(await readFile(join(directory, names[index])));
        if (batch.dimension !== BASELINE_BUILD_CONFIG.dimension) throw new Error('Invalid embedding checkpoint dimension');
        entries.push(...batch.entries);
    }
    return { entries, nextBatch: names.length + 1 };
}

function validateVectors(vectors, expected) {
    if (!Array.isArray(vectors) || vectors.length !== expected) throw new Error('Embedding batch count mismatch');
    for (const vector of vectors) {
        if (!Array.isArray(vector) || vector.length !== BASELINE_BUILD_CONFIG.dimension || vector.some((value) => !Number.isFinite(value))) {
            throw new Error('Invalid embedding vector');
        }
        const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
        if (norm < 0.98 || norm > 1.02) throw new Error('Embedding vector is not normalized');
    }
}

export async function produceVectorBaseline(options) {
    if (![16, 32].includes(options.batchSize ?? 16)) throw new Error('Embedding batch size must be 16 or 32');
    const stateDirectory = resolve(options.stateDirectory);
    const outputDirectory = resolve(options.outputDirectory);
    await mkdir(stateDirectory, { recursive: true });
    // A new attempt must never leave a previous generation looking ready to
    // publish if this run is interrupted or rejects later. Preserve all crawl
    // and embedding checkpoints, plus the old data files, but revoke only the
    // completion attestations until a fresh generation is atomically promoted.
    await Promise.all([
        rm(join(stateDirectory, 'complete.json'), { force: true }),
        rm(join(outputDirectory, 'semantic-index/complete.json'), { force: true }),
    ]);
    const catalog = await crawlStableCatalog({ ...options, stateDirectory });
    const works = catalog.works;
    const entryDirectory = join(stateDirectory, 'entry-batches');
    let checkpoint = await loadEntryBatches(entryDirectory);
    const log = options.log || console.log;
    const preparedWorks = works.map(prepareProducerEntry);
    const checkpointMatches = checkpoint.entries.every((entry, index) => (
        entry?.id === preparedWorks[index]?.id && entry?.producerFingerprint === preparedWorks[index]?.fingerprint
    ));
    if (!checkpointMatches || checkpoint.entries.length > preparedWorks.length) {
        await rm(entryDirectory, { recursive: true, force: true });
        checkpoint = await loadEntryBatches(entryDirectory);
        log('[baseline] embeddings: canonical metadata changed; invalidated embedding checkpoints');
    }
    const embed = options.embed || await createPinnedEmbedder(resolve(options.modelDirectory));
    const entries = checkpoint.entries;
    const resumedEntryCount = entries.length;
    const batchSize = options.batchSize ?? 16;
    let batchNumber = checkpoint.nextBatch;
    const embeddingStartedAt = Date.now();
    if (entries.length) log(`[baseline] embeddings: resumed ${entries.length}/${works.length} entries from ${batchNumber - 1} batch(es)`);
    try {
    for (let start = entries.length; start < preparedWorks.length; start += batchSize) {
        const prepared = preparedWorks.slice(start, start + batchSize);
        const inputs = prepared.map((item) => item.modelInput);
        const vectors = await embed(inputs);
        validateVectors(vectors, prepared.length);
        const batchEntries = prepared.map((item, index) => ({
            ...item.prepared.entry,
            producerFingerprint: item.fingerprint,
            vector: vectors[index],
        }));
        await atomicBytes(
            join(entryDirectory, `batch-${String(batchNumber).padStart(6, '0')}.bin`),
            encodeSemanticBinaryShard(batchEntries, BASELINE_BUILD_CONFIG.dimension),
        );
        entries.push(...batchEntries);
        const elapsedSeconds = Math.max(0.001, (Date.now() - embeddingStartedAt) / 1000);
        log(`[baseline] embedding batch ${batchNumber}: ${entries.length}/${works.length} entries, ${elapsedSeconds.toFixed(1)}s, ${((entries.length - resumedEntryCount) / elapsedSeconds).toFixed(1)} entries/s`);
        batchNumber += 1;
    }
    if (entries.length !== works.length || entries.length !== catalog.totalCount) throw new Error('Producer is incomplete; refusing to build manifest');
    const finalDirectory = join(stateDirectory, 'crawl-final-verification');
    await rm(finalDirectory, { recursive: true, force: true });
    const finalPass = await crawlWorksPass({ ...options, directory: finalDirectory });
    try {
        reconcileCrawlPasses({ works, totalCount: catalog.totalCount }, finalPass);
    } catch {
        await Promise.all([
            rm(join(stateDirectory, 'crawl-pass-1'), { recursive: true, force: true }),
            rm(join(stateDirectory, 'crawl-pass-2'), { recursive: true, force: true }),
            rm(entryDirectory, { recursive: true, force: true }),
        ]);
        throw new Error('Catalog changed after embedding; crawl and embedding checkpoints were invalidated and no manifest was emitted');
    }
    const publishEntries = entries.map(({ producerFingerprint: _producerFingerprint, ...entry }) => entry);
    const generationDirectory = `${outputDirectory}.generation-${randomUUID()}`;
    await rm(generationDirectory, { recursive: true, force: true });
    let manifest;
    try {
        manifest = await writeBuiltVectorBaseline(publishEntries, generationDirectory, { datasetId: options.datasetId });
        const manifestPath = join(generationDirectory, 'semantic-index/manifest.json');
        const manifestBytes = await readFile(manifestPath);
        await atomicJson(join(generationDirectory, 'semantic-index/complete.json'), {
            markerVersion: 1,
            datasetId: manifest.datasetId,
            entryCount: manifest.entryCount,
            manifestBytes: manifestBytes.byteLength,
            manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
        });
        const backupDirectory = `${outputDirectory}.previous-${randomUUID()}`;
        let hadPrevious = false;
        try {
            await rename(outputDirectory, backupDirectory);
            hadPrevious = true;
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
        try {
            await rename(generationDirectory, outputDirectory);
        } catch (error) {
            if (hadPrevious) await rename(backupDirectory, outputDirectory);
            throw error;
        }
        if (hadPrevious) await rm(backupDirectory, { recursive: true, force: true });
    } finally {
        await rm(generationDirectory, { recursive: true, force: true });
    }
    await atomicJson(join(stateDirectory, 'complete.json'), { datasetId: options.datasetId, entryCount: entries.length });
    log(`[baseline] complete: ${entries.length} entries, ${manifest.shards.length} shard(s); manifest ready for manual review`);
    return manifest;
    } finally {
        await embed.dispose?.();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const [, , apiBase, stateDirectory, outputDirectory, datasetId, modelDirectory, batch = '16'] = process.argv;
    if (!apiBase || !stateDirectory || !outputDirectory || !datasetId || !modelDirectory) {
        throw new Error('Usage: node scripts/produce-vector-baseline.mjs <api-base> <state-dir> <output-dir> <dataset-id> <model-dir> [16|32]');
    }
    const manifest = await produceVectorBaseline({ apiBase, stateDirectory, outputDirectory, datasetId, modelDirectory, batchSize: Number(batch) });
    process.stdout.write(`Produced complete baseline ${manifest.datasetId} (${manifest.entryCount} entries)\n`);
}
