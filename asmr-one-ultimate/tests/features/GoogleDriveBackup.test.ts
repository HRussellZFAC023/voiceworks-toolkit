import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ gmRequest: vi.fn() }));

vi.mock('../../src/infrastructure/HttpClient', () => ({
    gmRequest: mocks.gmRequest,
}));

import {
    buildDriveBackupFiles,
    DriveBackupUploadError,
    requestGoogleDriveAccessToken,
    uploadEmergencyExportToDrive,
    uploadDriveBackupFile,
} from '../../src/features/GoogleDriveBackup';
import type { EmergencyExportDocument } from '../../src/features/EmergencyExport';

function makeDocument(): EmergencyExportDocument {
    return {
        format: 'asmr-one-ultimate-playlist-backup',
        version: 1,
        exportedAt: '2026-07-10T20:00:00.000Z',
        source: 'https://asmr.one',
        ownPlaylists: [{ id: 'own', name: 'Mine', description: '', worksCount: 1, works: [{ rjCode: 'RJ111111', title: 'Own' }] }],
        publicPlaylists: [{ id: 'public', name: 'Community', description: '', worksCount: 1, works: [{ rjCode: 'RJ222222', title: 'Public' }] }],
        errors: [],
    };
}

describe('GoogleDriveBackup', () => {
    beforeEach(() => {
        mocks.gmRequest.mockReset();
    });

    it('builds distinct own and public JSON files', () => {
        const files = buildDriveBackupFiles(makeDocument());
        expect(files.map(file => file.name)).toEqual([
            'asmr-playlists-own-2026-07-10-20-00-00.json',
            'asmr-playlists-public-2026-07-10-20-00-00.json',
        ]);
        const own = JSON.parse(files[0].content);
        const publicBackup = JSON.parse(files[1].content);
        expect(own.playlistScope).toBe('own');
        expect(own.playlists[0].works[0].rjCode).toBe('RJ111111');
        expect(publicBackup.playlistScope).toBe('public');
        expect(publicBackup.playlists[0].works[0].rjCode).toBe('RJ222222');
        expect(files[0].content).not.toContain('RJ222222');
        expect(files[1].content).not.toContain('RJ111111');
    });

    it('authorizes once and starts both independent uploads concurrently', async () => {
        const order: string[] = [];
        const getAccessToken = vi.fn(async () => 'token');
        let resolveOwn!: (value: { id: string; name: string }) => void;
        const uploadFile = vi.fn((file: { name: string }) => {
            order.push(file.name);
            if (file.name.includes('-own-')) {
                return new Promise<{ id: string; name: string }>(resolve => { resolveOwn = resolve; });
            }
            return Promise.resolve({ id: 'public-id', name: file.name });
        });

        const uploadPromise = uploadEmergencyExportToDrive(makeDocument(), 'client-id', {
            getAccessToken,
            uploadFile,
        });
        await vi.waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(2));

        // The public upload starts while the own upload is deliberately held.
        expect(order[0]).toContain('-own-');
        expect(order[1]).toContain('-public-');
        resolveOwn({ id: 'own-id', name: order[0] });
        const results = await uploadPromise;

        expect(getAccessToken).toHaveBeenCalledOnce();
        expect(results).toHaveLength(2);
    });

    it('continues the independent upload and reports an explicit partial outcome', async () => {
        const uploadFile = vi.fn()
            .mockResolvedValueOnce({ id: 'own-id', name: 'asmr-playlists-own.json' })
            .mockRejectedValueOnce(new Error('public upload unavailable'));

        let thrown: unknown;
        try {
            await uploadEmergencyExportToDrive(makeDocument(), 'client-id', {
                getAccessToken: async () => 'token',
                uploadFile,
            });
        } catch (error) {
            thrown = error;
        }

        expect(uploadFile).toHaveBeenCalledTimes(2);
        expect(thrown).toBeInstanceOf(DriveBackupUploadError);
        expect(thrown).toMatchObject({
            successful: [{ id: 'own-id', name: 'asmr-playlists-own.json' }],
            failures: [{ scope: 'public', message: 'public upload unavailable' }],
        });
    });

    it('requests the narrow Drive scope through Google Identity Services', async () => {
        let tokenConfig: {
            client_id: string;
            scope: string;
            callback: (response: { access_token: string }) => void;
        } | undefined;
        const requestAccessToken = vi.fn(() => tokenConfig?.callback({ access_token: 'access-token' }));
        vi.stubGlobal('unsafeWindow', {
            google: {
                accounts: {
                    oauth2: {
                        initTokenClient: vi.fn((config) => {
                            tokenConfig = config;
                            return { requestAccessToken };
                        }),
                    },
                },
            },
        });

        try {
            const tokenPromise = requestGoogleDriveAccessToken(' client-id ');
            // GIS must be invoked before the click handler yields so browser
            // popup blockers still recognize the user activation.
            expect(requestAccessToken).toHaveBeenCalledWith({ prompt: 'consent' });
            await expect(tokenPromise).resolves.toBe('access-token');
            expect(tokenConfig).toMatchObject({
                client_id: 'client-id',
                scope: 'https://www.googleapis.com/auth/drive.file',
            });
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('uploads JSON as a Drive multipart request without mixing scopes', async () => {
        mocks.gmRequest.mockResolvedValue({
            response: { id: 'drive-id', name: 'asmr-playlists-own.json', webViewLink: 'https://drive.example/file' },
            responseText: '',
        });

        const result = await uploadDriveBackupFile({
            name: 'asmr-playlists-own.json',
            scope: 'own',
            content: JSON.stringify({ playlistScope: 'own', playlists: [{ id: 'mine' }] }),
        }, 'access-token');

        expect(result.id).toBe('drive-id');
        const request = mocks.gmRequest.mock.calls[0][0] as {
            method: string;
            url: string;
            headers: Record<string, string>;
            data: string;
        };
        expect(request.method).toBe('POST');
        expect(request.url).toContain('upload/drive/v3/files?uploadType=multipart');
        expect(request.headers.Authorization).toBe('Bearer access-token');
        expect(request.headers['Content-Type']).toMatch(/^multipart\/related; boundary=/);
        expect(request.data).toContain('"playlistScope":"own"');
        expect(request.data).not.toContain('"playlistScope":"public"');
    });
});
