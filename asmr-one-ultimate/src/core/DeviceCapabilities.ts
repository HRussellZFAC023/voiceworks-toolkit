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
    /** GPU vendor/renderer from WebGL (works even when WebGPU hides adapter info, e.g. Firefox) */
    gpuVendor: string;
    /** Human-readable explanation of the tier decision */
    reason: string;
}

let cached: DeviceProfile | null = null;

/**
 * Detect GPU vendor/renderer via WebGL debug info.
 * Firefox hides adapter.info in WebGPU for fingerprinting protection.
 * Prefer standard VENDOR/RENDERER first to avoid WEBGL_debug_renderer_info warnings,
 * then fall back to unmasked values when available.
 */
function detectGpuVendorViaWebGL(): string {
    try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (!gl || !(gl instanceof WebGLRenderingContext)) return '';
        const isFirefox = /firefox/i.test(navigator.userAgent || '');
        const stdVendor = gl.getParameter(gl.VENDOR) || '';
        const stdRenderer = gl.getParameter(gl.RENDERER) || '';

        let vendor = String(stdVendor || '');
        let renderer = String(stdRenderer || '');

        // Only probe debug extension outside Firefox to avoid deprecation warnings.
        if (!isFirefox) {
            const ext = gl.getExtension('WEBGL_debug_renderer_info');
            if (ext) {
                vendor = String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) || vendor);
                renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || renderer);
            }
        }

        return [vendor, renderer].filter(Boolean).join(' ').toLowerCase();
    } catch {
        return '';
    }
}

type NavigatorWithCapabilities = Navigator & {
    deviceMemory?: number;
    gpu?: unknown;
};

const globalWindow = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as Window & {
    __ASMR_DEVICE_TIER__?: DeviceTier;
    __ASMR_DEVICE_PROFILE__?: DeviceProfile;
};

/** iPhone/iPod — always constrained (strict per-tab memory limits) */
function isIPhone(): boolean {
    return /iPhone|iPod/i.test(navigator.userAgent || '');
}

/** iPad (including iPadOS 13+ which spoofs "Macintosh" UA) */
function isIPad(): boolean {
    const ua = navigator.userAgent || '';
    return /iPad/i.test(ua)
        || (navigator.maxTouchPoints > 1 && /Macintosh/i.test(ua));
}

/** Intel Macs (especially 2018-2020) often expose WebGPU but have weak iGPU throughput */
export function isIntelMac(ua: string, platform: string, gpuVendor = ''): boolean {
    // Apple Silicon browsers commonly retain the legacy MacIntel platform and
    // an "Intel Mac OS X" UA for compatibility. A GPU renderer identifying
    // Apple silicon is stronger evidence and must win.
    if (/apple\s+(?:m\d|gpu)|\bm[1-9]\b/i.test(gpuVendor)) return false;
    const uaLooksMac = /Macintosh|Mac OS X/i.test(ua);
    const platformLooksIntelMac = /MacIntel/i.test(platform);
    const uaLooksIntel = /Intel/i.test(ua);
    return uaLooksMac && (platformLooksIntelMac || uaLooksIntel);
}

/**
 * Firefox exposes this privacy-preserving renderer for the affected M1-class
 * WebGPU profile instead of detailed adapter information.
 */
export function isAppleM1CompatibilityGpu(gpuVendor = ''): boolean {
    return /\bapple\s+m1(?:\s+gpu|\s*,\s*or\s+similar|\b)/i.test(gpuVendor);
}

/**
 * Identify Firefox/macOS WebGPU profiles whose hidden memory information needs
 * a bounded live-transcription policy. The caller decides the model and
 * scheduling window; this signal must not itself imply a Tiny downgrade.
 */
export function isFirefoxMacWhisperCompatibilityProfile(profile: Pick<
    DeviceProfile,
    'hasGpu' | 'memory' | 'isMobile' | 'gpuVendor'
>, ua = navigator.userAgent || '', platform = navigator.platform || ''): boolean {
    // Firefox withholds deviceMemory on macOS and can expose its Apple renderer
    // only after the first graphics context is fully ready. The UA/platform
    // fallback protects the same document-start runtime if that probe is blank.
    const isUnknownMemoryFirefoxMac = /firefox/i.test(ua)
        && /macintosh|mac os x/i.test(ua)
        && /mac/i.test(platform || 'Mac');
    return profile.hasGpu
        && !profile.isMobile
        && profile.memory < 0
        && (isAppleM1CompatibilityGpu(profile.gpuVendor) || isUnknownMemoryFirefoxMac);
}

/**
 * Compute-relevant WebGPU adapter capabilities, measured rather than inferred
 * from the user agent.
 *
 * `subgroups` is the decisive one for transcription throughput: ONNX Runtime
 * Web's fast matmul kernels require it, and without it ORT falls back to naive
 * shaders. Measured on an Apple M1 with whisper-small (encoder fp32 +
 * decoder q4), same model and same code in both browsers:
 *   Chromium (subgroups + subgroup-matrix): 3.6-5.5x realtime
 *   Firefox  (neither)                    : 0.15-0.22x realtime
 * That is a ~25x gap, so it must drive model choice — otherwise capable GPUs
 * get held back to protect browsers that would fall behind anyway.
 */
