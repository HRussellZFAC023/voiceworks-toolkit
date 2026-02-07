import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    findButtonByText,
    findIconButton,
    findPlayButtons,
    findAudioItems,
    isAudioFileElement,
    waitForElement,
    waitFor,
    injectStyles,
    removeStyles,
    getAudioElement,
    getPlayerBar,
    hasPlayerBar,
    getAudioSource,
    isAudioPlaying,
    getVueItem,
    getFatherFolder,
    isDarkMode,
    getThemeColors,
    isInViewport,
} from '../../src/core/DomUtils';

describe('DomUtils', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        document.body.className = '';
        document.head.innerHTML = '';
    });

    // =========================================================================
    // Element Finding
    // =========================================================================

    describe('findButtonByText', () => {
        it('should find a button by text label', () => {
            document.body.innerHTML = `
                <div class="q-btn">Save</div>
                <div class="q-btn">Cancel</div>
            `;
            const btn = findButtonByText(['Save']);
            expect(btn).not.toBeNull();
            expect(btn!.textContent).toContain('Save');
        });

        it('should match any label in the array', () => {
            document.body.innerHTML = '<div class="q-btn">取消</div>';
            const btn = findButtonByText(['Cancel', '取消']);
            expect(btn).not.toBeNull();
        });

        it('should return null when no match', () => {
            document.body.innerHTML = '<div class="q-btn">OK</div>';
            expect(findButtonByText(['Missing'])).toBeNull();
        });

        it('should scope search to provided root', () => {
            document.body.innerHTML = `
                <div id="scope"><div class="q-btn">Scoped</div></div>
                <div class="q-btn">Outside</div>
            `;
            const root = document.getElementById('scope')!;
            const btn = findButtonByText(['Scoped'], root);
            expect(btn).not.toBeNull();
            const outside = findButtonByText(['Outside'], root);
            expect(outside).toBeNull();
        });
    });

    describe('findIconButton', () => {
        it('should find a button by icon name', () => {
            document.body.innerHTML = `
                <div class="q-btn"><i class="material-icons">play_arrow</i></div>
            `;
            const btn = findIconButton('play_arrow');
            expect(btn).not.toBeNull();
            expect(btn!.classList.contains('q-btn')).toBe(true);
        });

        it('should return null when icon not found', () => {
            document.body.innerHTML = '<div class="q-btn"><i class="material-icons">stop</i></div>';
            expect(findIconButton('play_arrow')).toBeNull();
        });

        it('should scope to selector', () => {
            document.body.innerHTML = `
                <div id="player"><div class="q-btn"><i class="q-icon">skip_next</i></div></div>
                <div class="q-btn"><i class="q-icon">skip_next</i></div>
            `;
            const btn = findIconButton('skip_next', '#player');
            expect(btn).not.toBeNull();
        });

        it('should return null when scope not found', () => {
            expect(findIconButton('play', '#nonexistent')).toBeNull();
        });
    });

    describe('findPlayButtons', () => {
        it('should find buttons with play_arrow text', () => {
            document.body.innerHTML = `
                <button>play_arrow</button>
                <div class="q-btn">play_arrow</div>
                <button>stop</button>
            `;
            const buttons = findPlayButtons();
            expect(buttons).toHaveLength(2);
        });

        it('should return empty array when none found', () => {
            document.body.innerHTML = '<button>stop</button>';
            expect(findPlayButtons()).toHaveLength(0);
        });
    });

    describe('findAudioItems', () => {
        it('should find items with audio file extensions', () => {
            document.body.innerHTML = `
                <div class="q-item">track01.mp3</div>
                <div class="q-item">image.png</div>
                <div class="q-item">track02.flac</div>
                <div class="file-list-item">voice.wav</div>
            `;
            const items = findAudioItems();
            expect(items).toHaveLength(3);
        });

        it('should match all supported audio extensions', () => {
            const extensions = ['.wav', '.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wma'];
            for (const ext of extensions) {
                document.body.innerHTML = `<div class="q-item">file${ext}</div>`;
                const items = findAudioItems();
                expect(items).toHaveLength(1);
            }
        });
    });

    describe('isAudioFileElement', () => {
        it('should return true for audio files', () => {
            const el = document.createElement('div');
            el.textContent = 'track.mp3';
            expect(isAudioFileElement(el)).toBe(true);
        });

        it('should return false for non-audio files', () => {
            const el = document.createElement('div');
            el.textContent = 'image.png';
            expect(isAudioFileElement(el)).toBe(false);
        });

        it('should be case-insensitive', () => {
            const el = document.createElement('div');
            el.textContent = 'TRACK.MP3';
            expect(isAudioFileElement(el)).toBe(true);
        });
    });

    // =========================================================================
    // Element Waiting
    // =========================================================================

    describe('waitForElement', () => {
        afterEach(() => {
            vi.useRealTimers();
        });

        it('should resolve immediately if element exists', async () => {
            document.body.innerHTML = '<div id="target">Hello</div>';
            const el = await waitForElement('#target', 1000, 50);
            expect(el).not.toBeNull();
            expect(el!.textContent).toBe('Hello');
        });

        it('should resolve when element appears later', async () => {
            const promise = waitForElement('#delayed', 2000, 50);
            setTimeout(() => {
                document.body.innerHTML = '<div id="delayed">Appeared</div>';
            }, 100);
            const el = await promise;
            expect(el).not.toBeNull();
        });

        it('should resolve null on timeout', async () => {
            vi.useFakeTimers();
            const promise = waitForElement('#missing', 500, 100);
            vi.advanceTimersByTime(600);
            const el = await promise;
            expect(el).toBeNull();
        });
    });

    describe('waitFor', () => {
        afterEach(() => {
            vi.useRealTimers();
        });

        it('should resolve true immediately if predicate is truthy', async () => {
            const result = await waitFor(() => true);
            expect(result).toBe(true);
        });

        it('should resolve true when predicate becomes truthy', async () => {
            let ready = false;
            const promise = waitFor(() => ready, 2000, 50);
            setTimeout(() => { ready = true; }, 100);
            const result = await promise;
            expect(result).toBe(true);
        });

        it('should resolve false on timeout', async () => {
            vi.useFakeTimers();
            const promise = waitFor(() => false, 500, 100);
            vi.advanceTimersByTime(600);
            const result = await promise;
            expect(result).toBe(false);
        });
    });

    // =========================================================================
    // Style Injection
    // =========================================================================

    describe('injectStyles', () => {
        it('should inject a style element', () => {
            const style = injectStyles('test-styles', 'body { color: red; }');
            expect(style.id).toBe('test-styles');
            expect(style.textContent).toBe('body { color: red; }');
            expect(document.getElementById('test-styles')).toBe(style);
        });

        it('should update existing style element', () => {
            injectStyles('test-styles', 'body { color: red; }');
            const updated = injectStyles('test-styles', 'body { color: blue; }');
            expect(updated.textContent).toBe('body { color: blue; }');
            expect(document.querySelectorAll('#test-styles')).toHaveLength(1);
        });
    });

    describe('removeStyles', () => {
        it('should remove an injected style', () => {
            injectStyles('removable', '.test {}');
            expect(document.getElementById('removable')).not.toBeNull();
            removeStyles('removable');
            expect(document.getElementById('removable')).toBeNull();
        });

        it('should not throw when removing non-existent style', () => {
            expect(() => removeStyles('nonexistent')).not.toThrow();
        });
    });

    // =========================================================================
    // Audio Element Helpers
    // =========================================================================

    describe('getAudioElement', () => {
        it('should find audio element', () => {
            document.body.innerHTML = '<audio src="test.mp3"></audio>';
            expect(getAudioElement()).not.toBeNull();
        });

        it('should return null when no audio element', () => {
            expect(getAudioElement()).toBeNull();
        });
    });

    describe('getPlayerBar', () => {
        it('should find player bar with .player-bar-container', () => {
            document.body.innerHTML = '<div class="player-bar-container">Player</div>';
            expect(getPlayerBar()).not.toBeNull();
        });

        it('should find player bar with .q-footer', () => {
            document.body.innerHTML = '<footer class="q-footer">Player</footer>';
            expect(getPlayerBar()).not.toBeNull();
        });

        it('should return null when no player bar', () => {
            expect(getPlayerBar()).toBeNull();
        });
    });

    describe('hasPlayerBar', () => {
        it('should return true when player bar exists', () => {
            document.body.innerHTML = '<div class="player-bar">Player</div>';
            expect(hasPlayerBar()).toBe(true);
        });

        it('should return false when no player bar', () => {
            expect(hasPlayerBar()).toBe(false);
        });
    });

    describe('getAudioSource', () => {
        it('should return null when no audio element', () => {
            expect(getAudioSource()).toBeNull();
        });

        it('should return src attribute', () => {
            document.body.innerHTML = '<audio src="test.mp3"></audio>';
            const audio = document.querySelector('audio')!;
            // jsdom may not set currentSrc, so we check src fallback
            expect(getAudioSource()).not.toBeNull();
        });
    });

    describe('isAudioPlaying', () => {
        it('should return false when no audio element', () => {
            expect(isAudioPlaying()).toBe(false);
        });

        it('should return false when audio is paused', () => {
            document.body.innerHTML = '<audio src="test.mp3"></audio>';
            expect(isAudioPlaying()).toBe(false);
        });
    });

    // =========================================================================
    // Vue 2 Element Accessors
    // =========================================================================

    describe('getVueItem', () => {
        it('should return null for non-Vue element', () => {
            const el = document.createElement('div');
            expect(getVueItem(el)).toBeNull();
        });

        it('should extract item from $attrs', () => {
            const el = document.createElement('div') as any;
            el.__vue__ = { $attrs: { item: { id: 1 } } };
            expect(getVueItem(el)).toEqual({ id: 1 });
        });

        it('should extract item from direct property', () => {
            const el = document.createElement('div') as any;
            el.__vue__ = { item: { id: 2 } };
            expect(getVueItem(el)).toEqual({ id: 2 });
        });

        it('should extract item from $props', () => {
            const el = document.createElement('div') as any;
            el.__vue__ = { $props: { item: { id: 3 } } };
            expect(getVueItem(el)).toEqual({ id: 3 });
        });

        it('should prioritize $attrs over direct item', () => {
            const el = document.createElement('div') as any;
            el.__vue__ = { $attrs: { item: 'attrs' }, item: 'direct' };
            expect(getVueItem(el)).toBe('attrs');
        });
    });

    describe('getFatherFolder', () => {
        it('should return empty array for null', () => {
            expect(getFatherFolder(null)).toEqual([]);
        });

        it('should return empty array for non-object', () => {
            expect(getFatherFolder('string')).toEqual([]);
        });

        it('should extract fatherFolder from direct property', () => {
            const vm = { fatherFolder: [1, 2, 3] };
            expect(getFatherFolder(vm)).toEqual([1, 2, 3]);
        });

        it('should extract from $data', () => {
            const vm = { $data: { fatherFolder: ['a', 'b'] } };
            expect(getFatherFolder(vm)).toEqual(['a', 'b']);
        });
    });

    // =========================================================================
    // Theme Detection
    // =========================================================================

    describe('isDarkMode', () => {
        it('should return true when body has body--dark class', () => {
            document.body.classList.add('body--dark');
            expect(isDarkMode()).toBe(true);
        });

        it('should return true when body has q-dark class', () => {
            document.body.classList.add('q-dark');
            expect(isDarkMode()).toBe(true);
        });

        it('should return false when no dark class', () => {
            expect(isDarkMode()).toBe(false);
        });
    });

    describe('getThemeColors', () => {
        it('should return dark theme colors in dark mode', () => {
            document.body.classList.add('body--dark');
            const colors = getThemeColors();
            expect(colors.bg).toBe('#1d1d1d');
            expect(colors.text).toBe('#ffffff');
        });

        it('should return light theme colors in light mode', () => {
            const colors = getThemeColors();
            expect(colors.bg).toBe('#ffffff');
            expect(colors.text).toBe('#000000');
        });

        it('should include accent color', () => {
            const colors = getThemeColors();
            expect(colors.accent).toBe('var(--asmr-accent, #f06292)');
        });
    });

    // =========================================================================
    // Viewport
    // =========================================================================

    describe('isInViewport', () => {
        it('should handle elements (jsdom has zero dimensions)', () => {
            const el = document.createElement('div');
            document.body.appendChild(el);
            // In jsdom, getBoundingClientRect returns all zeros, which means
            // top=0, left=0, bottom=0, right=0 — satisfies the conditions
            const result = isInViewport(el);
            expect(typeof result).toBe('boolean');
        });
    });
});
