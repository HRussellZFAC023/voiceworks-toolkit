import { describe, expect, it } from 'vitest';
import {
    aggregateContextScores,
    applyStopScoreMultiplier,
    applyVolumeTextAgreement,
    computeContextIntensity,
    createEmptyScores,
    pickDominantCategory,
    type ContextWindow,
    type ScoreMap,
    type VolumeDynamics,
} from '../../src/features/joiDecisionUtils';

function scores(partial: Partial<ScoreMap>): ScoreMap {
    return { ...createEmptyScores(), ...partial };
}

describe('joiDecisionUtils', () => {
    it('aggregates context windows with recency weighting', () => {
        const now = Date.now();
        const windows: ContextWindow[] = [
            { text: 'recent', timestamp: now - 1000, scores: scores({ sexual: 2 }) },
            { text: 'old', timestamp: now - 12000, scores: scores({ sexual: 4 }) },
        ];

        const out = aggregateContextScores(windows, now, 15);
        expect(out.sexual).toBeGreaterThan(2);
        expect(out.sexual).toBeLessThan(6);
    });

    it('applies stop multiplier without mutating other scores', () => {
        const input = scores({ stop: 5, edge: 2 });
        const out = applyStopScoreMultiplier(input, 0.6);
        expect(out.stop).toBe(3);
        expect(out.edge).toBe(2);
    });

    it('applies volume-text agreement boosts for active audio', () => {
        const input = scores({ sexual: 2, climax: 1, edge: 1, encouragement: 1, stop: 2 });
        const vol: VolumeDynamics = {
            level: 0.12,
            trend: 0.01,
            intensity: 0.8,
            isSilent: false,
            isHigh: true,
            isPeak: false,
        };

        const out = applyVolumeTextAgreement(input, vol, 'go');
        expect(out.sexual).toBeGreaterThan(input.sexual);
        expect(out.edge).toBeGreaterThan(input.edge);
        expect(out.stop).toBeLessThan(input.stop);
    });

    it('dampens active signals and nudges stop during silence', () => {
        const input = scores({ sexual: 4, climax: 4, encouragement: 2, stop: 1 });
        const vol: VolumeDynamics = {
            level: 0,
            trend: -0.01,
            intensity: 0,
            isSilent: true,
            isHigh: false,
            isPeak: false,
        };

        const out = applyVolumeTextAgreement(input, vol, 'go');
        expect(out.sexual).toBeLessThan(input.sexual);
        expect(out.climax).toBeLessThan(input.climax);
        expect(out.stop).toBeGreaterThan(input.stop);
    });

    it('picks dominant category and score', () => {
        const out = pickDominantCategory(scores({ edge: 4.2, stop: 3.1 }));
        expect(out.dominant).toBe('edge');
        expect(out.maxScore).toBe(4.2);
    });

    it('computes context intensity buckets from text and volume', () => {
        const windows: ContextWindow[] = [
            { text: 'a', timestamp: Date.now(), scores: scores({ sexual: 1.5, edge: 1.5 }) },
        ];
        expect(computeContextIntensity(windows, 0)).toBe(1);
        expect(computeContextIntensity(windows, 0.8)).toBeGreaterThanOrEqual(2);
    });
});
