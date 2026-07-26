import { describe, expect, it } from 'vitest';
import { selectWhisperSchedulingWindow } from '../../src/features/whisperSchedulingPolicy';

const BASE_INPUT = {
    adaptive: true,
    foregroundChunkSeconds: 8,
    foregroundOverlapSeconds: 2,
    catchUpChunkSeconds: 29,
    catchUpOverlapSeconds: 5,
};

describe('whisperSchedulingPolicy', () => {
    it('keeps the responsive window for a bounded seek backfill', () => {
        expect(selectWhisperSchedulingWindow({
            ...BASE_INPUT,
            backlogSeconds: 15,
            throughputRatio: 0.5,
        })).toEqual({
            chunkLengthSeconds: 8,
            overlapSeconds: 2,
            catchUp: false,
        });
    });

    it('uses longer context only when measured short-window throughput cannot keep up', () => {
        expect(selectWhisperSchedulingWindow({
            ...BASE_INPUT,
            backlogSeconds: 30,
            throughputRatio: 0.72,
        })).toEqual({
            chunkLengthSeconds: 29,
            overlapSeconds: 5,
            catchUp: true,
        });
        expect(selectWhisperSchedulingWindow({
            ...BASE_INPUT,
            backlogSeconds: 30,
            throughputRatio: 1.4,
        }).catchUp).toBe(false);
    });

    it('recovers a severe backlog before a stable speed sample exists', () => {
        expect(selectWhisperSchedulingWindow({
            ...BASE_INPUT,
            backlogSeconds: 60,
            throughputRatio: null,
        }).catchUp).toBe(true);
    });

    it('pins the foreground window when adaptation is disabled', () => {
        expect(selectWhisperSchedulingWindow({
            ...BASE_INPUT,
            adaptive: false,
            backlogSeconds: 300,
            throughputRatio: 0.2,
        }).catchUp).toBe(false);
    });
});
