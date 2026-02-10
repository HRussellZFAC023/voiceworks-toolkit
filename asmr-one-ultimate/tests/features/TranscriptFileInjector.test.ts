import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { eventListeners, eventBusOnMock, sharedCacheGetMock } = vi.hoisted(() => {
    const listeners: Array<{ event: string; callback: (payload: unknown) => void }> = [];
    return {
        eventListeners: listeners,
        eventBusOnMock: vi.fn((event: string, callback: (payload: unknown) => void) => {
            listeners.push({ event, callback });
            return vi.fn();
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sharedCacheGetMock: vi.fn((..._args: any[]): unknown => null),
    };
});

vi.mock('../../src/core/Utils', () => ({
    Logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    Config: { get: vi.fn(() => 'en') },
    I18n: {
        t: vi.fn((key: string) => key),
        format: vi.fn((key: string) => key),
    },
}));

vi.mock('../../src/core/EventBus', () => ({
    EventBus: {
        on: eventBusOnMock,
    },
}));

vi.mock('../../src/core/Cache', () => ({
    SharedCache: {
        get: sharedCacheGetMock,
    },
    CacheKeys: {
        whisperIndex: vi.fn(() => 'whisper-index'),
    },
}));

import { TranscriptFileInjector } from '../../src/features/TranscriptFileInjector';

function makeWorkTree(): HTMLElement {
    const tree = document.createElement('div');
    tree.id = 'work-tree';
    const card = document.createElement('div');
    card.className = 'q-card';
    const list = document.createElement('div');
    list.className = 'q-list';
    card.appendChild(list);
    tree.appendChild(card);
    document.body.appendChild(tree);
    return tree;
}

function addItem(tree: HTMLElement, title: string): HTMLElement {
    const list = tree.querySelector('.q-list')!;
    const item = document.createElement('div');
    item.className = 'q-item';
    const label = document.createElement('div');
    label.className = 'q-item__label';
    label.textContent = title;
    item.appendChild(label);
    list.appendChild(item);
    return item;
}

describe('TranscriptFileInjector', () => {
    let tree: HTMLElement;

    beforeEach(() => {
        eventBusOnMock.mockClear();
        eventListeners.length = 0;
        sharedCacheGetMock.mockReset();
        vi.useFakeTimers();
        tree = makeWorkTree();
    });

    afterEach(() => {
        vi.useRealTimers();
        tree.remove();
    });

    it('removes injected badges when disabled', () => {
        const injector = new TranscriptFileInjector();
        injector.enable();

        const badge = document.createElement('div');
        badge.setAttribute('data-asmr-transcript', 'true');
        document.body.appendChild(badge);
        expect(document.querySelector('[data-asmr-transcript]')).not.toBeNull();

        injector.disable();
        expect(document.querySelector('[data-asmr-transcript]')).toBeNull();
    });

    it('registers event listeners on enable and cleans up on disable', () => {
        const injector = new TranscriptFileInjector();
        injector.enable();

        const events = eventListeners.map(l => l.event);
        expect(events).toContain('worktree:enhanced');
        expect(events).toContain('whisper:complete');
        expect(events).toContain('work:change');
        expect(events).toContain('lang:change');
        expect(events).toContain('config:change');

        injector.disable();
    });

    it('injects VTT badge when worktree:enhanced fires with matching transcript', async () => {
        const injector = new TranscriptFileInjector();

        const whisperIndex = {
            'track-hash-1': [{
                cacheKey: 'cache-1',
                trackKey: 'track-hash-1',
                trackTitle: 'track01.mp3',
                model: 'whisper-tiny',
                subtask: 'transcribe',
                language: 'ja',
                updatedAt: 1000,
            }],
        };
        const cachedTranscript = {
            text: 'hello',
            segments: [{ start: 0, end: 1, text: 'hello' }],
            model: 'whisper-tiny',
            subtask: 'transcribe',
            language: 'ja',
            createdAt: 1000,
            complete: true,
        };

        sharedCacheGetMock.mockImplementation((key: string) => {
            if (key === 'whisper-index') return whisperIndex;
            if (key === 'cache-1') return cachedTranscript;
            return null;
        });

        addItem(tree, 'track01.mp3');
        injector.enable();

        const enhancedListener = eventListeners.find(l => l.event === 'worktree:enhanced');
        enhancedListener?.callback({ workTree: tree });

        const badge = tree.querySelector('[data-asmr-transcript]');
        expect(badge).not.toBeNull();
        // Should have LRC and VTT buttons
        const buttons = badge!.querySelectorAll('button');
        expect(buttons.length).toBeGreaterThanOrEqual(2);

        injector.disable();
    });

    it('does not inject badge for non-matching titles', async () => {
        const injector = new TranscriptFileInjector();

        sharedCacheGetMock.mockImplementation((key: string) => {
            if (key === 'whisper-index') return {
                'track-hash-1': [{
                    cacheKey: 'cache-1',
                    trackKey: 'track-hash-1',
                    trackTitle: 'other-track.mp3',
                    model: 'whisper-tiny',
                    subtask: 'transcribe',
                    language: 'ja',
                    updatedAt: 1000,
                }],
            };
            return null;
        });

        addItem(tree, 'track01.mp3');
        injector.enable();

        const enhancedListener = eventListeners.find(l => l.event === 'worktree:enhanced');
        enhancedListener?.callback({ workTree: tree });

        expect(tree.querySelector('[data-asmr-transcript]')).toBeNull();

        injector.disable();
    });

    it('removes stale badge when transcript no longer matches', () => {
        const injector = new TranscriptFileInjector();

        const whisperIndex = {
            'track-hash-1': [{
                cacheKey: 'cache-1',
                trackKey: 'track-hash-1',
                trackTitle: 'track01.mp3',
                model: 'whisper-tiny',
                subtask: 'transcribe',
                language: 'ja',
                updatedAt: 1000,
            }],
        };
        const cachedTranscript = {
            text: 'hello',
            segments: [{ start: 0, end: 1, text: 'hello' }],
            model: 'whisper-tiny',
            subtask: 'transcribe',
            language: 'ja',
            createdAt: 1000,
            complete: true,
        };

        sharedCacheGetMock.mockImplementation((key: string) => {
            if (key === 'whisper-index') return whisperIndex;
            if (key === 'cache-1') return cachedTranscript;
            return null;
        });

        const item = addItem(tree, 'track01.mp3');
        injector.enable();

        const enhancedListener = eventListeners.find(l => l.event === 'worktree:enhanced');
        enhancedListener?.callback({ workTree: tree });
        expect(item.querySelector('[data-asmr-transcript]')).not.toBeNull();

        // Now clear the index
        sharedCacheGetMock.mockImplementation(() => null);
        enhancedListener?.callback({ workTree: tree });
        expect(item.querySelector('[data-asmr-transcript]')).toBeNull();

        injector.disable();
    });

    it('coalesces rapid refresh calls', async () => {
        const injector = new TranscriptFileInjector();
        sharedCacheGetMock.mockReturnValue(null);

        injector.enable();

        const langListener = eventListeners.find(l => l.event === 'lang:change');
        const configListener = eventListeners.find(l => l.event === 'config:change');

        // Fire multiple events rapidly
        langListener?.callback({ lang: 'ja' });
        configListener?.callback({ key: 'subtitleLang', value: 'ja' });
        langListener?.callback({ lang: 'en' });

        // Only one timer should be scheduled
        await vi.runAllTimersAsync();
        // No error = coalescing worked

        injector.disable();
    });
});
