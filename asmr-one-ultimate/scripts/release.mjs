#!/usr/bin/env node
/**
 * Release script: releases the prepared package version, or bumps when that
 * version has already been released, then tags, pushes, and creates a release.
 *
 * Usage:
 *   npm run release          # from asmr-one-ultimate/
 *
 * The release is created as a draft, receives its verified asset, and is only
 * then published. This ordering ensures storefront webhooks never observe a
 * published release before its installable asset exists.
 */

import { readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(__dirname, '..', 'package.json');
const packageLockPath = resolve(__dirname, '..', 'package-lock.json');
const packageDir = resolve(__dirname, '..');
const userscriptPath = resolve(packageDir, 'dist', 'asmr-one-ultimate.user.js');
const repoRoot = resolve(__dirname, '..', '..');
const storefrontArtifactPath = resolve(repoRoot, 'asmr-one-ultimate.user.js');
const storefrontArtifactGitPath = 'asmr-one-ultimate.user.js';

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

const releaseNotFound = (error) => {
    const stderr = String(error?.stderr || '').trim().toLowerCase();
    return error?.status === 1 && stderr === 'release not found';
};

const findRelease = (tag) => {
    try {
        return JSON.parse(capture('gh', ['release', 'view', tag, '--json', 'tagName,isDraft']));
    } catch (error) {
        if (releaseNotFound(error)) return null;
        const detail = String(error?.stderr || error?.message || error).trim();
        throw new Error(`Could not inspect GitHub release ${tag}: ${detail}`);
    }
};

const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

const requireAnnotatedTagAtHead = (tag) => {
    const objectType = capture('git', ['cat-file', '-t', `refs/tags/${tag}`]);
    if (objectType !== 'tag') {
        throw new Error(`${tag} must be an annotated tag before its release can be resumed.`);
    }
    const taggedCommit = capture('git', ['rev-list', '-n', '1', tag]);
    const headCommit = capture('git', ['rev-parse', 'HEAD']);
    if (taggedCommit !== headCommit) {
        throw new Error(`${tag} does not point at HEAD.`);
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
const preparedLock = JSON.parse(readFileSync(packageLockPath, 'utf8'));
const lockVersion = String(preparedLock.version);
const lockRootVersion = String(preparedLock.packages?.['']?.version);
if (lockVersion !== currentVersion || lockRootVersion !== currentVersion) {
    throw new Error(
        `Prepared version metadata is inconsistent: package.json=${currentVersion}, `
        + `package-lock.json=${lockVersion}, package-lock root=${lockRootVersion}.`,
    );
}

const currentTag = `v${currentVersion}`;
const tagExistsLocally = commandSucceeds('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${currentTag}`]);
const existingRelease = findRelease(currentTag);
const releaseExists = existingRelease !== null;

let releaseVersion = currentVersion;
let tagAlreadyPrepared = false;
let draftAlreadyPrepared = false;
if (tagExistsLocally && !releaseExists) {
    requireAnnotatedTagAtHead(currentTag);
    tagAlreadyPrepared = true;
    console.log(`Resuming incomplete release for ${currentTag}.`);
} else if (tagExistsLocally && existingRelease?.isDraft) {
    requireAnnotatedTagAtHead(currentTag);
    tagAlreadyPrepared = true;
    draftAlreadyPrepared = true;
    console.log(`Resuming draft release for ${currentTag}.`);
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
if (!commandSucceeds('git', ['ls-files', '--error-unmatch', storefrontArtifactGitPath])) {
    throw new Error(
        `${storefrontArtifactGitPath} must be tracked at the repository root so storefront release webhooks can read it from the tag.`,
    );
}
const verifiedAssetHash = sha256File(userscriptPath);
const verifiedStorefrontHash = sha256File(storefrontArtifactPath);
if (verifiedStorefrontHash !== verifiedAssetHash) {
    throw new Error('The repo-root storefront artifact differs from the verified userscript build.');
}
run('npm', ['run', 'test:e2e'], packageDir, {
    ...process.env,
    E2E_PROXY: process.env.E2E_PROXY ?? '1',
});
if (capture('git', ['status', '--porcelain'])) {
    throw new Error('Browser integration tests changed the committed release candidate. Restore or commit those changes and rerun release.');
}
const postE2eAssetHash = sha256File(userscriptPath);
if (postE2eAssetHash !== verifiedAssetHash) {
    throw new Error('Browser integration tests changed the verified userscript asset. Rebuild and rerun release.');
}
const postE2eStorefrontHash = sha256File(storefrontArtifactPath);
if (postE2eStorefrontHash !== verifiedAssetHash) {
    throw new Error('Browser integration tests changed the repo-root storefront artifact. Rebuild and rerun release.');
}

if (!tagAlreadyPrepared) run('git', ['tag', '-m', releaseTag, releaseTag]);
if (!commandSucceeds('git', ['cat-file', '-e', `${releaseTag}:${storefrontArtifactGitPath}`])) {
    throw new Error(`${releaseTag} does not contain ${storefrontArtifactGitPath}; refusing to publish a broken storefront tag.`);
}

run('git', ['push', 'origin', 'HEAD']);
run('git', ['push', 'origin', releaseTag]);

if (!draftAlreadyPrepared) {
    run('gh', [
        'release', 'create', releaseTag,
        '--draft',
        '--title', releaseTag,
        '--generate-notes',
    ]);
}
run('gh', ['release', 'upload', releaseTag, storefrontArtifactPath, '--clobber']);
run('gh', ['release', 'edit', releaseTag, '--draft=false']);

console.log(`\nDone! ${releaseTag} release created.`);
console.log(`The verified userscript is attached. CI will independently rebuild it; SleazyFork will sync automatically.`);
