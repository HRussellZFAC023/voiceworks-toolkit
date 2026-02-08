/**
 * WorkUtils - Shared utilities for working with work/track data structures
 *
 * Consolidates duplicated logic from RadioMode, PlaylistGenerator, and other features.
 */

import type { AudioTrack, WorkFolder, WorkDetail, PlayerTrack } from '../types';
import { getAudioElement } from './DomUtils';
import { SCORING } from './Constants';

// ============================================================================
// Track Collection
// ============================================================================

/**
 * Recursively collect all audio tracks from a work's folder structure
 */
export function collectTracks(folder: WorkFolder | WorkDetail): AudioTrack[] {
    const tracks: AudioTrack[] = [];
    const queue: (WorkFolder | WorkDetail)[] = [folder];

    while (queue.length) {
        const curr = queue.shift();
        if (!curr) continue;

        // Collect tracks from this node
        if ('tracks' in curr && Array.isArray(curr.tracks)) {
            tracks.push(...curr.tracks);
        }

        // Queue subdirectories
        if ('dirs' in curr && Array.isArray(curr.dirs)) {
            queue.push(...curr.dirs);
        }
        if ('children' in curr && Array.isArray(curr.children)) {
            queue.push(...(curr.children as WorkFolder[]));
        }
    }

    return tracks;
}

/**
 * Flatten a work structure and return only audio tracks (deduplicated)
 */
export function flattenWork(work: WorkDetail | WorkFolder): AudioTrack[] {
    const tracks: AudioTrack[] = [];
    const seenHashes = new Set<string>();
    const queue: (WorkFolder | WorkDetail | AudioTrack)[] = [work];

    while (queue.length) {
        const curr = queue.shift();
        if (!curr) continue;

        // Collect tracks from this node
        if ('tracks' in curr && Array.isArray(curr.tracks)) {
            for (const track of curr.tracks) {
                if (track?.is_audio === false) continue;
                const key = getTrackKey(track);
                if (key && seenHashes.has(key)) continue;
                if (key) seenHashes.add(key);
                tracks.push(track);
            }
        }

        // Queue subdirectories
        if ('dirs' in curr && Array.isArray(curr.dirs)) {
            queue.push(...curr.dirs);
        }
        if ('children' in curr && Array.isArray(curr.children)) {
            queue.push(...(curr.children as WorkFolder[]));
        }

        // Handle single audio nodes
        const trackAny = curr as AudioTrack;
        const isAudio = trackAny.type === 'audio' ||
            trackAny.mediaStreamUrl ||
            trackAny.stream_url ||
            trackAny.media_stream_url;

        if (isAudio && trackAny.is_audio !== false) {
            const key = getTrackKey(trackAny);
            if (!key || !seenHashes.has(key)) {
                if (key) seenHashes.add(key);
                tracks.push(trackAny);
            }
        }
    }

    return tracks;
}

/**
 * Get a unique key for a track (for deduplication)
 */
export function getTrackKey(track: AudioTrack): string | null {
    return track.hash ||
        track.mediaStreamUrl ||
        track.stream_url ||
        track.media_stream_url ||
        track.title ||
        null;
}

/**
 * Filter tracks to only include audio files
 */
export function filterAudioTracks(tracks: AudioTrack[]): AudioTrack[] {
    return tracks.filter(track => track.is_audio !== false);
}

/**
 * Try to flatten a work's structure if it has no top-level tracks
 * Returns true if flattening was performed
 */
export function tryFlatten(vm: { work?: WorkDetail; tracks?: AudioTrack[]; dirs?: WorkFolder[] }): boolean {
    const root = vm.work || vm;
    if (!root) return false;

    const allTracks = collectTracks(root as WorkFolder);
    if (allTracks.length === 0) return false;

    if (!vm.tracks || vm.tracks.length === 0) {
        vm.tracks = allTracks;
        vm.dirs = [];
        return true;
    }

    return false;
}

// ============================================================================
// Audio Source Resolution
// ============================================================================

const AUDIO_URL_KEYS = [
    'mediaDownloadUrl',
    'media_download_url',
    'file_url',
    'url',
    'src',
    'mediaStreamUrl',
    'stream_url',
    'media_stream_url',
] as const;

/**
 * Resolve the best audio source URL from a track
 * Prefers download URLs over stream URLs for transcription
 */
