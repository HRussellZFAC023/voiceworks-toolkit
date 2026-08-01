import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, '..');
const defaultUserscriptPath = resolve(packageDir, 'dist', 'asmr-one-ultimate.user.js');
const defaultMaterialIconsLicensePath = resolve(
    packageDir,
    'node_modules',
    '@material-design-icons',
    'font',
    'LICENSE',
);
const metadataEnd = '// ==/UserScript==';
const noticeHeading = 'Bundled Material Icons font by Google, distributed under Apache License 2.0.';

export function embedThirdPartyLicenses({
    userscriptPath = defaultUserscriptPath,
    materialIconsLicensePath = defaultMaterialIconsLicensePath,
} = {}) {
    const source = readFileSync(userscriptPath, 'utf8');
    if (source.includes(noticeHeading)) return { changed: false, userscriptPath };

    const markerIndex = source.indexOf(metadataEnd);
    if (markerIndex < 0) throw new Error('Userscript metadata terminator is missing');

    const insertionPoint = markerIndex + metadataEnd.length;
    const license = readFileSync(materialIconsLicensePath, 'utf8').trim();
    const notice = `\n\n/*!\n${noticeHeading}\n\n${license}\n*/`;
    const next = `${source.slice(0, insertionPoint)}${notice}${source.slice(insertionPoint)}`;
    writeFileSync(userscriptPath, next);
    return { changed: true, userscriptPath };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
    const result = embedThirdPartyLicenses();
    console.log(`Third-party licenses ${result.changed ? 'embedded in' : 'already present in'} ${result.userscriptPath}`);
}
