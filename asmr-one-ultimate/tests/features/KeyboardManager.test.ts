import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// ---- Mocks ----

vi.mock('../../src/core/Utils', () => ({
    Config: { get: vi.fn(), set: vi.fn() },
    Logger: { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { KeyboardManager, matchesHotkey } from '../../src/features/KeyboardManager';
import { Config } from '../../src/core/Utils';
import { EventBus } from '../../src/core/EventBus';

const mockCommit = vi.fn();

vi.mock('../../src/infrastructure/KikoeruBridge', () => ({
    KikoeruBridge: {
        getInstance: () => ({
            store: {
                state: {
                    AudioPlayer: {},
                },
            },
            commit: mockCommit,
        }),
    },
}));

const mockPlay = vi.fn().mockResolvedValue(undefined);
const mockPause = vi.fn();
const mockAudio: Record<string, any> = {
    playbackRate: 1,
    paused: true,
    currentTime: 30,
    duration: 300,
    volume: 0.5,
    muted: false,
    play: mockPlay,
    pause: mockPause,
};

vi.mock('../../src/core/DomUtils', () => ({
    getAudioElement: () => mockAudio,
}));

vi.mock('../../src/features/PlayerFullscreenController', () => ({
    PlayerFullscreenController: {
        getInstance: () => ({
            toggle: vi.fn(),
        }),
    },
}));

// Config defaults matching AppStore
const CONFIG_DEFAULTS: Record<string, any> = {
    hotkeyPlayPause: 'Space',
    hotkeyMute: 'm',
    hotkeyFullscreen: 'f',
    hotkeySeekBack: 'ArrowLeft',
    hotkeySeekForward: 'ArrowRight',
    hotkeySeekBackLong: 'j',
    hotkeySeekForwardLong: 'l',
    hotkeyVolumeUp: 'ArrowUp',
    hotkeyVolumeDown: 'ArrowDown',
    hotkeyPrevLine: 'a',
    hotkeyNextLine: 'd',
    hotkeyPrevTrack: 'p',
    hotkeyNextTrack: 'n',
    hotkeySpeedUp: '>',
    hotkeySpeedDown: '<',
    hotkeySpeedReset: '=',
    hotkeyToggleBlur: 'b',
    hotkeyToggleJP: 'J',
    hotkeyGalleryExclude: 'Delete',
    hotkeyGalleryPrev: 'ArrowLeft',
    hotkeyGalleryNext: 'ArrowRight',
    enablePlayerFullscreen: false,
    learnerBlur: true,
    showJP: true,
    playbackRate: 1,
};

function setConfig(overrides: Record<string, any> = {}): void {
    const merged = { ...CONFIG_DEFAULTS, ...overrides };
    (Config.get as Mock).mockReset();
    (Config.set as Mock).mockReset();
    (Config.get as Mock).mockImplementation((key: string) => merged[key]);
    (Config.set as Mock).mockImplementation(() => { });
}

function createKeyEvent(key: string, opts: Partial<KeyboardEventInit> = {}): KeyboardEvent {
    return new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        ...opts,
    });
}

/**
 * Fire a keydown event on a target element (default: document.body).
 * Uses document.body so the capture-phase listener on document fires,
 * and the event target has `.closest()` (unlike document itself).
 */
function fireKey(key: string, opts?: Partial<KeyboardEventInit> & { target?: HTMLElement }): KeyboardEvent {
    const { target, ...eventOpts } = opts || {};
    const event = createKeyEvent(key, eventOpts);
    vi.spyOn(event, 'preventDefault');
    vi.spyOn(event, 'stopPropagation');
    (target || document.body).dispatchEvent(event);
    return event;
}

function resetAudio(): void {
    mockAudio.playbackRate = 1;
    mockAudio.paused = true;
    mockAudio.currentTime = 30;
    mockAudio.duration = 300;
    mockAudio.volume = 0.5;
    mockAudio.muted = false;
    mockPlay.mockReset().mockResolvedValue(undefined);
    mockPause.mockReset();
}

describe('KeyboardManager', () => {
    let km: KeyboardManager;

    beforeEach(() => {
        // Reset singleton
        (KeyboardManager as any).instance = null;
        setConfig();
        mockCommit.mockReset();
        resetAudio();
        EventBus.removeAllListeners();

        km = KeyboardManager.getInstance();
        km.enable();
    });

    afterEach(() => {
        km.disable();
    });

    // =========================================================================
    // matchesHotkey (exported utility)
    // =========================================================================

    describe('matchesHotkey', () => {
        it('matches Space key', () => {
            const e = createKeyEvent(' ');
            expect(matchesHotkey(e, 'hotkeyPlayPause')).toBe(true);
        });

        it('matches case-insensitive single letter', () => {
            const eUpper = createKeyEvent('M');
            const eLower = createKeyEvent('m');
            expect(matchesHotkey(eUpper, 'hotkeyMute')).toBe(true);
            expect(matchesHotkey(eLower, 'hotkeyMute')).toBe(true);
        });

        it('matches special key names exactly', () => {
            const e = createKeyEvent('ArrowLeft');
            expect(matchesHotkey(e, 'hotkeySeekBack')).toBe(true);
        });

        it('returns false for empty binding', () => {
            setConfig({ hotkeyMute: '' });
            const e = createKeyEvent('m');
            expect(matchesHotkey(e, 'hotkeyMute')).toBe(false);
        });

        it('returns false for non-matching key', () => {
            const e = createKeyEvent('x');
            expect(matchesHotkey(e, 'hotkeyMute')).toBe(false);
        });

        it('handles shift-modified keys like >', () => {
            setConfig({ hotkeySpeedUp: '>' });
            const e = createKeyEvent('>', { shiftKey: true });
            expect(matchesHotkey(e, 'hotkeySpeedUp')).toBe(true);
        });
    });

    // =========================================================================
    // Input filtering
    // =========================================================================

    describe('input filtering', () => {
        it('ignores keydown in INPUT elements', () => {
            const input = document.createElement('input');
            document.body.appendChild(input);
            fireKey(' ', { target: input });
            expect(mockPlay).not.toHaveBeenCalled();
            expect(mockPause).not.toHaveBeenCalled();
            document.body.removeChild(input);
        });

        it('ignores keydown in TEXTAREA elements', () => {
            const textarea = document.createElement('textarea');
            document.body.appendChild(textarea);
            fireKey(' ', { target: textarea });
            expect(mockPlay).not.toHaveBeenCalled();
            expect(mockPause).not.toHaveBeenCalled();
            document.body.removeChild(textarea);
        });

        it('ignores keydown in contentEditable elements', () => {
            const div = document.createElement('div');
            div.contentEditable = 'true';
            // jsdom may not set isContentEditable automatically
            Object.defineProperty(div, 'isContentEditable', { value: true, configurable: true });
            document.body.appendChild(div);
            fireKey(' ', { target: div });
            expect(mockPlay).not.toHaveBeenCalled();
            expect(mockPause).not.toHaveBeenCalled();
            document.body.removeChild(div);
        });

        it('ignores keydown inside Quasar .q-field', () => {
            const field = document.createElement('div');
            field.classList.add('q-field');
            const inner = document.createElement('span');
            field.appendChild(inner);
            document.body.appendChild(field);
            fireKey(' ', { target: inner });
            expect(mockPlay).not.toHaveBeenCalled();
            expect(mockPause).not.toHaveBeenCalled();
            document.body.removeChild(field);
        });
    });

    // =========================================================================
    // Play / Pause
    // =========================================================================

    describe('play/pause', () => {
        it('calls audio.pause() when playing', () => {
            mockAudio.paused = false;
            const e = fireKey(' ');
            expect(mockPause).toHaveBeenCalled();
            expect(mockPlay).not.toHaveBeenCalled();
            expect(e.preventDefault).toHaveBeenCalled();
            expect(e.stopPropagation).toHaveBeenCalled();
        });

        it('calls audio.play() when paused', () => {
            mockAudio.paused = true;
            fireKey(' ');
            expect(mockPlay).toHaveBeenCalled();
            expect(mockPause).not.toHaveBeenCalled();
        });

        it('responds to custom binding', () => {
            setConfig({ hotkeyPlayPause: 'k' });
            mockAudio.paused = true;
            fireKey('k');
            expect(mockPlay).toHaveBeenCalled();
        });
    });

    // =========================================================================
    // Mute
    // =========================================================================

    describe('mute', () => {
        it('toggles mute on via audio element', () => {
            mockAudio.muted = false;
            fireKey('m');
            expect(mockAudio.muted).toBe(true);
            expect(mockCommit).toHaveBeenCalledWith('AudioPlayer/TOGGLE_MUTED');
        });

        it('toggles mute off via audio element', () => {
            mockAudio.muted = true;
            fireKey('m');
            expect(mockAudio.muted).toBe(false);
            expect(mockCommit).toHaveBeenCalledWith('AudioPlayer/TOGGLE_MUTED');
        });
    });

    // =========================================================================
    // Seeking
    // =========================================================================

    describe('seeking', () => {
        it('seeks back 5s with ArrowLeft', () => {
            mockAudio.currentTime = 30;
            fireKey('ArrowLeft');
            expect(mockAudio.currentTime).toBe(25);
        });

        it('seeks forward 5s with ArrowRight', () => {
            mockAudio.currentTime = 30;
            fireKey('ArrowRight');
            expect(mockAudio.currentTime).toBe(35);
        });

        it('seeks back 10s with j', () => {
            mockAudio.currentTime = 30;
            fireKey('j');
            expect(mockAudio.currentTime).toBe(20);
        });

        it('seeks forward 10s with l', () => {
            mockAudio.currentTime = 30;
            fireKey('l');
            expect(mockAudio.currentTime).toBe(40);
        });

        it('clamps seek to 0', () => {
            mockAudio.currentTime = 2;
            fireKey('ArrowLeft');
            expect(mockAudio.currentTime).toBe(0);
        });

        it('clamps seek to duration', () => {
            mockAudio.currentTime = 298;
            mockAudio.duration = 300;
            fireKey('ArrowRight');
            expect(mockAudio.currentTime).toBe(300);
        });
    });

    // =========================================================================
    // Percentage seek (0-9)
    // =========================================================================

    describe('percentage seek', () => {
        it('seeks to 0% with key 0', () => {
            mockAudio.duration = 200;
            fireKey('0');
            expect(mockAudio.currentTime).toBe(0);
        });

        it('seeks to 50% with key 5', () => {
            mockAudio.duration = 200;
            fireKey('5');
            expect(mockAudio.currentTime).toBe(100);
        });

        it('seeks to 90% with key 9', () => {
            mockAudio.duration = 100;
            fireKey('9');
            expect(mockAudio.currentTime).toBe(90);
        });

        it('ignores 0-9 with ctrl held', () => {
            const oldTime = mockAudio.currentTime;
            fireKey('5', { ctrlKey: true });
            expect(mockAudio.currentTime).toBe(oldTime);
        });

        it('ignores 0-9 with alt held', () => {
            const oldTime = mockAudio.currentTime;
            fireKey('5', { altKey: true });
            expect(mockAudio.currentTime).toBe(oldTime);
        });
    });

    // =========================================================================
    // Volume
    // =========================================================================

    describe('volume', () => {
        it('increases volume by 5%', () => {
            mockAudio.volume = 0.5;
            fireKey('ArrowUp');
            expect(mockAudio.volume).toBeCloseTo(0.55);
            expect(mockCommit).toHaveBeenCalledWith('AudioPlayer/SET_VOLUME', expect.closeTo(0.55));
        });

        it('decreases volume by 5%', () => {
            mockAudio.volume = 0.5;
            fireKey('ArrowDown');
            expect(mockAudio.volume).toBeCloseTo(0.45);
            expect(mockCommit).toHaveBeenCalledWith('AudioPlayer/SET_VOLUME', expect.closeTo(0.45));
        });

        it('clamps volume to 1', () => {
            mockAudio.volume = 0.98;
            fireKey('ArrowUp');
            expect(mockAudio.volume).toBe(1);
            expect(mockCommit).toHaveBeenCalledWith('AudioPlayer/SET_VOLUME', 1);
        });

        it('clamps volume to 0', () => {
            mockAudio.volume = 0.02;
            fireKey('ArrowDown');
            expect(mockAudio.volume).toBe(0);
            expect(mockCommit).toHaveBeenCalledWith('AudioPlayer/SET_VOLUME', 0);
        });
    });

    // =========================================================================
    // Track / Line navigation
    // =========================================================================

    describe('track/line navigation', () => {
        it('emits player:nav-prev on a (default)', () => {
            const spy = vi.fn();
            EventBus.on('player:nav-prev', spy);
            fireKey('a');
            expect(spy).toHaveBeenCalled();
        });

        it('emits player:nav-next on d (default)', () => {
            const spy = vi.fn();
            EventBus.on('player:nav-next', spy);
            fireKey('d');
            expect(spy).toHaveBeenCalled();
        });

        it('commits PREVIOUS_TRACK on p', () => {
            fireKey('p');
            expect(mockCommit).toHaveBeenCalledWith('AudioPlayer/PREVIOUS_TRACK');
        });

        it('commits NEXT_TRACK on n', () => {
            fireKey('n');
            expect(mockCommit).toHaveBeenCalledWith('AudioPlayer/NEXT_TRACK');
        });
    });

    // =========================================================================
    // Playback rate
    // =========================================================================

    describe('playback rate', () => {
        it('increases speed by 0.25', () => {
            mockAudio.playbackRate = 1;
            fireKey('>', { shiftKey: true });
            expect(mockAudio.playbackRate).toBe(1.25);
        });

        it('decreases speed by 0.25', () => {
            mockAudio.playbackRate = 1;
            fireKey('<', { shiftKey: true });
            expect(mockAudio.playbackRate).toBe(0.75);
        });

        it('clamps speed to min 0.25', () => {
            mockAudio.playbackRate = 0.25;
            fireKey('<', { shiftKey: true });
            expect(mockAudio.playbackRate).toBe(0.25);
        });

        it('clamps speed to max 4', () => {
            mockAudio.playbackRate = 4;
            fireKey('>', { shiftKey: true });
            expect(mockAudio.playbackRate).toBe(4);
        });

        it('resets speed to 1 on = key', () => {
            mockAudio.playbackRate = 1.5;
            fireKey('=');
            expect(mockAudio.playbackRate).toBe(1);
            expect(Config.set).toHaveBeenCalledWith('playbackRate', 1);
        });

        it('emits player:rate-change on speed change', () => {
            const spy = vi.fn();
            EventBus.on('player:rate-change', spy);
            mockAudio.playbackRate = 1;
            fireKey('>', { shiftKey: true });
            expect(spy).toHaveBeenCalledWith({ rate: 1.25 });
        });

        it('emits player:rate-change on speed reset', () => {
            const spy = vi.fn();
            EventBus.on('player:rate-change', spy);
            mockAudio.playbackRate = 1.5;
            fireKey('=');
            expect(spy).toHaveBeenCalledWith({ rate: 1 });
        });
    });

    // =========================================================================
    // Feature toggles
    // =========================================================================

    describe('feature toggles', () => {
        it('emits blur:toggle event on b key', () => {
            const spy = vi.fn();
            EventBus.on('blur:toggle', spy);
            fireKey('b');
            expect(spy).toHaveBeenCalledOnce();
            EventBus.removeAllListeners();
        });

        it('toggles JP display', () => {
            // Use non-conflicting binding (default 'J' conflicts with seekBackLong 'j' due to case-insensitive matching)
            setConfig({ showJP: true, hotkeyToggleJP: 'y' });
            fireKey('y');
            expect(Config.set).toHaveBeenCalledWith('showJP', false);
        });
    });

    // =========================================================================
    // Gallery mode
    // =========================================================================

    describe('gallery mode', () => {
        it('is not active by default', () => {
            expect(km.isGalleryActive()).toBe(false);
        });

        it('activates on fullscreen:enter event', () => {
            EventBus.emit('fullscreen:enter', undefined as any);
            expect(km.isGalleryActive()).toBe(true);
        });

        it('deactivates on fullscreen:exit event', () => {
            EventBus.emit('fullscreen:enter', undefined as any);
            EventBus.emit('fullscreen:exit', undefined as any);
            expect(km.isGalleryActive()).toBe(false);
        });

        it('emits gallery:nav -1 on ArrowLeft when gallery active', () => {
            EventBus.emit('fullscreen:enter', undefined as any);
            const spy = vi.fn();
            EventBus.on('gallery:nav', spy);
            const prevTime = mockAudio.currentTime;
            fireKey('ArrowLeft');
            expect(spy).toHaveBeenCalledWith({ direction: -1 });
            // Should NOT seek
            expect(mockAudio.currentTime).toBe(prevTime);
        });

        it('emits gallery:nav 1 on ArrowRight when gallery active', () => {
            EventBus.emit('fullscreen:enter', undefined as any);
            const spy = vi.fn();
            EventBus.on('gallery:nav', spy);
            fireKey('ArrowRight');
            expect(spy).toHaveBeenCalledWith({ direction: 1 });
        });

        it('emits gallery:exclude on Delete when gallery active', () => {
            EventBus.emit('fullscreen:enter', undefined as any);
            const spy = vi.fn();
            EventBus.on('gallery:exclude', spy);
            fireKey('Delete');
            expect(spy).toHaveBeenCalled();
        });

        it('falls through to seek when gallery is NOT active', () => {
            mockAudio.currentTime = 30;
            fireKey('ArrowLeft');
            expect(mockAudio.currentTime).toBe(25);
        });

        it('uses custom gallery nav bindings', () => {
            setConfig({ hotkeyGalleryPrev: 'q', hotkeyGalleryNext: 'e' });
            EventBus.emit('fullscreen:enter', undefined as any);
            const spy = vi.fn();
            EventBus.on('gallery:nav', spy);
            fireKey('q');
            expect(spy).toHaveBeenCalledWith({ direction: -1 });
            fireKey('e');
            expect(spy).toHaveBeenCalledWith({ direction: 1 });
        });
    });

    // =========================================================================
    // Custom bindings
    // =========================================================================

    describe('custom bindings', () => {
        it('allows rebinding play/pause to a different key', () => {
            setConfig({ hotkeyPlayPause: 'k' });
            mockAudio.paused = true;
            fireKey('k');
            expect(mockPlay).toHaveBeenCalled();
            // Original Space should no longer trigger play/pause
            mockPlay.mockReset();
            mockPause.mockReset();
            fireKey(' ');
            expect(mockPlay).not.toHaveBeenCalled();
            expect(mockPause).not.toHaveBeenCalled();
        });

        it('allows rebinding seek to different keys', () => {
            setConfig({ hotkeySeekBack: 'h', hotkeySeekForward: ';' });
            mockAudio.currentTime = 30;
            fireKey('h');
            expect(mockAudio.currentTime).toBe(25);
            fireKey(';');
            expect(mockAudio.currentTime).toBe(30);
        });

        it('disables a hotkey when set to empty string', () => {
            setConfig({ hotkeyMute: '' });
            const prevMuted = mockAudio.muted;
            fireKey('m');
            expect(mockAudio.muted).toBe(prevMuted);
        });
    });

    // =========================================================================
    // Throttling
    // =========================================================================

    describe('track skip throttling', () => {
        it('allows first track skip', () => {
            fireKey('n');
            expect(mockCommit).toHaveBeenCalledWith('AudioPlayer/NEXT_TRACK');
        });

        it('throttles rapid track skips', () => {
            fireKey('n');
            mockCommit.mockReset();
            // Immediately fire again — should be throttled
            fireKey('n');
            expect(mockCommit).not.toHaveBeenCalledWith('AudioPlayer/NEXT_TRACK');
        });
    });

    // =========================================================================
    // Singleton
    // =========================================================================

    describe('singleton', () => {
        it('returns the same instance', () => {
            const a = KeyboardManager.getInstance();
            const b = KeyboardManager.getInstance();
            expect(a).toBe(b);
        });
    });
});
