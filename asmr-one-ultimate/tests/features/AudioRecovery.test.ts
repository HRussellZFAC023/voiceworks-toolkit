import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    currentAudio: null as HTMLAudioElement | null,
    observerCallback: null as (() => void) | null,
    register: vi.fn((_id: string, callback: () => void) => {
        mocks.observerCallback = callback;
    }),
    unregister: vi.fn(),
    resumeAudioContext: vi.fn(),
}));

vi.mock('../../src/core/DomUtils', () => ({
    getAudioElement: () => mocks.currentAudio,
    isValidAudioSource: (src: string) => /^https?:\/\//i.test(src),
}));

vi.mock('../../src/core/CentralObserver', () => ({
    CentralObserver: {
        register: mocks.register,
        unregister: mocks.unregister,
    },
}));

vi.mock('../../src/core/AudioAnalysis', () => ({
    resumeAudioContext: mocks.resumeAudioContext,
}));

vi.mock('../../src/core/Utils', () => ({
    Logger: {
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

import { setupAudioRecovery } from '../../src/features/audioRecovery';

interface TestAudio {
    element: HTMLAudioElement;
    play: ReturnType<typeof vi.fn>;
    load: ReturnType<typeof vi.fn>;
    getCurrentTime: () => number;
}

function createAudio(src: string, initialTime = 0): TestAudio {
    const element = document.createElement('audio');
    let currentTime = initialTime;
    let readyState: number = HTMLMediaElement.HAVE_CURRENT_DATA;
    const play = vi.fn().mockResolvedValue(undefined);
    const load = vi.fn(() => {
        currentTime = 0;
        readyState = HTMLMediaElement.HAVE_NOTHING;
    });

    Object.defineProperties(element, {
        paused: { configurable: true, get: () => false },
        readyState: { configurable: true, get: () => readyState },
        duration: { configurable: true, get: () => 100 },
        currentTime: {
            configurable: true,
            get: () => currentTime,
            set: (value: number) => { currentTime = value; },
        },
        play: { configurable: true, value: play },
        load: { configurable: true, value: load },
    });
    element.src = src;
    document.body.appendChild(element);

    return { element, play, load, getCurrentTime: () => currentTime };
}

describe('setupAudioRecovery', () => {
    let cleanup: (() => void) | null = null;

    beforeEach(() => {
        mocks.currentAudio = null;
        mocks.observerCallback = null;
        mocks.register.mockClear();
        mocks.unregister.mockClear();
        mocks.resumeAudioContext.mockClear();
        document.body.replaceChildren();
    });

    afterEach(() => {
        cleanup?.();
        cleanup = null;
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('binds an audio element created after startup and rebinds when the host replaces it', () => {
        cleanup = setupAudioRecovery();
        expect(mocks.register).toHaveBeenCalledWith('audio-recovery', expect.any(Function), 100);

        const first = createAudio('https://media.example/first.mp3');
        mocks.currentAudio = first.element;
        mocks.observerCallback?.();
        first.element.dispatchEvent(new Event('stalled'));
        expect(first.play).toHaveBeenCalledTimes(1);

        const second = createAudio('https://media.example/second.mp3');
        mocks.currentAudio = second.element;
        mocks.observerCallback?.();
        first.play.mockClear();
        second.play.mockClear();

        first.element.dispatchEvent(new Event('stalled'));
        second.element.dispatchEvent(new Event('stalled'));
        expect(first.play).not.toHaveBeenCalled();
        expect(second.play).toHaveBeenCalledTimes(1);

        cleanup();
        cleanup();
        second.play.mockClear();
        second.element.dispatchEvent(new Event('stalled'));
        expect(second.play).not.toHaveBeenCalled();
        expect(mocks.unregister).toHaveBeenCalledTimes(1);
    });

    it('defers a waiting reload while hidden and restores position only after metadata', () => {
        vi.useFakeTimers();
        let visibility: DocumentVisibilityState = 'hidden';
        vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);

        const audio = createAudio('https://media.example/track.mp3', 42);
        mocks.currentAudio = audio.element;
        cleanup = setupAudioRecovery();

        audio.element.dispatchEvent(new Event('waiting'));
        vi.advanceTimersByTime(5_000);
        expect(audio.load).not.toHaveBeenCalled();
        expect(audio.getCurrentTime()).toBe(42);

        visibility = 'visible';
        document.dispatchEvent(new Event('visibilitychange'));
        expect(mocks.resumeAudioContext).toHaveBeenCalledWith(audio.element);
        expect(audio.load).toHaveBeenCalledTimes(1);
        expect(audio.getCurrentTime()).toBe(0);
        expect(audio.play).not.toHaveBeenCalled();

        audio.element.dispatchEvent(new Event('loadedmetadata'));
        expect(audio.getCurrentTime()).toBe(42);
        expect(audio.play).toHaveBeenCalledTimes(1);
    });

    it('reloads a waiting source without ever assigning the document URL', () => {
        vi.useFakeTimers();
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');

        const audio = createAudio('https://media.example/track.mp3', 12);
        const assigned: string[] = [];
        const nativeDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
        Object.defineProperty(audio.element, 'src', {
            configurable: true,
            get: () => nativeDescriptor?.get?.call(audio.element) || '',
            set: (value: string) => {
                assigned.push(value);
                nativeDescriptor?.set?.call(audio.element, value);
            },
        });
        mocks.currentAudio = audio.element;
        cleanup = setupAudioRecovery();

        audio.element.dispatchEvent(new Event('waiting'));
        vi.advanceTimersByTime(5_000);

        expect(audio.load).toHaveBeenCalledTimes(1);
        expect(assigned).not.toContain('');
        expect(assigned).not.toContain(window.location.href);
    });

    it('also defers invalid-source restoration while hidden', () => {
        vi.useFakeTimers();
        let visibility: DocumentVisibilityState = 'hidden';
        vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);

        const audio = createAudio('https://media.example/known-good.mp3', 18);
        mocks.currentAudio = audio.element;
        cleanup = setupAudioRecovery();

        audio.element.src = 'data:invalid';
        audio.element.dispatchEvent(new Event('error'));
        expect(audio.load).not.toHaveBeenCalled();

        visibility = 'visible';
        document.dispatchEvent(new Event('visibilitychange'));
        expect(audio.load).toHaveBeenCalledTimes(1);
        expect(audio.element.src).toBe('https://media.example/known-good.mp3');
        expect(audio.play).not.toHaveBeenCalled();

        audio.element.dispatchEvent(new Event('loadedmetadata'));
        expect(audio.getCurrentTime()).toBe(18);
        expect(audio.play).toHaveBeenCalledTimes(1);
    });
});