export interface WebGpuComputeProfile {
    subgroups: boolean;
    subgroupMatrix: boolean;
    shaderF16: boolean;
    maxBufferBytes: number;
}

let cachedWebGpuComputeProfile: WebGpuComputeProfile | null = null;
let webGpuComputeProbe: Promise<WebGpuComputeProfile | null> | null = null;

/** Last probed compute profile, or null if it has not resolved yet. */
export function getWebGpuComputeProfile(): WebGpuComputeProfile | null {
    return cachedWebGpuComputeProfile;
}

/** Probe once and cache. Safe to call repeatedly; never throws. */
export function probeWebGpuComputeProfile(): Promise<WebGpuComputeProfile | null> {
    if (cachedWebGpuComputeProfile) return Promise.resolve(cachedWebGpuComputeProfile);
    if (webGpuComputeProbe) return webGpuComputeProbe;
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter?: (o?: unknown) => Promise<unknown> } }).gpu;
    const requestAdapter = gpu?.requestAdapter?.bind(gpu);
    if (!requestAdapter) return Promise.resolve(null);
    webGpuComputeProbe = (async () => {
        try {
            const adapter = await requestAdapter({ powerPreference: 'high-performance' }) as {
                features?: { has?: (f: string) => boolean };
                limits?: { maxBufferSize?: number };
            } | null;
            if (!adapter) return null;
            const has = (feature: string): boolean => adapter.features?.has?.(feature) === true;
            cachedWebGpuComputeProfile = {
                subgroups: has('subgroups'),
                subgroupMatrix: has('chromium-experimental-subgroup-matrix') || has('subgroup-matrix'),
                shaderF16: has('shader-f16'),
                maxBufferBytes: Number(adapter.limits?.maxBufferSize) || 0,
            };
            return cachedWebGpuComputeProfile;
        } catch {
            return null;
        } finally {
            webGpuComputeProbe = null;
        }
    })();
    return webGpuComputeProbe;
}

/** Test seam. */
export function __setWebGpuComputeProfileForTests(profile: WebGpuComputeProfile | null): void {
    cachedWebGpuComputeProfile = profile;
    webGpuComputeProbe = null;
}

const WEBGPU_CORE_MIN_BUFFER_BYTES = 256 * 1024 * 1024;

/**
 * WebGPU guarantees a 256 MiB `maxBufferSize` on every core adapter. That
 * limit describes one allocation, not total GPU memory, so it must not be used
 * as a proxy for whether a medium/large model fits. Let ORT's real session
 * allocations decide and report a pinned-model error if they fail.
 */
export function getWhisperMinWebGpuBufferBytes(_model: string): number {
    return WEBGPU_CORE_MIN_BUFFER_BYTES;
}

/** Keep optional background ML from competing with live Whisper on weak profiles. */
export function shouldRunBackgroundMl(
    profile: Pick<DeviceProfile, 'tier' | 'hasGpu' | 'memory' | 'isMobile' | 'gpuVendor'>,
    ua = navigator.userAgent || '',
    platform = navigator.platform || '',
): boolean {
    return profile.tier === 'full'
        && !isFirefoxMacWhisperCompatibilityProfile(profile, ua, platform);
}

export function classifyDeviceTier(
    hasGpu: boolean,
    memory: number,
    cores: number,
    isTouch: boolean,
    isMobile: boolean,
    ua: string,
    platform: string,
    gpuVendor = '',
): DeviceTier {
    // iPhone: always constrained — strict per-tab memory (~80-120MB),
    // Safari WebGPU + ONNX unreliable, deviceMemory unavailable
    if (isIPhone()) {
        return 'constrained';
    }

    // iPad: limited — M-series iPads have enough RAM but Safari WebGPU
    // is still flaky; let crash guard handle auto-disable if needed
    if (isIPad()) {
        return 'limited';
    }

    // Constrained: mobile without GPU, or mobile with very low memory
    if (isMobile && (!hasGpu || (memory > 0 && memory < 4))) {
        return 'constrained';
    }

    // Intel macOS laptops are often GPU-constrained for real-time Whisper WebGPU.
    // Treat as limited to enable safer backpressure and avoid eager warmup stalls.
    if (isIntelMac(ua, platform, gpuVendor)) {
        return 'limited';
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
    if (isIPhone()) parts.push('iPhone');
    else if (isIPad()) parts.push('iPad');
    else if (isIntelMac(navigator.userAgent || '', navigator.platform || '', profile.gpuVendor)) parts.push('intel-mac');
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
        const platform = nav.platform || '';

        const isMobile = (isTouch && screenWidth < 1024)
            || /Mobi|Android|iPhone|iPod/i.test(ua);

        const gpuVendor = hasGpu ? detectGpuVendorViaWebGL() : '';
        const tier = classifyDeviceTier(hasGpu, memory, cores, isTouch, isMobile, ua, platform, gpuVendor);
        const partial = { tier, hasGpu, memory, cores, isTouch, isMobile, screenWidth, gpuVendor, reason: '' };
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

    /** Is this an iPhone/iPod? (ML features should be force-disabled) */
    get isIPhone(): boolean {
        return isIPhone();
    },

    /** Should ML models be eagerly warmed up at startup? */
    get shouldWarmup(): boolean {
        return shouldRunBackgroundMl(this.profile);
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
