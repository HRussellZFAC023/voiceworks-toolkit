import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// @ts-expect-error Standalone build helper intentionally remains plain ESM.
import { embedThirdPartyLicenses } from '../../scripts/embed-third-party-licenses.mjs';

const temporaryRoots: string[] = [];

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('third-party license embedding', () => {
    it('places one exact Material Icons license copy after userscript metadata', () => {
        const root = mkdtempSync(join(tmpdir(), 'asmr-third-party-license-'));
        temporaryRoots.push(root);
        const userscriptPath = join(root, 'artifact.user.js');
        const materialIconsLicensePath = join(root, 'LICENSE');
        writeFileSync(userscriptPath, '// ==UserScript==\n// @version 177\n// ==/UserScript==\nrun();\n');
        writeFileSync(materialIconsLicensePath, 'Apache License\nVersion 2.0, January 2004\n');

        expect(embedThirdPartyLicenses({ userscriptPath, materialIconsLicensePath }).changed).toBe(true);
        expect(embedThirdPartyLicenses({ userscriptPath, materialIconsLicensePath }).changed).toBe(false);

        const artifact = readFileSync(userscriptPath, 'utf8');
        expect(artifact).toContain('// ==/UserScript==\n\n/*!\nBundled Material Icons font by Google');
        expect(artifact).toContain('Apache License\nVersion 2.0, January 2004');
        expect(artifact.match(/Bundled Material Icons font by Google/g)).toHaveLength(1);
        expect(artifact.endsWith('\nrun();\n')).toBe(true);
    });
});
