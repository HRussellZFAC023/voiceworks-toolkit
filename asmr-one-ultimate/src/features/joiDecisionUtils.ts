export type JoiState = 'idle' | 'go' | 'stop' | 'edge' | 'cum' | 'denied' | 'ruined';
export type SemanticCategory = 'sexual' | 'stop' | 'encouragement' | 'climax' | 'edge' | 'neutral';

export type ScoreMap = Record<SemanticCategory, number>;

export interface ContextWindow {
    text: string;
    timestamp: number;
    scores: ScoreMap;
}

export interface VolumeDynamics {
    level: number;
    trend: number;
    intensity: number;
    isSilent: boolean;
    isHigh: boolean;
    isPeak: boolean;
}

export function createEmptyScores(): ScoreMap {
    return {
        sexual: 0,
        stop: 0,
        encouragement: 0,
        climax: 0,
        edge: 0,
        neutral: 0,
    };
}

export function aggregateContextScores(
    windows: ContextWindow[],
    now: number,
    contextWindowSec: number,
): ScoreMap {
    const aggregated = createEmptyScores();

    for (const window of windows) {
        const age = (now - window.timestamp) / 1000;
        const recency = Math.max(0.2, 1 - (age / contextWindowSec));
        for (const category of Object.keys(window.scores) as SemanticCategory[]) {
            aggregated[category] += window.scores[category] * recency;
        }
    }

    return aggregated;
}

export function applyStopScoreMultiplier(scores: ScoreMap, multiplier: number): ScoreMap {
    return {
        ...scores,
        stop: scores.stop * multiplier,
    };
}

export function applyVolumeTextAgreement(scores: ScoreMap, volume: VolumeDynamics, state: JoiState): ScoreMap {
    const adjusted = { ...scores };

    if (!volume.isSilent) {
        const volumeBoost = 1 + volume.intensity * 2; // 1x quiet -> 3x peak
        adjusted.sexual *= volumeBoost;
        adjusted.climax *= volumeBoost;
        adjusted.edge *= volumeBoost;
        adjusted.encouragement *= volumeBoost;

        if (volume.trend > 0.005) {
            adjusted.edge += volume.trend * 20;
            adjusted.encouragement += volume.trend * 10;
            if (adjusted.climax > 0) adjusted.climax += volume.trend * 15;
        }

        if (volume.isPeak) {
            adjusted.edge += 1.0;
            if (adjusted.climax > 0) adjusted.climax += 1.5;
        }

        if (volume.isHigh) {
            adjusted.stop *= 0.5;
        }
    } else {
        adjusted.climax *= 0.25;
        adjusted.encouragement *= 0.5;
        adjusted.sexual *= 0.5;
        if (state === 'go') {
            adjusted.stop += 0.5;
        }
    }

    return adjusted;
}

export function pickDominantCategory(scores: ScoreMap): { dominant: SemanticCategory; maxScore: number } {
    let dominant: SemanticCategory = 'neutral';
    let maxScore = 0;

    for (const category of Object.keys(scores) as SemanticCategory[]) {
        if (scores[category] > maxScore) {
            maxScore = scores[category];
            dominant = category;
        }
    }

    return { dominant, maxScore };
}

export function computeContextIntensity(windows: ContextWindow[], volumeIntensity: number): number {
    let total = 0;

    for (const window of windows) {
        total += window.scores.sexual + window.scores.climax * 1.5 + window.scores.edge;
    }

    total += volumeIntensity * 5;

    if (total > 8) return 3;
    if (total > 4) return 2;
    if (total > 1.5) return 1;
    return 0;
}
