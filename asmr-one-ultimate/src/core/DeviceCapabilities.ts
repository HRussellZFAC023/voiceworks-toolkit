/**
 * DeviceCapabilities — Proactive device capability detection
 *
 * Runs synchronously at startup to classify the device into a tier
 * before ML model warmup begins. Desktop machines see zero behavior change;
 * constrained devices skip eager model downloads.
 */

declare const unsafeWindow: Window & typeof globalThis;

export type DeviceTier = 'full' | 'limited' | 'constrained';

export interface DeviceProfile {
    tier: DeviceTier;
    hasGpu: boolean;
    /** navigator.deviceMemory in GB, or -1 if unavailable (Firefox/Safari) */
    memory: number;
    /** navigator.hardwareConcurrency, or -1 if unavailable */
    cores: number;
    isTouch: boolean;
    isMobile: boolean;
    screenWidth: number;
    /** Human-readable explanation of the tier decision */
    reason: string;
}

let cached: DeviceProfile | null = null;

type NavigatorWithCapabilities = Navigator & {
    deviceMemory?: number;
    gpu?: unknown;
};

const globalWindow = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as Window & {
    __ASMR_DEVICE_TIER__?: DeviceTier;
    __ASMR_DEVICE_PROFILE__?: DeviceProfile;
};

function classify(hasGpu: boolean, memory: number, cores: number, isTouch: boolean, isMobile: boolean): DeviceTier {
    // Constrained: mobile without GPU, or mobile with very low memory
    if (isMobile && (!hasGpu || (memory > 0 && memory < 4))) {
        return 'constrained';
    }

    // Full: has GPU, enough resources, not mobile
    // When memory is unknown (-1), trust other signals (desktop with GPU + decent cores)
    if (hasGpu && !isMobile && (memory >= 4 || memory < 0) && (cores >= 4 || cores < 0)) {
        return 'full';
    }

    // Everything else: desktop without GPU, high-end mobile with GPU, etc.
    return 'limited';
}

function buildReason(profile: Omit<DeviceProfile, 'reason'>): string {
    const parts: string[] = [profile.tier];
    parts.push(profile.hasGpu ? 'GPU' : 'no-GPU');
    if (profile.memory > 0) parts.push(`${profile.memory}GB`);
    if (profile.cores > 0) parts.push(`${profile.cores} cores`);
    if (profile.isMobile) parts.push('mobile');
    else if (profile.isTouch) parts.push('touch');
    parts.push(`${profile.screenWidth}px`);
    return parts.join(', ');
}

/** Per-tier configuration for ML model loading and resource limits */
export interface ModelBudget {
    /** Preferred dtype candidates for embedding worker */
    embeddingDtypes: string[];
    /** Whether embedding service should be enabled */
    embeddingEnabled: boolean;
    /** Whether whisper should be enabled by default */
    whisperEnabled: boolean;
    /** Audio cache size limit in bytes */
    audioCacheLimit: number;
    /** Idle unload timeout for whisper worker (ms) */
    whisperIdleMs: number;
}

const MODEL_BUDGETS: Record<DeviceTier, ModelBudget> = {
    full: {
        embeddingDtypes: ['fp16', 'fp32'],
        embeddingEnabled: true,
        whisperEnabled: true,
        audioCacheLimit: 5 * 1024 * 1024 * 1024, // 5GB
        whisperIdleMs: 10 * 60 * 1000,            // 10 min
    },
    limited: {
        embeddingDtypes: ['q8', 'fp32'],
        embeddingEnabled: true,
        whisperEnabled: true,
        audioCacheLimit: 1024 * 1024 * 1024,      // 1GB
        whisperIdleMs: 5 * 60 * 1000,             // 5 min
    },
    constrained: {
        embeddingDtypes: [],
        embeddingEnabled: false,
        whisperEnabled: false,
        audioCacheLimit: 256 * 1024 * 1024,        // 256MB
        whisperIdleMs: 2 * 60 * 1000,              // 2 min
    },
};

export const DeviceCapabilities = {
    detect(): DeviceProfile {
        if (cached) return cached;

        const nav = navigator as NavigatorWithCapabilities;

        const hasGpu = typeof nav.gpu !== 'undefined' && !!nav.gpu;
        const memory = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : -1;
        const cores = typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : -1;
        const isTouch = 'ontouchstart' in window || nav.maxTouchPoints > 0;
        const screenWidth = screen?.width ?? window.innerWidth;
        const ua = nav.userAgent || '';

        const isMobile = (isTouch && screenWidth < 1024)
            || /Mobi|Android|iPhone|iPod/i.test(ua);

        const tier = classify(hasGpu, memory, cores, isTouch, isMobile);

        const partial = { tier, hasGpu, memory, cores, isTouch, isMobile, screenWidth, reason: '' };
        partial.reason = buildReason(partial);

        cached = partial as DeviceProfile;

        // Expose for E2E tests and console debugging
        globalWindow.__ASMR_DEVICE_TIER__ = tier;
        globalWindow.__ASMR_DEVICE_PROFILE__ = cached;

        return cached;
    },

    get profile(): DeviceProfile {
        return cached ?? this.detect();
    },

    /** Should ML models be eagerly warmed up at startup? */
    get shouldWarmup(): boolean {
        return this.profile.tier === 'full';
    },

    /** Get model budget for current device tier */
    get budget(): ModelBudget {
        return MODEL_BUDGETS[this.profile.tier];
    },

    /** Get model budget for a specific tier */
    getBudget(tier: DeviceTier): ModelBudget {
        return MODEL_BUDGETS[tier];
    },
};
