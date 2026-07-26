import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    chmodSync,
    copyFileSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

type TagState = { commit: string; type: 'tag' | 'commit' };
type ReleaseState = { isDraft: boolean; assets?: { name: string; body: string }[] };
type HarnessState = {
    head: string;
    phase: string;
    tags: Record<string, TagState>;
    releases: Record<string, ReleaseState>;
    tagAncestor?: boolean;
    releaseLookupError?: boolean;
    failCreateAfterMutation?: boolean;
    dirtyAfterE2e?: boolean;
    mutateAssetAfterE2e?: boolean;
    mutateStorefrontAfterE2e?: boolean;
    omitStorefrontMirrorAfterBuild?: boolean;
    mismatchStorefrontMirrorAfterBuild?: boolean;
    storefrontMirrorTracked?: boolean;
    storefrontArtifactInTag?: boolean;
    dropUploadedAsset?: boolean;
    corruptPublishedAsset?: boolean;
};

const temporaryRoots: string[] = [];
const sourceScript = resolve(import.meta.dirname, '../../scripts/release.mjs');

// Each scenario intentionally spawns the real release script plus isolated
// fake git/gh/npm processes. Allow headroom on loaded CI runners.
vi.setConfig({ testTimeout: 15_000 });

const fakeCli = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const statePath = process.env.RELEASE_TEST_STATE;
const logPath = process.env.RELEASE_TEST_LOG;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
fs.appendFileSync(logPath, JSON.stringify([command, ...args]) + '\n');
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const fail = (message, status = 1) => { process.stderr.write(message + '\n'); save(); process.exit(status); };
const out = (value) => process.stdout.write(String(value) + '\n');

if (command === 'npm') {
    const task = args[1];
    if (task === 'build') {
        state.phase = 'built';
        fs.mkdirSync(path.join(process.cwd(), 'dist'), { recursive: true });
        fs.writeFileSync(path.join(process.cwd(), 'dist', 'asmr-one-ultimate.user.js'), 'verified asset');
        const storefrontPath = path.join(process.cwd(), '..', 'asmr-one-ultimate.user.js');
        if (state.omitStorefrontMirrorAfterBuild) {
            fs.rmSync(storefrontPath, { force: true });
        } else {
            fs.writeFileSync(storefrontPath, state.mismatchStorefrontMirrorAfterBuild ? 'different asset' : 'verified asset');
        }
    } else if (task === 'test:e2e') {
        state.phase = 'e2e';
        if (state.mutateAssetAfterE2e) {
            fs.writeFileSync(path.join(process.cwd(), 'dist', 'asmr-one-ultimate.user.js'), 'mutated asset');
        }
        if (state.mutateStorefrontAfterE2e) {
            fs.writeFileSync(path.join(process.cwd(), '..', 'asmr-one-ultimate.user.js'), 'mutated storefront asset');
        }
    }
    save();
    process.exit(0);
}

if (command === 'gh') {
    if (args[0] === 'auth') process.exit(0);
    const tag = args[2];
    if (args[0] === 'release' && args[1] === 'view') {
        if (state.releaseLookupError) fail('network unavailable', 2);
        const release = state.releases[tag];
        if (!release) fail('release not found', 1);
        const assets = (release.assets || []).map((asset) => ({ name: asset.name }));
        out(JSON.stringify({ tagName: tag, isDraft: release.isDraft, assets }));
        process.exit(0);
    }
    if (args[0] === 'release' && args[1] === 'create') {
        state.releases[tag] = { isDraft: true };
        if (state.failCreateAfterMutation) {
            state.failCreateAfterMutation = false;
            fail('connection closed after draft creation', 1);
        }
        save();
        process.exit(0);
    }
    if (args[0] === 'release' && args[1] === 'upload') {
        const source = args[3];
        const release = state.releases[tag] || (state.releases[tag] = { isDraft: true });
        if (!state.dropUploadedAsset) {
            release.assets = [{ name: path.basename(source), body: fs.readFileSync(source, 'utf8') }];
        }
        save();
        process.exit(0);
    }
    if (args[0] === 'release' && args[1] === 'download') {
        const release = state.releases[tag];
        const asset = ((release && release.assets) || [])[0];
        if (!asset) fail('no assets to download', 1);
        const dir = args[args.indexOf('--dir') + 1];
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, asset.name), state.corruptPublishedAsset ? 'tampered asset' : asset.body);
        process.exit(0);
    }
    if (args[0] === 'release' && args[1] === 'edit') {
        state.releases[tag] = { isDraft: false };
        save();
        process.exit(0);
    }
    fail('unexpected gh command: ' + args.join(' '));
}

