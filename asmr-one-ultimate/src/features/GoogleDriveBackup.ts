/**
 * Google Drive destination for emergency playlist backups.
 *
 * Uses the narrow `drive.file` OAuth scope: the userscript can create and
 * update files it owns, but cannot read unrelated Drive contents. Own and
 * community playlists are always uploaded as separate JSON documents.
 */

import { gmRequest } from '../infrastructure/HttpClient';
import type { EmergencyExportDocument, ExportedPlaylist } from './EmergencyExport';

declare const unsafeWindow: Window & typeof globalThis;

const GOOGLE_IDENTITY_SCRIPT = 'https://accounts.google.com/gsi/client';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink';

interface GoogleTokenResponse {
    access_token?: string;
    error?: string;
    error_description?: string;
}

interface GoogleTokenClient {
    requestAccessToken(options?: { prompt?: string }): void;
}

interface GoogleIdentityWindow extends Window {
    google?: {
        accounts?: {
            oauth2?: {
                initTokenClient(config: {
                    client_id: string;
                    scope: string;
                    callback: (response: GoogleTokenResponse) => void;
                    error_callback?: (error: unknown) => void;
                }): GoogleTokenClient;
            };
        };
    };
}

let googleIdentityLoadPromise: Promise<GoogleIdentityWindow> | null = null;

interface EmergencyDriveBackupDocument {
    format: 'asmr-one-ultimate-playlist-backup';
    version: 1;
    exportedAt: string;
    source: string;
    playlistScope: 'own' | 'public';
    playlists: ExportedPlaylist[];
    errors: string[];
}

export interface DriveBackupFile {
    name: string;
    scope: 'own' | 'public';
    content: string;
}

export interface DriveUploadResult {
    id: string;
    name: string;
    webViewLink?: string;
}

export interface DriveUploadFailure {
    name: string;
    scope: 'own' | 'public';
    message: string;
}

export class DriveBackupUploadError extends Error {
    constructor(
        public readonly successful: DriveUploadResult[],
        public readonly failures: DriveUploadFailure[],
    ) {
        super(`Google Drive upload failed for: ${failures.map(failure => failure.name).join(', ')}`);
        this.name = 'DriveBackupUploadError';
    }
}

export interface DriveBackupDependencies {
    getAccessToken(clientId: string): Promise<string>;
    uploadFile(file: DriveBackupFile, accessToken: string): Promise<DriveUploadResult>;
}

function timestampSlug(iso: string): string {
    return iso.replace(/[:T]/g, '-').slice(0, 19);
}

export function buildDriveBackupFiles(doc: EmergencyExportDocument): DriveBackupFile[] {
    const stamp = timestampSlug(doc.exportedAt);
    const makeDocument = (
        playlistScope: 'own' | 'public',
        playlists: ExportedPlaylist[],
    ): EmergencyDriveBackupDocument => ({
        format: doc.format,
        version: doc.version,
        exportedAt: doc.exportedAt,
        source: doc.source,
        playlistScope,
        playlists,
        errors: doc.errors,
    });

    return [
        {
            name: `asmr-playlists-own-${stamp}.json`,
            scope: 'own',
            content: JSON.stringify(makeDocument('own', doc.ownPlaylists), null, 2),
        },
        {
            name: `asmr-playlists-public-${stamp}.json`,
            scope: 'public',
            content: JSON.stringify(makeDocument('public', doc.publicPlaylists), null, 2),
        },
    ];
}

