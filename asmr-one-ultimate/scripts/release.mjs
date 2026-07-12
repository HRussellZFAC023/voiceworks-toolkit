#!/usr/bin/env node
/**
 * Release script: releases the prepared package version, or bumps when that
 * version has already been released, then tags, pushes, and creates a release.
 *
 * Usage:
 *   npm run release          # from asmr-one-ultimate/
 *
 * The GitHub Release triggers the CI workflow which builds the userscript
 * and attaches it as a release asset. Greasy Fork's webhook then picks it up.
 */

import { readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(__dirname, '..', 'package.json');
const packageLockPath = resolve(__dirname, '..', 'package-lock.json');
const packageDir = resolve(__dirname, '..');
const userscriptPath = resolve(packageDir, 'dist', 'asmr-one-ultimate.user.js');
const repoRoot = resolve(__dirname, '..', '..');

const run = (command, args, cwd = repoRoot, env = process.env) => {
    console.log(`$ ${[command, ...args].join(' ')}`);
    execFileSync(command, args, { cwd, stdio: 'inherit', env });
};

const capture = (command, args, cwd = repoRoot) => execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

const commandSucceeds = (command, args, cwd = repoRoot) => {
    try {
        execFileSync(command, args, { cwd, stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
};

const writeJson = (path, value) => {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

/**
 * Keep the userscript's intentionally numeric version in both npm metadata
 * files. `npm version 155` is not usable here because npm rejects a bare
 * numeric value as invalid semver before it updates either file.
 */
const setNumericPackageVersion = (version) => {
    if (!/^\d+$/.test(version)) {
        throw new Error(`Expected a numeric userscript version, got: ${version}`);
    }

    const packageJson = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const packageLock = JSON.parse(readFileSync(packageLockPath, 'utf8'));
    const rootPackage = packageLock.packages?.[''];
    if (!rootPackage) {
        throw new Error('package-lock.json is missing its root package metadata.');
    }

    packageJson.version = version;
    packageLock.version = version;
    rootPackage.version = version;
    writeJson(pkgPath, packageJson);
    writeJson(packageLockPath, packageLock);
};

const dirty = capture('git', ['status', '--porcelain']);
if (dirty) {
    throw new Error('Release requires a clean working tree. Commit the complete release candidate first.');
}

const branch = capture('git', ['branch', '--show-current']);
if (!branch) throw new Error('Release cannot run from a detached HEAD.');
if (branch !== 'main') throw new Error(`Release must run from main, not ${branch}.`);

run('gh', ['auth', 'status']);
run('git', ['fetch', '--tags', 'origin']);
if (!commandSucceeds('git', ['merge-base', '--is-ancestor', 'origin/main', 'HEAD'])) {
    throw new Error('Local main does not contain origin/main. Reconcile remote changes before releasing.');
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const currentVersion = String(pkg.version);
if (!/^\d+$/.test(currentVersion)) {
    throw new Error(`Expected a numeric userscript version, got: ${currentVersion}`);
}

const currentTag = `v${currentVersion}`;
const tagExistsLocally = commandSucceeds('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${currentTag}`]);
const releaseExists = commandSucceeds('gh', ['release', 'view', currentTag, '--json', 'tagName']);

let releaseVersion = currentVersion;
let tagAlreadyPrepared = false;
if (tagExistsLocally && !releaseExists) {
    const taggedCommit = capture('git', ['rev-list', '-n', '1', currentTag]);
    const headCommit = capture('git', ['rev-parse', 'HEAD']);
    if (taggedCommit !== headCommit) {
        throw new Error(`${currentTag} exists without a release but does not point at HEAD.`);
    }
    tagAlreadyPrepared = true;
    console.log(`Resuming incomplete release for ${currentTag}.`);
} else if (tagExistsLocally && releaseExists) {
    const taggedCommit = capture('git', ['rev-list', '-n', '1', currentTag]);
    const headCommit = capture('git', ['rev-parse', 'HEAD']);
    if (taggedCommit === headCommit) {
        throw new Error(`${currentTag} is already released at HEAD; commit the next release candidate before bumping.`);
    }
    if (!commandSucceeds('git', ['merge-base', '--is-ancestor', currentTag, 'HEAD'])) {
        throw new Error(`${currentTag} is released but is not an ancestor of HEAD; reconcile history before bumping.`);
    }
    releaseVersion = String(Number(currentVersion) + 1);
    const nextTag = `v${releaseVersion}`;
    if (commandSucceeds('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${nextTag}`])) {
        throw new Error(`${nextTag} already exists; update package.json deliberately before releasing.`);
    }
    console.log(`$ set numeric package version ${releaseVersion}`);
    setNumericPackageVersion(releaseVersion);
    run('git', ['add', 'asmr-one-ultimate/package.json', 'asmr-one-ultimate/package-lock.json']);
    run('git', ['commit', '-m', `v${releaseVersion}`]);
    console.log(`Version: ${currentVersion} → ${releaseVersion}`);
} else {
    console.log(`Version: ${currentVersion} (prepared and not yet tagged)`);
}

const releaseTag = `v${releaseVersion}`;

// Nothing irreversible happens until the exact release candidate has passed
// the same compiler/unit/build gates plus browser integration coverage.
run('npm', ['run', 'test:run'], packageDir);
run('npm', ['run', 'typecheck'], packageDir);
run('npm', ['run', 'build'], packageDir);
if (capture('git', ['status', '--porcelain'])) {
    throw new Error('The verified build differs from the committed release candidate. Commit the rebuilt artifact and rerun release.');
}
run('npm', ['run', 'test:e2e'], packageDir, {
    ...process.env,
    E2E_PROXY: process.env.E2E_PROXY ?? '1',
});

if (!tagAlreadyPrepared) run('git', ['tag', releaseTag]);

run('git', ['push', 'origin', 'HEAD']);
run('git', ['push', 'origin', releaseTag]);

run('gh', [
    'release', 'create', releaseTag,
    userscriptPath,
    '--title', releaseTag,
    '--generate-notes',
]);

console.log(`\nDone! ${releaseTag} release created.`);
console.log(`The verified userscript is attached. CI will independently rebuild it; Greasy Fork will sync automatically.`);