if (command === 'git') {
    if (args[0] === 'status') {
        if (state.phase === 'e2e' && state.dirtyAfterE2e) out(' M dist/asmr-one-ultimate.user.js');
        process.exit(0);
    }
    if (args[0] === 'branch') { out('main'); process.exit(0); }
    if (args[0] === 'ls-files') {
        process.exit(state.storefrontMirrorTracked !== false && fs.existsSync(path.join(process.cwd(), args.at(-1))) ? 0 : 1);
    }
    if (args[0] === 'fetch' || args[0] === 'add' || args[0] === 'push') process.exit(0);
    if (args[0] === 'merge-base') {
        if (args[2] === 'origin/main') process.exit(0);
        process.exit(state.tagAncestor ? 0 : 1);
    }
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
        const tag = args.at(-1).replace('refs/tags/', '');
        process.exit(state.tags[tag] ? 0 : 1);
    }
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') { out(state.head); process.exit(0); }
    if (args[0] === 'rev-list') {
        const tag = args.at(-1);
        if (!state.tags[tag]) fail('unknown tag');
        out(state.tags[tag].commit);
        process.exit(0);
    }
    if (args[0] === 'cat-file') {
        if (args[1] === '-e') {
            const [tag] = args.at(-1).split(':');
            process.exit(
                state.tags[tag]
                && state.storefrontArtifactInTag !== false
                && fs.existsSync(path.join(process.cwd(), 'asmr-one-ultimate.user.js'))
                    ? 0
                    : 1
            );
        }
        const tag = args.at(-1).replace('refs/tags/', '');
        if (!state.tags[tag]) fail('unknown tag');
        out(state.tags[tag].type);
        process.exit(0);
    }
    if (args[0] === 'commit') {
        state.head = 'bumped-head';
        save();
        process.exit(0);
    }
    if (args[0] === 'tag') {
        const tag = args.at(-1);
        state.tags[tag] = { commit: state.head, type: 'tag' };
        save();
        process.exit(0);
    }
    fail('unexpected git command: ' + args.join(' '));
}

