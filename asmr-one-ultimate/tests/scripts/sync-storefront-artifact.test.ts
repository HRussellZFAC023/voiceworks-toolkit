import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// @ts-expect-error Standalone release helper intentionally remains plain ESM.
import { syncStorefrontArtifact } from '../../scripts/sync-storefront-artifact.mjs';

const temporaryRoots: string[] = [];

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('storefront artifact sync', () => {
    it('copies the built userscript byte-for-byte to the requested release path', () => {
        const root = mkdtempSync(join(tmpdir(), 'asmr-storefront-artifact-'));
        temporaryRoots.push(root);
        const source = join(root, 'dist.user.js');
        const destination = join(root, 'asmr-one-ultimate.user.js');
        const bytes = Buffer.from([0, 1, 2, 10, 255]);
        writeFileSync(source, bytes);

        const result = syncStorefrontArtifact({ source, destination });
        const secondResult = syncStorefrontArtifact({ source, destination });

        expect(readFileSync(destination)).toEqual(bytes);
        expect(result).toMatchObject({ source, destination });
        expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(secondResult.sha256).toBe(result.sha256);
    });

    it('cleans its temporary file when the source cannot be copied', () => {
        const root = mkdtempSync(join(tmpdir(), 'asmr-storefront-artifact-'));
        temporaryRoots.push(root);
        const destination = join(root, 'asmr-one-ultimate.user.js');
        writeFileSync(destination, 'previous release');

        expect(() => syncStorefrontArtifact({
            source: join(root, 'missing.user.js'),
            destination,
        })).toThrow();

        expect(readFileSync(destination, 'utf8')).toBe('previous release');
        expect(readdirSync(root)).toEqual(['asmr-one-ultimate.user.js']);
    });
});
