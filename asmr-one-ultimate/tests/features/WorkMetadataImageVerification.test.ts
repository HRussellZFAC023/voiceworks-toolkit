import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { verifyMetadataImageBatch } from '../../src/features/media/workMetadataImageVerification';

const source = readFileSync(
    resolve(process.cwd(), 'src/features/components/WorkMetadataPanel.vue'),
    'utf8',
);

describe('WorkMetadataPanel image verification wiring', () => {
    it('renders sample images only from the shared verified-blob path', () => {
        expect(source).toContain("import { fetchVerifiedImageBlob } from '../media/externalImageUtils'");
        expect(source).toContain("import { verifyMetadataImageBatch } from '../media/workMetadataImageVerification'");
        expect(source).toContain('const verified = await fetchVerifiedImageBlob(sourceUrl');
        expect(source).toContain('generation !== imageVerificationGeneration');
        expect(source).toContain('verifyMetadataImageBatch(');
        expect(source).toContain("return imageBlobUrls.value.get(url) || ''");
        expect(source).toContain('imageBlobUrls.value.has(url) && !hiddenImageUrls.value.has(url)');
        expect(source).not.toContain('HttpClient.getBlob(candidate');
        expect(source).not.toContain('imageBlobUrls.value.get(url) || toAbsoluteUrl(url)');
    });

    it('does not start queued image requests after the work generation changes', async () => {
        let generation = 1;
        const release: Array<() => void> = [];
        const verify = vi.fn(async (_url: string, expectedGeneration: number) => {
            await new Promise<void>((resolve) => release.push(resolve));
            return generation === expectedGeneration;
        });

        const batch = verifyMetadataImageBatch(
            ['one', 'two', 'three', 'four'],
            generation,
            () => generation,
            verify,
        );
        await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(3));

        generation = 2;
        release.splice(0).forEach(resolve => resolve());
        await batch;

        expect(verify).toHaveBeenCalledTimes(3);
        expect(verify.mock.calls.map(([url]) => url)).toEqual(['one', 'two', 'three']);
    });
});
