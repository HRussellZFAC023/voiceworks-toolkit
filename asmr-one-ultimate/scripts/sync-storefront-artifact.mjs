#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const packageDir = resolve(dirname(scriptPath), '..');

export const DEFAULT_STOREFRONT_SOURCE = resolve(packageDir, 'dist', 'asmr-one-ultimate.user.js');
export const DEFAULT_STOREFRONT_DESTINATION = resolve(packageDir, '..', 'asmr-one-ultimate.user.js');

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

export function syncStorefrontArtifact({
    source = DEFAULT_STOREFRONT_SOURCE,
    destination = DEFAULT_STOREFRONT_DESTINATION,
} = {}) {
    const temporaryDestination = `${destination}.tmp-${randomUUID()}`;
    try {
        copyFileSync(source, temporaryDestination);
        renameSync(temporaryDestination, destination);
    } finally {
        rmSync(temporaryDestination, { force: true });
    }

    const sourceHash = sha256(source);
    const destinationHash = sha256(destination);
    if (sourceHash !== destinationHash) {
        throw new Error('The repo-root storefront artifact does not match the built userscript.');
    }

    return { source, destination, sha256: sourceHash };
}

if (process.argv[1] === scriptPath) {
    const result = syncStorefrontArtifact();
    console.log(`Storefront artifact: ${result.destination}`);
    console.log(`SHA-256: ${result.sha256}`);
}
