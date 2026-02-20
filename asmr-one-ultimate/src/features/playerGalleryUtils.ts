import type { PlayerTrack } from '../types/api';

export function normalizeWorkId(value: string | number | null | undefined): string | null {
    if (value == null) return null;

    const raw = String(value).trim();
    if (!raw) return null;

    const stripped = raw.replace(/^[A-Za-z]+/, '');
    if (!/^\d+$/.test(stripped)) return null;

    const asNumber = Number(stripped);
    if (!Number.isFinite(asNumber) || asNumber <= 0) return null;
    return String(asNumber);
}

export function parseWorkIdFromCoverUrl(coverUrl: string): string | null {
    if (!coverUrl) return null;
    const match = coverUrl.match(/\/cover\/((?:[A-Za-z]+)?\d+)/i);
    if (!match?.[1]) return null;
    return normalizeWorkId(match[1]);
}

type WorkIdTrackFields = Pick<PlayerTrack, 'work' | 'workId' | 'work_id'>;

export function parseWorkIdFromTrack(track: WorkIdTrackFields | null | undefined): string | null {
    if (!track) return null;
    return normalizeWorkId(track.work?.id ?? track.workId ?? track.work_id);
}

export function resolveGalleryWorkId(
    eventWorkId: string | number | null | undefined,
    track: WorkIdTrackFields | null | undefined,
): string | null {
    return normalizeWorkId(eventWorkId) ?? parseWorkIdFromTrack(track);
}
