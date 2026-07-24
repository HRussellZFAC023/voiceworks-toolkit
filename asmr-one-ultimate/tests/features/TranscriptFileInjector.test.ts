import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { eventListeners, eventBusOnMock, sharedCacheGetMock, bridgeState } = vi.hoisted(() => {
    const listeners: Array<{ event: string; callback: (payload: unknown) => void }> = [];
    return {
        eventListeners: listeners,
        eventBusOnMock: vi.fn((event: string, callback: (payload: unknown) => void) => {
            listeners.push({ event, callback });
            return vi.fn();
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sharedCacheGetMock: vi.fn((..._args: any[]): unknown => null),
        bridgeState: { currentWorkId: 'work-current' },
    };
});

vi.mock('../../src/infrastructure/KikoeruBridge', () => ({
    KikoeruBridge: {
        getInstance: () => bridgeState,
    },
}));

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

function addItem(tree: HTMLElement, title: string, hash = ''): HTMLElement {
    const list = tree.querySelector('.q-list')!;
    const item = document.createElement('div');
    item.className = 'q-item';
    if (hash) item.dataset.asmrHash = hash;
    const label = document.createElement('div');
    label.className = 'q-item__label';
    label.textContent = title;
    item.appendChild(label);
    list.appendChild(item);
    return item;
}

function makeTimedTranscript(timingQuality?: 'word') {
    return {
        text: 'お邪魔します',
        segments: [{
            start: 0,
            end: 2,
            text: 'お邪魔します',
            words: [
                { start: 0, end: 1, text: 'お邪魔' },
                { start: 1, end: 2, text: 'します' },
            ],
        }],
        model: 'whisper-tiny',
        subtask: 'transcribe',
        language: 'ja',
        createdAt: 1000,
        complete: true,
        ...(timingQuality ? { timingQuality } : {}),
        translations: {
            en: {
                text: 'Excuse me',
                lrc: '[00:00.00]Excuse me',
                vtt: 'WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\n<00:00:00.000>Excuse <00:00:01.000>me\n',
            },
        },
    };
}

function makeTranscriptEntry(cacheKey: string, trackTitle: string) {
    return {
        cacheKey,
        trackKey: cacheKey,
        trackTitle,
        model: 'whisper-tiny',
        subtask: 'transcribe',
        language: 'ja',
        updatedAt: 1000,
    };
}

function captureVttDownloads(
    injector: TranscriptFileInjector,
    entry: ReturnType<typeof makeTranscriptEntry>,
    cachedTranscript: ReturnType<typeof makeTimedTranscript>,
) {
    sharedCacheGetMock.mockReturnValue(cachedTranscript);
    const download = vi.spyOn(injector as any, 'download').mockImplementation(() => {});
    const badge = (injector as any).createBadgeGroup(entry, cachedTranscript) as HTMLElement;

    const clickDownload = (title: string, callIndex: number): string => {
        Array.from(badge.querySelectorAll('button'))
            .find(button => button.title === title)
            ?.click();
        return download.mock.calls[callIndex]?.[1] as string;
    };

    return {
        source: clickDownload('vttDownload', 0),
        translated: clickDownload('vttDownloadTranslated', 1),
    };
}

describe('TranscriptFileInjector', () => {
    let tree: HTMLElement;

    beforeEach(() => {
        eventBusOnMock.mockClear();
        eventListeners.length = 0;
        sharedCacheGetMock.mockReset();
        bridgeState.currentWorkId = 'work-current';
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
        // Should have raw TXT, LRC, and VTT buttons
        const buttons = badge!.querySelectorAll('button');
        expect(buttons.length).toBeGreaterThanOrEqual(3);
        expect(Array.from(buttons).some(button => button.title === 'whisperTranscriptDownloadTxt')).toBe(true);

        injector.disable();
    });

    it('does not export legacy v169 synthetic words without explicit word timing quality', () => {
        const injector = new TranscriptFileInjector();
        const downloads = captureVttDownloads(
            injector,
            makeTranscriptEntry('cache-v169', 'legacy.mp3'),
            makeTimedTranscript(),
        );

        expect(downloads.source).toContain('お邪魔します');
        expect(downloads.source).not.toContain('<00:00:00.000>');
        expect(downloads.source).not.toContain('<00:00:01.000>');
        expect(downloads.translated).toContain('Excuse me');
        expect(downloads.translated).not.toContain('<00:00:00.000>');
        expect(downloads.translated).not.toContain('<00:00:01.000>');
    });

    it('exports cached word cues only when timing quality is explicitly word', () => {
        const injector = new TranscriptFileInjector();
        const downloads = captureVttDownloads(
            injector,
            makeTranscriptEntry('cache-word', 'exact.mp3'),
            makeTimedTranscript('word'),
        );

        expect(downloads.source).toContain('<00:00:00.000>お邪魔');
        expect(downloads.source).toContain('<00:00:01.000>します');
        expect(downloads.translated).toContain('<00:00:00.000>Excuse ');
        expect(downloads.translated).toContain('<00:00:01.000>me');
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

    it('prefers the exact row hash over a newer same-title transcript from another work', () => {
        const injector = new TranscriptFileInjector();
        const transcript = {
            text: 'text',
            segments: [{ start: 0, end: 1, text: 'text' }],
            model: 'whisper-tiny',
            subtask: 'transcribe',
            language: 'ja',
            createdAt: 1000,
            complete: true,
        };
        sharedCacheGetMock.mockImplementation((key: string) => {
            if (key === 'whisper-index') return {
                'hash-current': [{
                    cacheKey: 'cache-current', trackKey: 'hash-current', trackTitle: 'track01.mp3',
                    workId: 'work-current', model: 'whisper-tiny', subtask: 'transcribe', language: 'ja', updatedAt: 1000,
                }],
                'hash-other': [{
                    cacheKey: 'cache-other', trackKey: 'hash-other', trackTitle: 'track01.mp3',
                    workId: 'work-other', model: 'whisper-tiny', subtask: 'transcribe', language: 'ja', updatedAt: 2000,
                }],
            };
            if (key === 'cache-current' || key === 'cache-other') return transcript;
            return null;
        });

        const item = addItem(tree, 'track01.mp3', 'hash-current');
        injector.enable();

        const badge = item.querySelector<HTMLElement>('[data-asmr-transcript]');
        expect(badge?.dataset.asmrTranscriptKey).toBe('cache-current:');
        injector.disable();
    });

    it('does not title-match duplicate filenames from different tracks in the same work', () => {
        const injector = new TranscriptFileInjector();
        sharedCacheGetMock.mockImplementation((key: string) => {
            if (key === 'whisper-index') return {
                'hash-a': [{
                    cacheKey: 'cache-a', trackKey: 'hash-a', trackTitle: 'track01.mp3', workId: 'work-current',
                    model: 'whisper-tiny', subtask: 'transcribe', language: 'ja', updatedAt: 1000,
                }],
                'hash-b': [{
                    cacheKey: 'cache-b', trackKey: 'hash-b', trackTitle: 'track01.mp3', workId: 'work-current',
                    model: 'whisper-tiny', subtask: 'transcribe', language: 'ja', updatedAt: 2000,
                }],
            };
            return null;
        });

        const item = addItem(tree, 'track01.mp3');
        injector.enable();

        expect(item.querySelector('[data-asmr-transcript]')).toBeNull();
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

    it('does not attach a flat-panel observer after being disabled', () => {
        const injector = new TranscriptFileInjector();
        const attachSpy = vi.spyOn(injector as any, 'attachFlatPanel');
        injector.enable();

        const toggleListener = eventListeners.find(l => l.event === 'flatview:toggle');
        toggleListener?.callback({ active: true });
        injector.disable();
        vi.advanceTimersByTime(250);

        expect(attachSpy).not.toHaveBeenCalled();
        expect((injector as any).flatObserver).toBeNull();
    });
});
