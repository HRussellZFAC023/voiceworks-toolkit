import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const MAX_USERSCRIPT_BYTES = 2 * 1024 * 1024;
const file = resolve('dist/asmr-one-ultimate.user.js');
const storefrontFile = resolve('..', 'asmr-one-ultimate.user.js');
const bytes = statSync(file).size;
const builtBytes = readFileSync(file);
const storefrontBytes = readFileSync(storefrontFile);
const source = builtBytes.toString('utf8');
const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));

if (bytes > MAX_USERSCRIPT_BYTES) {
    const over = bytes - MAX_USERSCRIPT_BYTES;
    throw new Error(`Userscript is ${bytes} bytes (${over} over the 2 MiB release limit)`);
}

const metadataVersion = source.match(/^\/\/ @version\s+(\S+)\s*$/m)?.[1];
if (metadataVersion !== String(pkg.version)) {
    throw new Error(`Userscript metadata version ${metadataVersion || '(missing)'} does not match package ${pkg.version}`);
}

if (!/^\/\/ @run-at\s+document-start\s*$/m.test(source)) {
    throw new Error('Userscript must run at document-start for region-gate recovery');
}

if (!source.includes('Bundled Material Icons font by Google')
    || !/Apache License\s+Version 2\.0, January 2004/.test(source)) {
    throw new Error('Userscript must retain the bundled Material Icons Apache-2.0 license copy');
}

if (!builtBytes.equals(storefrontBytes)) {
    throw new Error('Repo-root storefront artifact must match the built userscript byte-for-byte');
}

console.log(`Userscript size: ${bytes} / ${MAX_USERSCRIPT_BYTES} bytes`);
console.log(`Userscript metadata: v${metadataVersion}, document-start`);
console.log('Repo-root storefront artifact matches the build');