function pageWindow(): GoogleIdentityWindow {
    return (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as GoogleIdentityWindow;
}

async function loadGoogleIdentity(): Promise<GoogleIdentityWindow> {
    const target = pageWindow();
    if (target.google?.accounts?.oauth2) return target;
    if (googleIdentityLoadPromise) return googleIdentityLoadPromise;

    googleIdentityLoadPromise = new Promise<GoogleIdentityWindow>((resolve, reject) => {
        const existing = document.querySelector<HTMLScriptElement>('script[data-asmr-google-identity]');
        const script = existing || document.createElement('script');
        let poll: number | null = null;
        const cleanup = () => {
            clearTimeout(timeout);
            if (poll !== null) clearInterval(poll);
        };
        const timeout = window.setTimeout(() => {
            cleanup();
            script.remove();
            reject(new Error('Google sign-in script timed out'));
        }, 20_000);
        const done = () => {
            if (!target.google?.accounts?.oauth2) return;
            cleanup();
            resolve(target);
        };
        script.addEventListener('load', done, { once: true });
        script.addEventListener('error', () => {
            cleanup();
            script.remove();
            reject(new Error('Could not load Google sign-in'));
        }, { once: true });
        // If a previous click inserted the script, its load event may already
        // have fired. Poll the namespace instead of waiting on a lost event.
        poll = window.setInterval(done, 100);
        if (!existing) {
            script.src = GOOGLE_IDENTITY_SCRIPT;
            script.async = true;
            script.defer = true;
            script.dataset.asmrGoogleIdentity = 'true';
            document.head.appendChild(script);
        }
        done();
    });
    try {
        return await googleIdentityLoadPromise;
    } catch (error) {
        googleIdentityLoadPromise = null;
        throw error;
    }
}

/** Preload GIS before a user click so the eventual consent popup retains user activation. */
export async function preloadGoogleDriveIdentity(): Promise<void> {
    await loadGoogleIdentity();
}

function requestAccessTokenFrom(target: GoogleIdentityWindow, clientId: string): Promise<string> {
    const oauth2 = target.google?.accounts?.oauth2;
    if (!oauth2) return Promise.reject(new Error('Google sign-in is unavailable'));

    return new Promise<string>((resolve, reject) => {
        const client = oauth2.initTokenClient({
            client_id: clientId,
            scope: DRIVE_SCOPE,
            callback: (response) => {
                if (response.access_token) resolve(response.access_token);
                else reject(new Error(response.error_description || response.error || 'Google Drive authorization failed'));
            },
            error_callback: (error) => reject(error instanceof Error ? error : new Error('Google Drive authorization was cancelled')),
        });
        // This call must happen synchronously inside the user's click handler
        // once GIS is preloaded; otherwise popup blockers may reject it.
        client.requestAccessToken({ prompt: 'consent' });
    });
}

export function requestGoogleDriveAccessToken(clientId: string): Promise<string> {
    const normalizedClientId = clientId.trim();
    if (!normalizedClientId) return Promise.reject(new Error('Google OAuth client ID is required'));

    const target = pageWindow();
    if (target.google?.accounts?.oauth2) {
        return requestAccessTokenFrom(target, normalizedClientId);
    }
    return loadGoogleIdentity().then((loaded) => requestAccessTokenFrom(loaded, normalizedClientId));
}

export async function uploadDriveBackupFile(
    file: DriveBackupFile,
    accessToken: string,
): Promise<DriveUploadResult> {
    const boundary = `asmr_ultimate_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const metadata = {
        name: file.name,
        mimeType: 'application/json',
        description: file.scope === 'own'
            ? 'ASMR.one Ultimate emergency backup — your playlists'
            : 'ASMR.one Ultimate emergency backup — community/public playlists',
        appProperties: { asmrUltimateBackup: 'true', playlistScope: file.scope },
    };
    const body = [
        `--${boundary}`,
        'Content-Type: application/json; charset=UTF-8',
        '',
        JSON.stringify(metadata),
        `--${boundary}`,
        'Content-Type: application/json; charset=UTF-8',
        '',
        file.content,
        `--${boundary}--`,
        '',
    ].join('\r\n');

    const response = await gmRequest({
        method: 'POST',
        url: DRIVE_UPLOAD_URL,
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        data: body,
        responseType: 'json',
        timeout: 60_000,
    });
    const parsed = response.response && typeof response.response === 'object'
        ? response.response as Partial<DriveUploadResult>
        : JSON.parse(response.responseText || '{}') as Partial<DriveUploadResult>;
    if (!parsed.id || !parsed.name) throw new Error('Google Drive returned an invalid upload response');
    return parsed as DriveUploadResult;
}

const defaultDependencies: DriveBackupDependencies = {
    getAccessToken: requestGoogleDriveAccessToken,
    uploadFile: uploadDriveBackupFile,
};

export async function uploadEmergencyExportToDrive(
    doc: EmergencyExportDocument,
    clientId: string,
    dependencies: DriveBackupDependencies = defaultDependencies,
): Promise<DriveUploadResult[]> {
    const accessToken = await dependencies.getAccessToken(clientId);
    const files = buildDriveBackupFiles(doc);
    // There are always exactly two independent files. Start both uploads
    // together so Drive latency is paid once while retaining deterministic
    // own/public result ordering and explicit partial-failure reporting.
    const results: DriveUploadResult[] = [];
    const failures: DriveUploadFailure[] = [];
    const settled = await Promise.allSettled(
        files.map((file) => dependencies.uploadFile(file, accessToken)),
    );
    settled.forEach((result, index) => {
        const file = files[index];
        if (result.status === 'fulfilled') {
            results.push(result.value);
        } else {
            failures.push({
                name: file.name,
                scope: file.scope,
                message: result.reason instanceof Error ? result.reason.message : 'Unknown upload error',
            });
        }
    });
    if (failures.length) throw new DriveBackupUploadError(results, failures);
    return results;
}