fail('unexpected executable: ' + command);
`;

function createHarness(
    initial: Partial<HarnessState> = {},
    versions = { package: '159', lock: '159', root: '159' },
) {
    const root = mkdtempSync(join(tmpdir(), 'asmr-release-test-'));
    temporaryRoots.push(root);
    const packageDir = join(root, 'asmr-one-ultimate');
    const scriptsDir = join(packageDir, 'scripts');
    const binDir = join(root, 'bin');
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(join(packageDir, 'dist'), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    copyFileSync(sourceScript, join(scriptsDir, 'release.mjs'));
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'fixture', version: versions.package }));
    writeFileSync(join(packageDir, 'package-lock.json'), JSON.stringify({
        name: 'fixture', version: versions.lock, packages: { '': { name: 'fixture', version: versions.root } },
    }));
    writeFileSync(join(packageDir, 'dist', 'asmr-one-ultimate.user.js'), 'committed asset');
    writeFileSync(join(root, 'asmr-one-ultimate.user.js'), 'committed asset');
    for (const command of ['git', 'gh', 'npm']) {
        const executable = join(binDir, command);
        writeFileSync(executable, fakeCli);
        chmodSync(executable, 0o755);
    }
    const statePath = join(root, 'state.json');
    const logPath = join(root, 'commands.jsonl');
    const state: HarnessState = {
        head: 'head',
        phase: 'initial',
        tags: {},
        releases: {},
        ...initial,
    };
    writeFileSync(statePath, JSON.stringify(state));
    writeFileSync(logPath, '');

    const run = () => spawnSync(process.execPath, [join(scriptsDir, 'release.mjs')], {
        cwd: packageDir,
        encoding: 'utf8',
        env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            RELEASE_TEST_STATE: statePath,
            RELEASE_TEST_LOG: logPath,
        },
    });
    const commands = () => readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
    const readState = () => JSON.parse(readFileSync(statePath, 'utf8')) as HarnessState;
    return { root, packageDir, run, commands, readState, logPath };
}

function commandIndex(commands: string[][], ...prefix: string[]) {
    return commands.findIndex((command) => prefix.every((part, index) => command[index] === part));
}

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('release state machine', () => {
    it('publishes a fresh prepared version only after draft creation and asset upload', () => {
        const harness = createHarness();
        const result = harness.run();
        expect(result.status, result.stderr).toBe(0);
        const commands = harness.commands();
        const tag = commandIndex(commands, 'git', 'tag');
        const create = commandIndex(commands, 'gh', 'release', 'create');
        const upload = commandIndex(commands, 'gh', 'release', 'upload');
        const publish = commandIndex(commands, 'gh', 'release', 'edit');
        const tagArtifactCheck = commandIndex(commands, 'git', 'cat-file', '-e');
        expect([tag, create, upload, publish]).toEqual([...[tag, create, upload, publish]].sort((a, b) => a - b));
        expect(tagArtifactCheck).toBeGreaterThan(tag);
        expect(tagArtifactCheck).toBeLessThan(commandIndex(commands, 'git', 'push'));
        expect(commands[tag]).toEqual(['git', 'tag', '-m', 'v159', 'v159']);
        expect(commands[upload]).toEqual([
            'gh', 'release', 'upload', 'v159', realpathSync(join(harness.root, 'asmr-one-ultimate.user.js')), '--clobber',
        ]);
        expect(harness.readState().releases.v159).toEqual({ isDraft: false });
    });

    it('refuses to publish when the upload left no asset behind', () => {
        // v172-v174 all published with zero assets, 404ing the
        // releases/latest/download install URL and failing CI every time.
        const harness = createHarness({ dropUploadedAsset: true });
        const result = harness.run();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/no asmr-one-ultimate\.user\.js asset/i);
        expect(commandIndex(harness.commands(), 'gh', 'release', 'edit')).toBe(-1);
        expect(harness.readState().releases.v159.isDraft).toBe(true);
    });

    it('refuses to publish when the published asset differs from the verified build', () => {
        const harness = createHarness({ corruptPublishedAsset: true });
        const result = harness.run();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/does not match the verified build/i);
        expect(commandIndex(harness.commands(), 'gh', 'release', 'edit')).toBe(-1);
        expect(harness.readState().releases.v159.isDraft).toBe(true);
    });

    it('bumps and commits when the released package tag is an ancestor', () => {
        const harness = createHarness({
            tags: { v159: { commit: 'old', type: 'tag' } },
            releases: { v159: { isDraft: false } },
            tagAncestor: true,
        });
        const result = harness.run();
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(readFileSync(join(harness.packageDir, 'package.json'), 'utf8')).version).toBe('160');
        expect(harness.commands()).toContainEqual(['git', 'commit', '-m', 'v160']);
        expect(harness.commands()).toContainEqual(['git', 'tag', '-m', 'v160', 'v160']);
    });

    it('rejects a released tag still pointing at HEAD', () => {
        const harness = createHarness({
            tags: { v159: { commit: 'head', type: 'tag' } },
            releases: { v159: { isDraft: false } },
        });
        const result = harness.run();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('already released at HEAD');
        expect(commandIndex(harness.commands(), 'npm')).toBe(-1);
    });

    it('rejects released history that is not an ancestor of HEAD', () => {
        const harness = createHarness({
            tags: { v159: { commit: 'old', type: 'tag' } },
            releases: { v159: { isDraft: false } },
            tagAncestor: false,
        });
        const result = harness.run();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('is not an ancestor of HEAD');
        expect(commandIndex(harness.commands(), 'npm')).toBe(-1);
    });

    it('resumes an annotated local tag without recreating it', () => {
        const harness = createHarness({ tags: { v159: { commit: 'head', type: 'tag' } } });
        const result = harness.run();
        expect(result.status, result.stderr).toBe(0);
        expect(commandIndex(harness.commands(), 'git', 'tag')).toBe(-1);
        expect(commandIndex(harness.commands(), 'gh', 'release', 'create')).toBeGreaterThan(-1);
    });

    it('resumes an existing draft at upload without recreating it', () => {
        const harness = createHarness({
            tags: { v159: { commit: 'head', type: 'tag' } },
            releases: { v159: { isDraft: true } },
        });
        const result = harness.run();
        expect(result.status, result.stderr).toBe(0);
        expect(commandIndex(harness.commands(), 'gh', 'release', 'create')).toBe(-1);
        expect(commandIndex(harness.commands(), 'gh', 'release', 'upload')).toBeGreaterThan(-1);
        expect(harness.readState().releases.v159.isDraft).toBe(false);
    });

    it.each([
        ['lightweight', { commit: 'head', type: 'commit' as const }, 'annotated tag'],
        ['wrong-commit', { commit: 'other', type: 'tag' as const }, 'does not point at HEAD'],
    ])('rejects a %s resumed tag', (_name, tag, message) => {
        const harness = createHarness({ tags: { v159: tag } });
        const result = harness.run();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(message);
        expect(commandIndex(harness.commands(), 'npm')).toBe(-1);
    });

    it('does not misclassify an operational release lookup failure as absence', () => {
        const harness = createHarness({ releaseLookupError: true });
        const result = harness.run();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('Could not inspect GitHub release v159');
        expect(commandIndex(harness.commands(), 'npm')).toBe(-1);
    });

    it('recovers when draft creation succeeded remotely before the command failed', () => {
        const harness = createHarness({ failCreateAfterMutation: true });
        const first = harness.run();
        expect(first.status).not.toBe(0);
        expect(harness.readState().releases.v159).toEqual({ isDraft: true });
        writeFileSync(harness.logPath, '');
        const second = harness.run();
        expect(second.status, second.stderr).toBe(0);
        expect(commandIndex(harness.commands(), 'gh', 'release', 'create')).toBe(-1);
        expect(harness.readState().releases.v159).toEqual({ isDraft: false });
    }, 30_000);

    it('rejects inconsistent prepared package metadata before testing', () => {
        const harness = createHarness({}, { package: '159', lock: '158', root: '159' });
        const result = harness.run();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('Prepared version metadata is inconsistent');
        expect(commandIndex(harness.commands(), 'npm')).toBe(-1);
    });

    it('rejects a userscript changed by browser integration tests', () => {
        const harness = createHarness({ mutateAssetAfterE2e: true });
        const result = harness.run();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('changed the verified userscript asset');
        expect(commandIndex(harness.commands(), 'git', 'tag')).toBe(-1);
    });

    it('rejects a dirty working tree after browser integration tests', () => {
        const harness = createHarness({ dirtyAfterE2e: true });
        const result = harness.run();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('Browser integration tests changed the committed release candidate');
        expect(commandIndex(harness.commands(), 'git', 'tag')).toBe(-1);
    });

    it('rejects a release tag that would not contain the repo-root storefront artifact', () => {
        const harness = createHarness({ omitStorefrontMirrorAfterBuild: true });
        const result = harness.run();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('must be tracked at the repository root');
        expect(commandIndex(harness.commands(), 'git', 'tag')).toBe(-1);
    });

    it('rejects a repo-root storefront artifact whose bytes differ from the verified build', () => {
        const harness = createHarness({ mismatchStorefrontMirrorAfterBuild: true });
        const result = harness.run();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('storefront artifact differs');
        expect(commandIndex(harness.commands(), 'git', 'tag')).toBe(-1);
    });

    it('rejects an untracked repo-root storefront artifact', () => {
        const harness = createHarness({ storefrontMirrorTracked: false });
        const result = harness.run();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('must be tracked at the repository root');
        expect(commandIndex(harness.commands(), 'git', 'tag')).toBe(-1);
    });

    it('rejects a repo-root storefront artifact changed by browser integration tests', () => {
        const harness = createHarness({ mutateStorefrontAfterE2e: true });
        const result = harness.run();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('changed the repo-root storefront artifact');
        expect(commandIndex(harness.commands(), 'git', 'tag')).toBe(-1);
    });

    it('rejects a resumed tag that does not contain the repo-root storefront artifact', () => {
        const harness = createHarness({
            tags: { v159: { commit: 'head', type: 'tag' } },
            storefrontArtifactInTag: false,
        });
        const result = harness.run();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('does not contain asmr-one-ultimate.user.js');
        expect(commandIndex(harness.commands(), 'git', 'push')).toBe(-1);
        expect(commandIndex(harness.commands(), 'gh', 'release', 'create')).toBe(-1);
    });
});
