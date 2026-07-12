import { describe, it, expect } from 'vitest';
import {
    classifyDeviceTier,
    isAppleM1CompatibilityGpu,
    isIntelMac,
    shouldUseTinyWhisperModel,
} from '../../src/core/DeviceCapabilities';

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

        it('does not misclassify Apple Silicon compatibility signals as Intel', () => {
            const compatibilityUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15';
            expect(isIntelMac(compatibilityUa, 'MacIntel', 'Apple M1 GPU')).toBe(false);
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

        it('keeps Apple Silicon full-tier despite MacIntel compatibility values', () => {
            const tier = classifyDeviceTier(
                true,
                -1,
                8,
                false,
                false,
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)',
                'MacIntel',
                'Apple M1 GPU',
            );
            expect(tier).toBe('full');
        });
    });

    describe('Whisper model policy', () => {
        it('recognizes the exact privacy-preserving Firefox M1 renderer', () => {
            expect(isAppleM1CompatibilityGpu('mozilla apple m1, or similar')).toBe(true);
            expect(isAppleM1CompatibilityGpu('apple m1 gpu')).toBe(true);
            expect(isAppleM1CompatibilityGpu('apple m2 gpu')).toBe(false);
        });

        it('uses tiny for the unknown-memory M1 compatibility profile and Firefox/Mac document-start fallback', () => {
            expect(shouldUseTinyWhisperModel({
                hasGpu: true,
                memory: -1,
                isMobile: false,
                gpuVendor: 'mozilla apple m1, or similar',
            })).toBe(true);

            expect(shouldUseTinyWhisperModel({
                hasGpu: true,
                memory: 8,
                isMobile: false,
                gpuVendor: 'mozilla apple m1, or similar',
            })).toBe(false);
            expect(shouldUseTinyWhisperModel({
                hasGpu: true,
                memory: -1,
                isMobile: false,
                gpuVendor: 'mozilla apple m3 gpu',
            }, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:153.0) Gecko/20100101 Firefox/153.0', 'MacIntel')).toBe(true);
            expect(shouldUseTinyWhisperModel({
                hasGpu: true,
                memory: -1,
                isMobile: false,
                gpuVendor: 'mozilla apple m3 gpu',
            }, 'Mozilla/5.0 Chrome/153.0', 'MacIntel')).toBe(false);
        });
    });
});
