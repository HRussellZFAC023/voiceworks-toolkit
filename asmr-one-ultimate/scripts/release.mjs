#!/usr/bin/env node
/**
 * Release script: bumps version, commits, tags, pushes, and creates a GitHub Release.
 *
 * Usage:
 *   npm run release          # from asmr-one-ultimate/
 *
 * The GitHub Release triggers the CI workflow which builds the userscript
 * and attaches it as a release asset. Greasy Fork's webhook then picks it up.
 */

import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(__dirname, '..', 'package.json');

// 1. Bump version
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const oldVersion = pkg.version;
const newVersion = String(Number(oldVersion) + 1);
pkg.version = newVersion;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

console.log(`Version: ${oldVersion} → ${newVersion}`);

// 2. Stage & commit (from repo root so git works regardless of cwd)
const repoRoot = resolve(__dirname, '..', '..');
const run = (cmd) => {
    console.log(`$ ${cmd}`);
    execSync(cmd, { cwd: repoRoot, stdio: 'inherit' });
};

run(`git add asmr-one-ultimate/package.json`);
run(`git commit -m "v${newVersion}"`);
run(`git tag v${newVersion}`);

// 3. Push commit + tag
run(`git push`);
run(`git push --tags`);

// 4. Create GitHub Release (triggers the CI workflow + Greasy Fork webhook)
run(`gh release create v${newVersion} --title "v${newVersion}" --generate-notes`);

console.log(`\nDone! v${newVersion} release created.`);
console.log(`CI will build and attach the userscript. Greasy Fork will sync automatically.`);