export function resolveAudioSource(
    track: AudioTrack,
    options?: { preferNonHLS?: boolean }
): string | null {
    const urls: string[] = [];

    // Collect all potential URLs from the track
    const trackObj = track as unknown as Record<string, unknown>;
    for (const key of AUDIO_URL_KEYS) {
        const value = trackObj[key];
        if (typeof value === 'string' && value.trim()) {
            urls.push(value);
        }
    }

    if (urls.length === 0) return null;

    // If preferring non-HLS, find the first non-HLS URL
    if (options?.preferNonHLS) {
        const nonHLS = urls.find(url => !isHLSUrl(url));
        if (nonHLS) return nonHLS;
    }

    return urls[0];
}

/**
 * Resolve audio source from player state and track
 * Checks multiple sources including queue and DOM
 */
export function resolveAudioSourceFromPlayer(
    player: { queue?: PlayerTrack[]; playlist?: PlayerTrack[]; queueIndex?: number; currentTrack?: PlayerTrack; currentPlayingFile?: PlayerTrack },
    track?: AudioTrack
): string | null {
    // Build list of source objects to check
    const sources: (AudioTrack | undefined)[] = [
        track,
        player.queue?.[player.queueIndex || 0],
        player.playlist?.[player.queueIndex || 0],
        player.currentTrack,
        player.currentPlayingFile,
    ].filter(Boolean) as AudioTrack[];

    // Collect all URLs
    const allUrls: string[] = [];
    for (const source of sources) {
        const sourceObj = source as unknown as Record<string, unknown>;
        for (const key of AUDIO_URL_KEYS) {
            const value = sourceObj[key];
            if (typeof value === 'string' && value.trim()) {
                allUrls.push(value);
            }
        }
    }

    // Also check DOM audio element
    const audio = getAudioElement();
    if (audio?.currentSrc) allUrls.push(audio.currentSrc);
    if (audio?.src) allUrls.push(audio.src);

    // Find best non-HLS URL
    const nonHLS = allUrls.find(url => !isHLSUrl(url));
    return nonHLS || allUrls[0] || null;
}

/**
 * Check if a URL is an HLS stream
 */
export function isHLSUrl(url: string): boolean {
    return /\.m3u8($|\?)/i.test(url) || /\/hls\//i.test(url);
}

// ============================================================================
// Duration Parsing
// ============================================================================

// Duration units ordered by length (longest first) to prevent partial matches
// e.g., "1.5hr" should match "hr" not "h"
const DURATION_UNITS: Array<[RegExp, number]> = [
    [/(\d+\.?\d*)\s*hours?/i, 3600],
    [/(\d+\.?\d*)\s*hr/i, 3600],
    [/(\d+\.?\d*)\s*h(?![a-z])/i, 3600],
    [/(\d+\.?\d*)\s*minutes?/i, 60],
    [/(\d+\.?\d*)\s*mins?/i, 60],
    [/(\d+\.?\d*)\s*m(?![a-z])/i, 60],
    [/(\d+\.?\d*)\s*seconds?/i, 1],
    [/(\d+\.?\d*)\s*secs?/i, 1],
    [/(\d+\.?\d*)\s*s(?![a-z])/i, 1],
];

/**
 * Parse a duration caption string into seconds
 * Handles formats like "2hr 30min", "45s", "1.5hr"
 */
export function parseDuration(caption: string): number {
    if (!caption) return 0;

    const str = caption.toLowerCase();
    let seconds = 0;
    const matched = new Set<number>(); // Track which positions we've matched

    for (const [regex, multiplier] of DURATION_UNITS) {
        const match = str.match(regex);
        if (match && match.index !== undefined) {
            // Skip if we've already matched at this position
            if (matched.has(match.index)) continue;
            matched.add(match.index);
            seconds += parseFloat(match[1]) * multiplier;
        }
    }

    return seconds;
}

/**
 * Format seconds into a readable duration string
 */
