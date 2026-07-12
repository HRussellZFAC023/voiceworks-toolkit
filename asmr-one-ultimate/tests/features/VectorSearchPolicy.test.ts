import { describe, expect, it } from 'vitest';
import { shouldAutoIndexVectors } from '../../src/features/vectorSearchPolicy';

describe('Vector Search background indexing policy', () => {
    it('runs automatically only on full-tier devices so Whisper is never lease-blocked on limited hardware', () => {
        const profile = {
            hasGpu: true,
            memory: 8,
            isMobile: false,
            gpuVendor: 'Apple M3',
        } as const;
        expect(shouldAutoIndexVectors({ ...profile, tier: 'full' })).toBe(true);
        expect(shouldAutoIndexVectors({ ...profile, tier: 'limited' })).toBe(false);
        expect(shouldAutoIndexVectors({ ...profile, tier: 'constrained' })).toBe(false);
    });

    it('keeps manual search available but disables background indexing on Firefox M1 compatibility profiles', () => {
        expect(shouldAutoIndexVectors({
            tier: 'full',
            hasGpu: true,
            memory: -1,
            isMobile: false,
            gpuVendor: 'Mozilla Apple M1, or similar',
        }, 'Mozilla/5.0 Firefox/153.0', 'MacIntel')).toBe(false);
    });
});
