import { describe, expect, it } from 'vitest';
import { decodeSemanticBinaryShard, encodeSemanticBinaryShard } from '../../src/features/vectorSearchBinaryShard';

describe('semantic binary shard container', () => {
    it('round-trips deterministic metadata and Float32LE vectors', () => {
        const encoded = encodeSemanticBinaryShard([{
            id: 'RJ1', title: 'One', description: '', tags: ['tag'], release: '2026-07-14', vector: [0.5, -0.25],
        }], 2);
        expect(Buffer.from(encoded.subarray(0, 24)).toString('hex')).toBe('41534d525645430001000000020000000100000053000000');
        const decoded = decodeSemanticBinaryShard(encoded);
        expect(decoded).toMatchObject({ version: 1, dimension: 2, count: 1 });
        expect(decoded.entries[0]).toMatchObject({ id: 'RJ1', title: 'One' });
        expect(decoded.entries[0].vector).toBeInstanceOf(Float32Array);
        expect([...decoded.entries[0].vector]).toEqual([0.5, -0.25]);
    });

    it('rejects corrupt magic and trailing bytes', () => {
        const encoded = encodeSemanticBinaryShard([{
            id: 'RJ1', title: 'One', description: '', tags: [], release: '2026-07-14', vector: [1],
        }], 1);
        const corruptMagic = encoded.slice();
        corruptMagic[0] = 0;
        expect(() => decodeSemanticBinaryShard(corruptMagic)).toThrow('magic');
        const trailing = new Uint8Array(encoded.length + 1);
        trailing.set(encoded);
        expect(() => decodeSemanticBinaryShard(trailing)).toThrow('length');
    });
});
