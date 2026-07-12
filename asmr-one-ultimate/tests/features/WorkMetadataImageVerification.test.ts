import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
    resolve(process.cwd(), 'src/features/components/WorkMetadataPanel.vue'),
    'utf8',
);

describe('WorkMetadataPanel image verification wiring', () => {
    it('renders sample images only from the shared verified-blob path', () => {
        expect(source).toContain("import { fetchVerifiedImageBlob } from '../media/externalImageUtils'");
        expect(source).toContain('const verified = await fetchVerifiedImageBlob(sourceUrl');
        expect(source).toContain("return imageBlobUrls.value.get(url) || ''");
        expect(source).toContain('imageBlobUrls.value.has(url) && !hiddenImageUrls.value.has(url)');
        expect(source).not.toContain('HttpClient.getBlob(candidate');
        expect(source).not.toContain('imageBlobUrls.value.get(url) || toAbsoluteUrl(url)');
    });
});
