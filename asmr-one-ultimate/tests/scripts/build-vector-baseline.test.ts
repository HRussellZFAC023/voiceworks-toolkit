import { describe, expect, it } from 'vitest';
import { gunzipSync } from 'node:zlib';
// @ts-expect-error The standalone Node builder is an ESM deployment script.
import { buildVectorBaseline, BASELINE_BUILD_CONFIG, parseBaselineBuildInput } from '../../scripts/build-vector-baseline.mjs';
import {
    SEMANTIC_BASELINE_CUTOFF,
    SEMANTIC_EMBEDDING_DIMENSION,
    SEMANTIC_EMBEDDING_MODEL,
    SEMANTIC_EMBEDDING_MODEL_REVISION,
    SEMANTIC_EMBEDDING_DTYPE,
    SEMANTIC_MODEL_ONNX_SHA256,
    SEMANTIC_SHARD_FORMAT,
    SEMANTIC_PAYLOAD_RECIPE_VERSION,
} from '../../src/features/vectorSearchIndexTypes';

function entry(id: string, release = SEMANTIC_BASELINE_CUTOFF) {
    return {
        id, title: id, description: '', tags: [], release,
        vector: [1, ...Array.from({ length: SEMANTIC_EMBEDDING_DIMENSION - 1 }, () => 0)],
    };
}

describe('vector baseline builder', () => {
    it('keeps its compatibility contract aligned with the client', () => {
        expect(BASELINE_BUILD_CONFIG).toMatchObject({
            cutoffInclusive: SEMANTIC_BASELINE_CUTOFF,
            model: SEMANTIC_EMBEDDING_MODEL,
            modelRevision: SEMANTIC_EMBEDDING_MODEL_REVISION,
            dtype: SEMANTIC_EMBEDDING_DTYPE,
            modelOnnxSha256: SEMANTIC_MODEL_ONNX_SHA256,
            shardFormat: SEMANTIC_SHARD_FORMAT,
            dimension: SEMANTIC_EMBEDDING_DIMENSION,
            payloadRecipeVersion: SEMANTIC_PAYLOAD_RECIPE_VERSION,
        });
    });

    it('creates deterministic content-addressed shards', () => {
        const options = { datasetId: 'baseline-v1', generatedAt: '2026-07-14T00:00:00.000Z', shardMaxBytes: 10_000 };
        const first = buildVectorBaseline([entry('B'), entry('A')], options);
        const second = buildVectorBaseline([entry('A'), entry('B')], options);
        expect(first.manifest).toEqual(second.manifest);
        expect([...first.objects.keys()]).toEqual([...second.objects.keys()]);
        expect(first.manifest.shards[0].key).toContain(first.manifest.shards[0].sha256);
    });

    it('has stable gzip bytes and a versioned Float32LE header', () => {
        const built = buildVectorBaseline([entry('A')], {
            datasetId: 'gold', generatedAt: '2026-07-14T00:00:00.000Z',
        });
        const [key, body] = [...built.objects][0];
        expect(key).toBe('/semantic-index/objects/68cc1518990a9ba37509cf86fd88d9cba491814db295c946520a81f2fd6535ee.bin.gz');
        expect(Buffer.from(gunzipSync(body).subarray(0, 24)).toString('hex')).toBe(
            '41534d52564543000100000080010000010000004a000000',
        );
        expect(built.manifest.shards[0]).toMatchObject({ bytes: 126, decodedBytes: 1634, entryCount: 1 });
    });

    it('rejects duplicates, post-cutoff records, and malformed vectors', () => {
        expect(() => buildVectorBaseline([entry('A'), entry('A')], { datasetId: 'x' })).toThrow('Duplicate');
        expect(() => buildVectorBaseline([entry('A', '2026-07-15')], { datasetId: 'x' })).toThrow('Invalid');
        expect(() => buildVectorBaseline([{ ...entry('A'), vector: [1] }], { datasetId: 'x' })).toThrow('Invalid');
    });

    it('refuses unlabelled exports or vectors from a different compatibility contract', () => {
        expect(() => parseBaselineBuildInput([entry('A')])).toThrow('compatibility contract');
        expect(() => parseBaselineBuildInput({
            contract: { ...BASELINE_BUILD_CONFIG, payloadRecipeVersion: 'different' },
            entries: [entry('A')],
        })).toThrow('compatibility contract');
        expect(parseBaselineBuildInput({ contract: BASELINE_BUILD_CONFIG, entries: [entry('A')] })).toHaveLength(1);
    });
});
