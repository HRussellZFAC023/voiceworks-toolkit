import { describe, it, expect } from 'vitest';
import { classifyDeviceTier, isIntelMac } from '../../src/core/DeviceCapabilities';

describe('DeviceCapabilities', () => {
    describe('isIntelMac', () => {
        it('detects Intel macOS user agents', () => {
            const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36';
            expect(isIntelMac(ua, 'MacIntel')).toBe(true);
        });

        it('does not match Apple Silicon platforms', () => {
            const appleSiliconUa = 'Mozilla/5.0 (Macintosh; Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15';
            expect(isIntelMac(appleSiliconUa, 'MacArm')).toBe(false);
        });
    });

    describe('classifyDeviceTier', () => {
        it('classifies Intel Mac as limited for safer ML defaults', () => {
            const tier = classifyDeviceTier(
                true,   // hasGpu
                -1,     // memory unknown (common on macOS)
                8,      // cores
                false,  // isTouch
                false,  // isMobile
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
                'MacIntel',
            );
            expect(tier).toBe('limited');
        });

        it('keeps full tier for non-mobile desktop GPU machines', () => {
            const tier = classifyDeviceTier(
                true,
                16,
                8,
                false,
                false,
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Win32',
            );
            expect(tier).toBe('full');
        });
    });
});