export function formatDuration(seconds: number): string {
    if (!seconds || seconds <= 0) return '--:--';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

// ============================================================================
// Smart Folder Selection
// ============================================================================

const SAMPLE_REGEX = /サンプル|Sample|Trial|Preview|体験版|お試し/i;
const COVER_REGEX = /封面|cover|illust|ジャケット/i;
const SCRIPT_REGEX = /script|台本|剧本|脚本/i;
const IMAGE_REGEX = /画像|image file|images?$/i;
const SE_REGEX = /\bSE\b|^SE[なな有無し]|Sound Effect|音効|効果音/;
const SE_ARI_REGEX = /あり/;
const SE_NASHI_REGEX = /無し|なし/;
const FORMAT_PRIORITY = ['wav', 'mp3', 'flac', 'opus', 'm4a', 'aac'];

export interface FolderCandidate {
    name: string;
    score: number;
    original: WorkFolder;
}

/**
 * Calculate a score for a folder based on naming conventions and content
 */
export function calculateFolderScore(
    name: string,
    trackCount: number,
    caption: string,
    isSample: boolean,
    formatPriority: string[] = FORMAT_PRIORITY,
    childFormats: string[] = [],
    sePreference?: boolean
): number {
    let score = 0;
    const lowerName = (name || '').toLowerCase();

    // Duration bonus
    const duration = parseDuration(caption);
    if (duration > 0) {
        score += (duration / 60) * 10;
    }

    // Track count bonus
    score += (trackCount || 0) * 5;

    // Penalties
    if (isSample || SAMPLE_REGEX.test(name)) {
        score += SCORING.SAMPLE_FOLDER_PENALTY;
    }
    if (COVER_REGEX.test(lowerName)) {
        score += SCORING.COVER_FOLDER_PENALTY;
    }
    if (SCRIPT_REGEX.test(lowerName)) {
        score += SCORING.SCRIPT_FOLDER_PENALTY;
    }
    if (IMAGE_REGEX.test(name)) {
        score += SCORING.IMAGE_FOLDER_PENALTY;
    }

    // SE preference: boost folders matching the user's あり/無し preference
    if (sePreference != null && (SE_ARI_REGEX.test(name) || SE_NASHI_REGEX.test(name))) {
        if (sePreference && SE_ARI_REGEX.test(name)) {
            score += SCORING.SE_PREF_BONUS;
        } else if (!sePreference && SE_NASHI_REGEX.test(name)) {
            score += SCORING.SE_PREF_BONUS;
        } else {
            score += SCORING.SE_FOLDER_PENALTY;
        }
    } else if (SE_REGEX.test(name)) {
        score += SCORING.SE_FOLDER_PENALTY;
    }

    // Boost folders with "BGM無し" / "No BGM" (clean audio preferred)
    if (/BGM[なな無]し|No\s*BGM/i.test(name)) {
        score += SCORING.BGM_BONUS;
    }

    // Format priority bonus (from folder name)
    const activePriority = formatPriority.length > 0 ? formatPriority : FORMAT_PRIORITY;
    let formatBonusApplied = false;

    for (let i = 0; i < activePriority.length; i++) {
        const format = activePriority[i].toLowerCase().trim();
        if (format && lowerName.includes(format)) {
            score += (activePriority.length - i) * 100000;
            formatBonusApplied = true;
            break;
        }
    }

    // Format priority bonus (from actual child files) - higher weight than name-based matching
    if (childFormats.length > 0) {
        for (let i = 0; i < activePriority.length; i++) {
            const format = activePriority[i].toLowerCase().trim();
            if (format && childFormats.some(f => f.toLowerCase().includes(format))) {
                // If we didn't apply the name bonus, apply a large one. 
                // If we did, add even more to reinforce it.
                score += (activePriority.length - i) * 200000;
                formatBonusApplied = true;
                break;
            }
        }
    }

    return score;
}

/**
 * Select the best folder from a list based on scoring
 */
export function selectBestFolder(folders: WorkFolder[], formatPriority: string[] = FORMAT_PRIORITY): WorkFolder | null {
    if (!folders?.length) return null;

    const candidates: FolderCandidate[] = folders.map(folder => ({
        name: folder.name || folder.title || '',
        score: calculateFolderScore(
            folder.name || folder.title || '',
            folder.children_count || folder.tracks?.length || 0,
            folder.caption || folder.duration_text || '',
            false,
            formatPriority
        ),
        original: folder,
    }));

    candidates.sort((a, b) => b.score - a.score);

    // Only return if score is above threshold
    return candidates[0]?.score > SCORING.MINIMUM_VIABLE_SCORE ? candidates[0].original : null;
}

/**
 * Get the name of the best folder (legacy compatibility)
 */
export function selectBestFolderName(folders: WorkFolder[]): string | null {
    const best = selectBestFolder(folders);
    return best ? (best.name || best.title || null) : null;
}

// ============================================================================
// Array Utilities
// ============================================================================

/**
 * Fisher-Yates shuffle algorithm
 */
export function shuffleArray<T>(array: T[]): T[] {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

/**
 * Shuffle array in place
 */
export function shuffleInPlace<T>(array: T[]): void {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}
