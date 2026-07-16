import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Standalone Node publisher intentionally remains plain ESM.
import { buildCommunityPlaylistCatalog, normalizeSeedList, parseCommunityPublisherArgs, publishCommunityPlaylistCatalog, validateCatalog } from '../../scripts/publish-community-playlist-catalog.mjs';

const FIRST_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_ID = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-07-15T12:00:00.000Z');
const directories: string[] = [];

afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(ids = [FIRST_ID, SECOND_ID]) {
    const directory = await mkdtemp(join(tmpdir(), 'community-catalog-test-'));
    directories.push(directory);
    const seedsPath = join(directory, 'seeds.json');
    const outputPath = join(directory, 'output', 'catalog.json');
    const cachePath = join(directory, 'cache', 'catalog-cache.json');
    await writeFile(seedsPath, JSON.stringify(ids.map((id) => ({ id }))));
    return { directory, seedsPath, outputPath, cachePath, minimumCatalogSize: 1 };
}

function json(value: unknown, status = 200) {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function hydratorFetch(fail = new Set<string>()) {
    return vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        const id = url.searchParams.get('id')!;
        if (fail.has(id)) throw new Error(`offline: ${id}`);
        if (url.pathname.endsWith('get-playlist-metadata')) {
            if (id === FIRST_ID) return json({
                id, name: 'First list', user_name: 'Alice', privacy: 2, works_count: 1,
            });
            return json({
                id, name: 'Second list', user_name: 'Bob', privacy: 2, works_count: 2,
                coverUrl: 'https://example.test/second.jpg', tags: [{ name: 'ASMR' }],
            });
        }
        if (url.pathname.endsWith('get-playlist-works') && id === FIRST_ID) {
            return json({ works: [{ source_id: 'RJ123456', mainCoverUrl: 'https://example.test/first.jpg', tags: [{ name: 'Whisper' }] }] });
        }
        return json({}, 404);
    });
}

