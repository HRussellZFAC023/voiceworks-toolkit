export const DOWNLOAD_RESUME_SAMPLE_BYTES = 64 * 1024;

export interface DownloadResumeSample {
    offset: number;
    length: number;
    sha256: string;
}

export interface DownloadResumeFingerprint {
    version: 1;
    algorithm: 'SHA-256';
    checkpointOffset: number;
    samples: DownloadResumeSample[];
}

export type DownloadRangeReader = (offset: number, length: number) => Promise<Uint8Array>;

function sampleWindows(checkpointOffset: number): Array<{ offset: number; length: number }> {
    if (!Number.isSafeInteger(checkpointOffset) || checkpointOffset <= 0) return [];
    const length = Math.min(DOWNLOAD_RESUME_SAMPLE_BYTES, checkpointOffset);
    const windows = [
        { offset: 0, length },
        { offset: checkpointOffset - length, length },
    ];
    return windows.filter((window, index) => (
        windows.findIndex(candidate => (
            candidate.offset === window.offset && candidate.length === window.length
        )) === index
    ));
}

async function sha256(bytes: Uint8Array): Promise<string> {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) throw new Error('Cryptographic resume verification is unavailable');
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const digest = new Uint8Array(await subtle.digest('SHA-256', copy));
    return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function isDownloadResumeFingerprint(
    value: DownloadResumeFingerprint | undefined,
): value is DownloadResumeFingerprint {
    if (
        !value
        || value.version !== 1
        || value.algorithm !== 'SHA-256'
        || !Number.isSafeInteger(value.checkpointOffset)
        || value.checkpointOffset <= 0
        || !Array.isArray(value.samples)
        || value.samples.length < 1
        || value.samples.length > 2
    ) return false;
    const expected = sampleWindows(value.checkpointOffset);
    return value.samples.length === expected.length && value.samples.every((sample, index) => (
        sample.offset === expected[index]?.offset
        && sample.length === expected[index]?.length
        && /^[a-f0-9]{64}$/.test(sample.sha256)
    ));
}

/**
 * A sampled fingerprint may authorize remote append only when its samples
 * cover every committed byte. Larger prefixes retain the fingerprint solely
 * as a local damage hint; two boundary samples cannot prove an unchanged
 * middle.
 */
export function downloadResumeFingerprintCoversFullPrefix(
    fingerprint: DownloadResumeFingerprint | undefined,
): fingerprint is DownloadResumeFingerprint {
    if (!isDownloadResumeFingerprint(fingerprint)) return false;
    let coveredUntil = 0;
    for (const sample of fingerprint.samples) {
        if (sample.offset > coveredUntil) return false;
        coveredUntil = Math.max(coveredUntil, sample.offset + sample.length);
    }
    return coveredUntil >= fingerprint.checkpointOffset;
}

export async function createDownloadResumeFingerprint(
    checkpointOffset: number,
    readRange: DownloadRangeReader,
): Promise<DownloadResumeFingerprint> {
    const windows = sampleWindows(checkpointOffset);
    if (!windows.length) throw new RangeError('Resume fingerprint requires a positive checkpoint offset');
    const samples: DownloadResumeSample[] = [];
    for (const window of windows) {
        const bytes = await readRange(window.offset, window.length);
        if (bytes.byteLength !== window.length) {
            throw new Error('Committed file changed while creating its resume fingerprint');
        }
        samples.push({ ...window, sha256: await sha256(bytes) });
    }
    return {
        version: 1,
        algorithm: 'SHA-256',
        checkpointOffset,
        samples,
    };
}

export async function matchesDownloadResumeFingerprint(
    fingerprint: DownloadResumeFingerprint,
    readRange: DownloadRangeReader,
): Promise<boolean> {
    if (!isDownloadResumeFingerprint(fingerprint)) return false;
    for (const sample of fingerprint.samples) {
        const bytes = await readRange(sample.offset, sample.length);
        if (bytes.byteLength !== sample.length || await sha256(bytes) !== sample.sha256) return false;
    }
    return true;
}
