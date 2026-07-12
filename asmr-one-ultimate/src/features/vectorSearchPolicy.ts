import {
    shouldRunBackgroundMl,
    type DeviceProfile,
} from '../core/DeviceCapabilities';

/** Background embedding work must never delay real-time Whisper on weak devices. */
export function shouldAutoIndexVectors(
    profile: Pick<DeviceProfile, 'tier' | 'hasGpu' | 'memory' | 'isMobile' | 'gpuVendor'>,
    ua?: string,
    platform?: string,
): boolean {
    return shouldRunBackgroundMl(profile, ua, platform);
}