describe('community catalog validation and hydration', () => {
    it('strictly validates and deduplicates server-side UUID seeds', () => {
        expect(normalizeSeedList([{ id: FIRST_ID }, FIRST_ID, { id: SECOND_ID }])).toEqual([FIRST_ID, SECOND_ID]);
        expect(() => normalizeSeedList([{ id: FIRST_ID, name: 'not seed data' }])).toThrow('Unexpected');
        expect(() => normalizeSeedList(['AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'])).toThrow('Invalid');
        expect(() => validateCatalog({ version: 1, generatedAt: new Date(NOW).toISOString(), playlists: [] }))
            .toThrow('Invalid');
    });

    it('uses an absolute default floor so a truncated seed file cannot publish silently', async () => {
        const { minimumCatalogSize: _explicitFloor, ...paths } = await fixture([FIRST_ID]);
        await expect(buildCommunityPlaylistCatalog({
            ...paths,
            fetchImpl: hydratorFetch(),
            attempts: 1,
            concurrency: 1,
            startIntervalMs: 0,
            now: () => NOW,
        })).rejects.toThrow('minimum is 450');
    });

    it('hydrates through the maintained proxy, writes atomically, and reuses its resume cache', async () => {
        const paths = await fixture();
        const fetchImpl = hydratorFetch();
        const built = await buildCommunityPlaylistCatalog({
            ...paths,
            fetchImpl,
            attempts: 1,
            concurrency: 2,
            startIntervalMs: 0,
            now: () => NOW,
        });

        expect(built.catalog.playlists).toEqual([
            expect.objectContaining({ id: FIRST_ID, coverUrl: 'https://example.test/first.jpg', latestWorkId: 'RJ123456', tags: ['Whisper'] }),
            expect.objectContaining({ id: SECOND_ID, coverUrl: 'https://example.test/second.jpg', tags: ['ASMR'] }),
        ]);
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        expect(JSON.parse(await readFile(paths.outputPath, 'utf8'))).toEqual(built.catalog);
        expect(JSON.parse(await readFile(paths.cachePath, 'utf8')).entries[FIRST_ID].status).toBe('ok');

        const shouldNotFetch = vi.fn(async () => { throw new Error('fresh cache should avoid HTTP'); });
        const cached = await buildCommunityPlaylistCatalog({
            ...paths,
            fetchImpl: shouldNotFetch,
            attempts: 1,
            concurrency: 2,
            startIntervalMs: 0,
            now: () => NOW + 60_000,
        });
        expect(cached.catalog.playlists).toHaveLength(2);
        expect(shouldNotFetch).not.toHaveBeenCalled();

        await expect(buildCommunityPlaylistCatalog({
            ...paths,
            fetchImpl: shouldNotFetch,
            attempts: 1,
            concurrency: 1,
            startIntervalMs: 0,
            cacheTtlMs: 0,
            now: () => NOW + 120_000,
        })).rejects.toThrow('transient community playlist failure');
    });

    it('checkpoints successes so an interrupted build retries only unfinished playlists', async () => {
        const paths = await fixture();
        const firstRunFetch = hydratorFetch(new Set([SECOND_ID]));
        await expect(buildCommunityPlaylistCatalog({
            ...paths,
            fetchImpl: firstRunFetch,
            attempts: 1,
            concurrency: 1,
            startIntervalMs: 0,
            now: () => NOW,
        })).rejects.toThrow('successful progress is cached');

        const cache = JSON.parse(await readFile(paths.cachePath, 'utf8'));
        expect(cache.entries[FIRST_ID].status).toBe('ok');
        expect(cache.entries[SECOND_ID]).toBeUndefined();

        const secondRunFetch = hydratorFetch();
        const resumed = await buildCommunityPlaylistCatalog({
            ...paths,
            fetchImpl: secondRunFetch,
            attempts: 1,
            concurrency: 1,
            startIntervalMs: 0,
            now: () => NOW + 60_000,
        });
        expect(resumed.catalog.playlists).toHaveLength(2);
        expect(secondRunFetch.mock.calls.every(([input]) => String(input).includes(SECOND_ID))).toBe(true);
    });

    it('reports definitive exclusions separately and enforces the publication floor', async () => {
        const paths = await fixture();
        const fetchImpl = vi.fn(async (input: string | URL | Request) => {
            const url = new URL(String(input));
            const id = url.searchParams.get('id')!;
            return json({
                id,
                name: id === FIRST_ID ? 'Public' : 'Private',
                privacy: id === FIRST_ID ? 2 : 0,
                works_count: 0,
            });
        });
        const built = await buildCommunityPlaylistCatalog({
            ...paths,
            fetchImpl,
            attempts: 1,
            concurrency: 1,
            startIntervalMs: 0,
            minimumCatalogSize: 1,
            now: () => NOW,
        });
        expect(built.catalog.playlists.map((playlist: { id: string }) => playlist.id)).toEqual([FIRST_ID]);
        expect(built.summary).toMatchObject({
            seedCount: 2,
            catalogCount: 1,
            excludedCount: 1,
            exclusionReasons: { private: 1 },
        });
        expect(built.exclusions).toEqual([{ id: SECOND_ID, reason: 'private' }]);

        const strict = await fixture();
        await expect(buildCommunityPlaylistCatalog({
            ...strict,
            fetchImpl,
            attempts: 1,
            concurrency: 1,
            startIntervalMs: 0,
            minimumCatalogSize: 2,
            now: () => NOW,
        })).rejects.toThrow('minimum is 2');
    });

    it('fails rather than caching a malformed HTTP-200 response as a definitive exclusion', async () => {
        const paths = await fixture([FIRST_ID]);
        await expect(buildCommunityPlaylistCatalog({
            ...paths,
            fetchImpl: vi.fn(async () => json({ id: FIRST_ID, privacy: 2 })),
            attempts: 1,
            concurrency: 1,
            startIntervalMs: 0,
            now: () => NOW,
        })).rejects.toThrow('transient community playlist failure');
        await expect(readFile(paths.cachePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });
});

describe('guarded community catalog publication', () => {
    it('supports build-only and dry-run modes without remote R2 operations', async () => {
        for (const mode of ['buildOnly', 'dryRun'] as const) {
            const paths = await fixture([FIRST_ID]);
            const putObject = vi.fn();
            const getObject = vi.fn();
            const result = await publishCommunityPlaylistCatalog({
                ...paths,
                [mode]: true,
                fetchImpl: hydratorFetch(),
                attempts: 1,
                concurrency: 1,
                startIntervalMs: 0,
                now: () => NOW,
                putObject,
                getObject,
            });
            expect(result.status).toBe(mode === 'buildOnly' ? 'built' : 'dry-run');
            expect(putObject).not.toHaveBeenCalled();
            expect(getObject).not.toHaveBeenCalled();
        }
    });

    it('uploads and verifies an immutable object before replacing the canonical catalog last', async () => {
        const paths = await fixture([FIRST_ID]);
        const remote = new Map<string, Buffer>();
        const order: string[] = [];
        const putObject = vi.fn(async (object: { key: string; path: string }) => {
            order.push(`put:${object.key}`);
            remote.set(object.key, await readFile(object.path));
        });
        const getObject = vi.fn(async (key: string) => {
            order.push(`get:${key}`);
            return remote.get(key)!;
        });
        const result = await publishCommunityPlaylistCatalog({
            ...paths,
            fetchImpl: hydratorFetch(),
            attempts: 1,
            concurrency: 1,
            startIntervalMs: 0,
            now: () => NOW,
            putObject,
            getObject,
        });

        expect(result.status).toBe('published');
        expect(order[0]).toMatch(/^put:community-playlists\/objects\/[a-f0-9]{64}\.json$/);
        expect(order.at(-2)).toBe('put:community-playlists/catalog.json');
        expect(order.at(-1)).toBe('get:community-playlists/catalog.json');
    });

    it('parses safe CLI defaults and rejects conflicting or malformed flags', () => {
        expect(parseCommunityPublisherArgs(['--build-only', '--concurrency', '4'])).toMatchObject({
            buildOnly: true,
            dryRun: false,
            concurrency: 4,
            startIntervalMs: 250,
            bucket: 'asmr-semantic-index',
        });
        expect(() => parseCommunityPublisherArgs(['--dry-run', '--build-only'])).toThrow('mutually exclusive');
        expect(() => parseCommunityPublisherArgs(['--concurrency', '0'])).toThrow('integer from 1 to 8');
        expect(() => parseCommunityPublisherArgs(['--proxy', 'http://localhost'])).toThrow('HTTPS');
        expect(() => parseCommunityPublisherArgs(['--min-playlists', '0'])).toThrow('integer from 1 to 5000');
        expect(() => parseCommunityPublisherArgs(['--unknown'])).toThrow('Unknown option');
    });
});
