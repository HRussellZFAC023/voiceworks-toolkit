/**
 * JpdbController — Feature Lifecycle Controller
 *
 * Coordinates FuriganaRenderer, JpdbPopover, and JpdbService.
 * Registered as a lazy feature in main.ts.
 */

import { Logger } from '../core/Logger';
import { AppStore } from '../store/AppStore';
import { EventBus } from '../core/EventBus';
import { JpdbService } from '../services/JpdbService';
import { FuriganaRenderer } from './FuriganaRenderer';
import type { ConfigKey, JPDBCard, JPDBGrade } from '../types';

export class JpdbController {
    private renderer = new FuriganaRenderer();
    private popoverCleanup: (() => void) | null = null;
    private subConfigKeys: ConfigKey[] = [
        'jpdbShowFurigana',
        'jpdbShowPitchAccent',
        'jpdbSiteFurigana',
        'jpdbSubtitleFurigana',
        'jpdbApiToken',
    ];
    private configUnsub: (() => void) | null = null;

    async enable(): Promise<void> {
        Logger.debug('[JPDB] Enabling...');

        // Validate API key
        const token = AppStore.getConfig('jpdbApiToken');
        if (token) {
            const valid = await JpdbService.ping().catch(() => false);
            if (!valid) {
                Logger.warn('[JPDB] API key is invalid');
            }
        }

        // Enable sitewide furigana
        if (AppStore.getConfig('jpdbSiteFurigana')) {
            this.renderer.enable();
        }

        // Mount popover handler
        this.mountPopover();

        // Listen for sub-config changes
        this.configUnsub = this.listenConfigChanges();

        Logger.debug('[JPDB] Enabled');
    }

    disable(): void {
        this.renderer.disable();
        this.popoverCleanup?.();
        this.popoverCleanup = null;
        this.configUnsub?.();
        this.configUnsub = null;
        JpdbService.clearCaches();
        Logger.debug('[JPDB] Disabled');
    }

    // =========================================================================
    // Popover Event Delegation
    // =========================================================================

    private activePopover: HTMLElement | null = null;
    private activeBackdrop: HTMLElement | null = null;

    private mountPopover(): void {
        const handleClick = (e: MouseEvent | TouchEvent) => {
            const target = (e.target as HTMLElement).closest?.('.jpdb-word[data-vid]') as HTMLElement | null;
            if (!target) return;

            e.preventDefault();
            e.stopImmediatePropagation();

            const vid = parseInt(target.getAttribute('data-vid') || '0', 10);
            const sid = parseInt(target.getAttribute('data-sid') || '0', 10);
            if (!vid) return;

            this.showPopover(target, vid, sid);
        };

        // Event delegation on document (must be higher than host app's handlers)
        document.addEventListener('click', handleClick, { capture: true });

        // Keyboard: hotkey to show + escape to dismiss
        const handleKeydown = (e: KeyboardEvent) => {
            // Escape always dismisses
            if (e.key === 'Escape' && this.activePopover) {
                e.preventDefault();
                this.dismissPopover();
                return;
            }

            // 1-5 keys grade when popover is open
            if (this.activePopover && e.key >= '1' && e.key <= '5' && !e.ctrlKey && !e.altKey && !e.metaKey) {
                const gradeMap: Record<string, string> = { '1': 'nothing', '2': 'something', '3': 'hard', '4': 'okay', '5': 'easy' };
                const btn = this.activePopover.querySelector(`[data-grade="${gradeMap[e.key]}"]`) as HTMLButtonElement | null;
                if (btn && !btn.disabled) {
                    e.preventDefault();
                    btn.click();
                }
                return;
            }

            const hotkey = AppStore.getConfig('hotkeyJpdbPopover');
            if (!hotkey) return;

            const keys = hotkey.split('+');
            const key = keys[keys.length - 1];
            const needShift = keys.includes('Shift');
            const needCtrl = keys.includes('Ctrl');
            const needAlt = keys.includes('Alt');

            if (
                e.key === key &&
                e.shiftKey === needShift &&
                e.ctrlKey === needCtrl &&
                e.altKey === needAlt
            ) {
                const hovered = document.querySelector('.jpdb-word:hover') as HTMLElement | null;
                if (hovered) {
                    const vid = parseInt(hovered.getAttribute('data-vid') || '0', 10);
                    const sid = parseInt(hovered.getAttribute('data-sid') || '0', 10);
                    if (vid) this.showPopover(hovered, vid, sid);
                }
            }
        };

        document.addEventListener('keydown', handleKeydown);

        this.popoverCleanup = () => {
            document.removeEventListener('click', handleClick, { capture: true });
            document.removeEventListener('keydown', handleKeydown);
            this.dismissPopover();
        };
    }

    // =========================================================================
    // Popover Display
    // =========================================================================

    private async showPopover(anchor: HTMLElement, vid: number, sid: number): Promise<void> {
        this.dismissPopover();

        let card = JpdbService.getCard(vid, sid);

        // If card not cached, try to fetch
        if (!card) {
            try {
                await JpdbService.parse([anchor.textContent || '']);
                card = JpdbService.getCard(vid, sid);
            } catch {
                // Ignore
            }
        }

        if (!card) return;

        const { I18n } = await import('../core/Config');
        const t = (key: string) => I18n.t(key);
        const hasKey = !!AppStore.getConfig('jpdbApiToken');
        const isMobile = window.innerWidth < 768;
        const disableReviews = AppStore.getConfig('jpdbDisableReviews');
        const useTwoGrades = AppStore.getConfig('jpdbUseTwoGrades');

        // State
        const cardState = card.cardState[0] || 'not-in-deck';
        const stateLabel = this.getStateLabel(cardState, t);
        const isNeverForget = card.cardState.includes('never-forget' as never);
        const isBlacklisted = card.cardState.includes('blacklisted' as never);

        // Meanings (max 5) — skip per-meaning POS if it matches the card-level POS
        const cardPos = card.partOfSpeech.join(', ').toLowerCase();
        const meaningsHtml = card.meanings.slice(0, 5).map(m => {
            const posLabel = m.partOfSpeech?.join(', ') || '';
            const showPos = posLabel && posLabel.toLowerCase() !== cardPos;
            return `<div class="jpdb-popover-meaning">
                ${showPos ? `<span class="jpdb-popover-meaning-pos">${this.esc(posLabel)}</span>` : ''}
                <span class="jpdb-popover-meaning-gloss">${this.esc(m.glosses.join('; '))}</span>
            </div>`;
        }).join('');

        // Pitch accent SVG
        const pitchSvg = this.renderPitchSvg(card.pitchAccent, card.reading);

        // Mining buttons HTML
        const miningHtml = hasKey ? `
            <div class="jpdb-popover-section">
                <div class="jpdb-popover-actions jpdb-popover-mining">
                    <button class="jpdb-popover-btn jpdb-btn-add" data-action="add">${t('jpdbBtnAdd')}</button>
                    <button class="jpdb-popover-btn jpdb-btn-neverforget" data-action="neverforget">${isNeverForget ? t('jpdbBtnForget') : t('jpdbBtnNeverForget')}</button>
                    <button class="jpdb-popover-btn jpdb-btn-blacklist" data-action="blacklist">${isBlacklisted ? t('jpdbBtnUnlist') : t('jpdbBtnBlacklist')}</button>
                </div>
            </div>` : '';

        // Grading buttons HTML
        let gradingHtml = '';
        if (hasKey && !disableReviews) {
            if (useTwoGrades) {
                gradingHtml = `
                    <div class="jpdb-popover-section">
                        <div class="jpdb-popover-actions jpdb-popover-grading jpdb-two-grades">
                            <button class="jpdb-popover-btn jpdb-btn-fail" data-action="grade" data-grade="fail">${t('jpdbGradeFail')}</button>
                            <button class="jpdb-popover-btn jpdb-btn-pass" data-action="grade" data-grade="pass">${t('jpdbGradePass')}</button>
                        </div>
                    </div>`;
            } else {
                gradingHtml = `
                    <div class="jpdb-popover-section">
                        <div class="jpdb-popover-actions jpdb-popover-grading">
                            <button class="jpdb-popover-btn jpdb-btn-nothing" data-action="grade" data-grade="nothing">${t('jpdbGradeNothing')}</button>
                            <button class="jpdb-popover-btn jpdb-btn-something" data-action="grade" data-grade="something">${t('jpdbGradeSomething')}</button>
                            <button class="jpdb-popover-btn jpdb-btn-hard" data-action="grade" data-grade="hard">${t('jpdbGradeHard')}</button>
                            <button class="jpdb-popover-btn jpdb-btn-okay" data-action="grade" data-grade="okay">${t('jpdbGradeOkay')}</button>
                            <button class="jpdb-popover-btn jpdb-btn-easy" data-action="grade" data-grade="easy">${t('jpdbGradeEasy')}</button>
                        </div>
                    </div>`;
            }
        }

        // No-key prompt
        const noKeyHtml = !hasKey ? `
            <div class="jpdb-popover-no-key">
                ${t('jpdbPopoverNoKey')}<br>
                <a href="https://jpdb.io/settings#:~:text=in%20the%20future.-,Account%20information,-Username" target="_blank" rel="noopener">${t('jpdbPopoverGetKey')}</a>
            </div>` : '';

        // Build popover
        const popover = document.createElement('div');
        popover.className = 'jpdb-popover';
        popover.setAttribute('role', 'dialog');
        popover.ariaLabel = card.spelling;

        // Only show reading if different from spelling (skip for all-kana words)
        const showReading = card.reading !== card.spelling;

        const spellingLink = showReading
            ? this.buildSegmentedRuby(card.spelling, card.reading)
            : this.esc(card.spelling);

        popover.innerHTML = `
            <div class="jpdb-popover-header">
                <a class="jpdb-popover-spelling jpdb-${cardState}" href="https://jpdb.io/vocabulary/${vid}/${encodeURIComponent(card.spelling)}/${encodeURIComponent(card.reading)}" target="_blank" rel="noopener">${spellingLink}</a>
                ${pitchSvg ? `<div class="jpdb-popover-pitch">${pitchSvg}</div>` : ''}
            </div>
            <div class="jpdb-popover-pos">${this.esc(card.partOfSpeech.join(', '))}</div>
            <div class="jpdb-popover-meanings">${meaningsHtml}</div>
            <div class="jpdb-popover-meta">
                ${card.frequencyRank ? `<span>#${card.frequencyRank}</span>` : ''}
                <span class="jpdb-popover-state">
                    <span class="jpdb-popover-state-dot jpdb-${cardState}"></span>
                    ${this.esc(stateLabel)}
                </span>
            </div>
            ${miningHtml}
            ${gradingHtml}
            ${noKeyHtml}
        `;

        // Action handler
        popover.addEventListener('click', async (e) => {
            const btn = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
            if (!btn) return;

            const action = btn.dataset.action;
            btn.setAttribute('disabled', 'true');

            try {
                if (action === 'grade') {
                    const grade = btn.dataset.grade as JPDBGrade;
                    const spelling = card!.spelling;
                    this.dismissPopover();
                    if (grade) {
                        JpdbService.reviewCard(vid, sid, grade)
                            .then(() => JpdbService.fetchCardState(vid, sid, spelling))
                            .then(refreshed => {
                                if (refreshed) {
                                    this.updateWordElements(vid, sid, refreshed.cardState[0] || 'not-in-deck');
                                    this.dispatchCardGraded(vid, sid, refreshed.cardState as string[]);
                                }
                            })
                            .catch(err => Logger.error('[JPDB] Grade failed:', err));
                    }
                } else {
                    if (action === 'add') {
                        await this.handleAddToDeck(vid, sid);
                        this.updateWordElements(vid, sid, 'learning');
                        this.dispatchCardGraded(vid, sid, ['learning']);
                    } else if (action === 'neverforget') {
                        await this.handleToggleDeck(vid, sid, card!, 'never-forget',
                            AppStore.getConfig('jpdbNeverForgetDeck') || 'never-forget');
                        const updatedCard = JpdbService.getCard(vid, sid);
                        const newState = updatedCard?.cardState || ['not-in-deck'];
                        this.updateWordElements(vid, sid, newState[0] || 'not-in-deck');
                        this.dispatchCardGraded(vid, sid, newState);
                    } else if (action === 'blacklist') {
                        await this.handleToggleDeck(vid, sid, card!, 'blacklisted',
                            AppStore.getConfig('jpdbBlacklistDeck') || 'blacklist');
                        const updatedCard = JpdbService.getCard(vid, sid);
                        const newState = updatedCard?.cardState || ['not-in-deck'];
                        this.updateWordElements(vid, sid, newState[0] || 'not-in-deck');
                        this.dispatchCardGraded(vid, sid, newState);
                    }
                    this.dismissPopover();
                }
            } catch (err) {
                Logger.error('[JPDB] Action failed:', err);
                btn.removeAttribute('disabled');
            }
        });

        // Backdrop
        const backdrop = document.createElement('div');
        backdrop.className = 'jpdb-popover-backdrop';
        backdrop.setAttribute('aria-hidden', 'true');
        backdrop.addEventListener('click', () => this.dismissPopover());

        // Drag handle for mobile bottom sheet (click to dismiss + swipe down)
        if (isMobile) {
            const handle = document.createElement('div');
            handle.className = 'jpdb-popover-handle';
            popover.prepend(handle);

            handle.addEventListener('click', (e) => {
                e.stopPropagation();
                this.dismissPopover();
            });

            // Swipe-down-to-dismiss on the whole popover
            let startY = 0;
            let currentY = 0;
            let dragging = false;

            popover.addEventListener('touchstart', (e) => {
                // Only initiate drag from handle area or top of popover when scrolled to top
                const touch = e.touches[0];
                const handleRect = handle.getBoundingClientRect();
                const inHandle = touch.clientY <= handleRect.bottom + 20;
                if (!inHandle && popover.scrollTop > 0) return;
                startY = touch.clientY;
                currentY = startY;
                dragging = true;
                popover.style.transition = 'none';
            }, { passive: true });

            popover.addEventListener('touchmove', (e) => {
                if (!dragging) return;
                currentY = e.touches[0].clientY;
                const dy = currentY - startY;
                if (dy > 0) {
                    popover.style.transform = `translateY(${dy}px)`;
                    e.preventDefault();
                }
            }, { passive: false });

            popover.addEventListener('touchend', () => {
                if (!dragging) return;
                dragging = false;
                const dy = currentY - startY;
                if (dy > 80) {
                    // Swipe far enough — dismiss with animation
                    popover.style.transition = 'transform 0.2s ease-out';
                    popover.style.transform = 'translateY(100%)';
                    popover.addEventListener('transitionend', () => this.dismissPopover(), { once: true });
                } else {
                    // Snap back
                    popover.style.transition = 'transform 0.2s ease-out';
                    popover.style.transform = 'translateY(0)';
                }
            }, { passive: true });
        }

        document.body.appendChild(backdrop);
        document.body.appendChild(popover);

        // Position
        if (!isMobile) {
            const anchorRect = anchor.getBoundingClientRect();
            const popoverRect = popover.getBoundingClientRect();

            let top = anchorRect.top - popoverRect.height - 8;
            let left = anchorRect.left + (anchorRect.width - popoverRect.width) / 2;

            // Flip below if above viewport
            if (top < 8) {
                top = anchorRect.bottom + 8;
            }

            // Clamp horizontal
            left = Math.max(8, Math.min(left, window.innerWidth - popoverRect.width - 8));

            popover.style.top = `${top}px`;
            popover.style.left = `${left}px`;
        }

        this.activePopover = popover;
        this.activeBackdrop = backdrop;
    }

    private dismissPopover(): void {
        this.activePopover?.remove();
        this.activeBackdrop?.remove();
        this.activePopover = null;
        this.activeBackdrop = null;
    }

    // =========================================================================
    // DOM State Updates
    // =========================================================================

    private static readonly STATE_CLASSES = [
        'jpdb-new', 'jpdb-learning', 'jpdb-known', 'jpdb-due', 'jpdb-failed',
        'jpdb-locked', 'jpdb-never-forget', 'jpdb-blacklisted', 'jpdb-suspended',
        'jpdb-not-in-deck', 'jpdb-redundant',
    ];

    private updateWordElements(vid: number, sid: number, newState: string): void {
        const els = document.querySelectorAll(`.jpdb-word[data-vid="${vid}"][data-sid="${sid}"]`);
        for (const el of els) {
            el.classList.remove(...JpdbController.STATE_CLASSES);
            el.classList.add(`jpdb-${newState}`);
        }
    }

    /** Notify Vue components that a card's state changed so they can update reactively. */
    private dispatchCardGraded(vid: number, sid: number, cardState: string[]): void {
        document.dispatchEvent(new CustomEvent('jpdb:card-graded', {
            detail: { vid, sid, cardState },
        }));
    }

    // =========================================================================
    // Mining & Deck Actions
    // =========================================================================

    private async handleAddToDeck(vid: number, sid: number): Promise<void> {
        const miningDeck = AppStore.getConfig('jpdbMiningDeck');
        const addToForq = AppStore.getConfig('jpdbAddToForq');

        if (miningDeck) {
            await JpdbService.addToDeck(miningDeck, vid, sid);
        } else {
            // Default: add to forq
            await JpdbService.addToDeck('forq', vid, sid);
        }

        // Optionally also add to forq if mining deck is not forq
        if (addToForq && miningDeck && miningDeck !== 'forq') {
            await JpdbService.addToDeck('forq', vid, sid);
        }
    }

    private async handleToggleDeck(
        vid: number,
        sid: number,
        card: JPDBCard,
        stateKey: string,
        deckId: string,
    ): Promise<void> {
        const hasState = card.cardState.includes(stateKey as never);

        if (hasState) {
            await JpdbService.removeFromDeck(deckId, vid, sid);
        } else {
            await JpdbService.addToDeck(deckId, vid, sid);
        }

        // Update local card state
        JpdbService.updateCardState(vid, sid,
            hasState
                ? card.cardState.filter(s => s !== stateKey)
                : [...card.cardState, stateKey as never],
        );
    }

    // =========================================================================
    // State Labels
    // =========================================================================

    private getStateLabel(state: string, t: (key: string) => string): string {
        const map: Record<string, string> = {
            'new': t('jpdbStateNew'),
            'learning': t('jpdbStateLearning'),
            'known': t('jpdbStateKnown'),
            'due': t('jpdbStateDue'),
            'failed': t('jpdbStateFailed'),
            'locked': t('jpdbStateLocked'),
            'not-in-deck': t('jpdbStateNotInDeck'),
            'suspended': t('jpdbStateSuspended'),
            'blacklisted': t('jpdbStateBlacklisted'),
            'never-forget': t('jpdbStateNeverForget'),
            'redundant': t('jpdbStateRedundant'),
        };
        return map[state] || state;
    }

    // =========================================================================
    // Pitch Accent SVG
    // =========================================================================

    private renderPitchSvg(pitchAccent: string[], reading: string): string {
        if (!pitchAccent.length || !reading) return '';

        const [pitch] = pitchAccent;
        if (!pitch) return '';

        const morae = this.splitMorae(reading);
        const positions: boolean[] = []; // true = high

        for (const c of pitch) {
            if (c === 'H') positions.push(true);
            else if (c === 'L') positions.push(false);
        }

        if (positions.length < 2) return '';

        const moraWidth = 24;
        const width = morae.length * moraWidth + 20;
        const height = 48;
        const highY = 10;
        const lowY = 30;
        const textY = 46;

        const visiblePositions = positions.slice(0, morae.length);
        const points = visiblePositions.map((high, i) =>
            `${10 + i * moraWidth},${high ? highY : lowY}`,
        );

        const pitchClass = this.getPitchClassFromPattern(pitch);

        let svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;
        svg += `<polyline class="jpdb-pitch-line ${pitchClass}" points="${points.join(' ')}" />`;

        for (let i = 0; i < visiblePositions.length; i++) {
            const x = 10 + i * moraWidth;
            const y = visiblePositions[i] ? highY : lowY;
            svg += `<circle class="jpdb-pitch-dot" cx="${x}" cy="${y}" r="3" style="color: var(--asmr-text-primary)" />`;
        }

        for (let i = 0; i < morae.length; i++) {
            svg += `<text class="jpdb-pitch-mora" x="${10 + i * moraWidth}" y="${textY}" text-anchor="middle">${this.esc(morae[i])}</text>`;
        }

        svg += '</svg>';
        return svg;
    }

    private splitMorae(reading: string): string[] {
        const smallKana = new Set('ゃゅょャュョァィゥェォ');
        const morae: string[] = [];
        const chars = Array.from(reading);

        for (let i = 0; i < chars.length; i++) {
            if (i > 0 && smallKana.has(chars[i])) {
                morae[morae.length - 1] += chars[i];
            } else {
                morae.push(chars[i]);
            }
        }
        return morae;
    }

    private getPitchClassFromPattern(pitch: string): string {
        const parts = pitch.split('');
        const first = parts[0];
        const drops = (pitch.match(/HL/g) ?? []).length;
        const rises = (pitch.match(/LH/g) ?? []).length;

        if (first === 'H' && drops === 1 && parts[1] === 'L') return 'atamadaka';
        if (first === 'L' && rises === 1 && !pitch.endsWith('L')) return 'heiban';
        if (first === 'L' && pitch.endsWith('L') && rises === 1) return 'nakadaka';
        if (first === 'L' && rises === 1) return 'odaka';
        if (rises > 1 || drops > 1) return 'kifuku';
        return 'heiban';
    }

    // =========================================================================
    // Config Change Listener
    // =========================================================================

    private listenConfigChanges(): () => void {
        const handler = ({ key, value }: { key: string; value: unknown }) => {
            if (!this.subConfigKeys.includes(key as ConfigKey)) return;

            if (key === 'jpdbSiteFurigana') {
                if (value) this.renderer.enable();
                else this.renderer.disable();
            } else if (key === 'jpdbShowFurigana' || key === 'jpdbShowPitchAccent') {
                this.renderer.disable();
                if (AppStore.getConfig('jpdbSiteFurigana')) {
                    this.renderer.enable();
                }
            } else if (key === 'jpdbApiToken') {
                JpdbService.clearCaches();
                this.renderer.disable();
                if (AppStore.getConfig('jpdbSiteFurigana')) {
                    this.renderer.enable();
                }
            }
        };

        EventBus.on('config:change', handler);
        return () => EventBus.off('config:change', handler);
    }

    // =========================================================================
    // Utility
    // =========================================================================

    /**
     * Build per-kanji ruby HTML from spelling + reading.
     * Splits kanji runs from kana runs, matches shared kana anchors
     * in the reading, and only annotates the kanji portions.
     * e.g. 食べる + たべる → <ruby>食<rt>た</rt></ruby>べる
     */
    private buildSegmentedRuby(spelling: string, reading: string): string {
        const isKana = (ch: string) => /[\u3040-\u309f\u30a0-\u30ff]/.test(ch);
        const toHira = (s: string) => s.replace(/[\u30a0-\u30ff]/g, c =>
            String.fromCharCode(c.charCodeAt(0) - 0x60));

        // Split spelling into segments: alternating kanji runs and kana runs
        const segments: { text: string; isKanji: boolean }[] = [];
        let buf = '';
        let bufIsKana: boolean | null = null;

        for (const ch of spelling) {
            const kana = isKana(ch);
            if (bufIsKana !== null && kana !== bufIsKana) {
                segments.push({ text: buf, isKanji: !bufIsKana });
                buf = '';
            }
            buf += ch;
            bufIsKana = kana;
        }
        if (buf) segments.push({ text: buf, isKanji: !bufIsKana! });

        // If all kanji or all kana, use simple ruby
        if (segments.length <= 1) {
            if (segments[0]?.isKanji) {
                return `<ruby>${this.esc(spelling)}<rp>(</rp><rt>${this.esc(reading)}</rt><rp>)</rp></ruby>`;
            }
            return this.esc(spelling);
        }

        // Match kana anchors in reading to distribute readings across kanji segments
        const readingHira = toHira(reading);
        let readPos = 0;
        const result: string[] = [];

        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];

            if (!seg.isKanji) {
                // Kana segment — find it in reading and advance past it
                const segHira = toHira(seg.text);
                const idx = readingHira.indexOf(segHira, readPos);
                if (idx >= 0) {
                    readPos = idx + segHira.length;
                }
                result.push(this.esc(seg.text));
            } else {
                // Kanji segment — reading runs from readPos to next kana anchor
                const nextKanaSeg = segments.slice(i + 1).find(s => !s.isKanji);
                let endPos: number;

                if (nextKanaSeg) {
                    const nextHira = toHira(nextKanaSeg.text);
                    const idx = readingHira.indexOf(nextHira, readPos);
                    endPos = idx >= 0 ? idx : reading.length;
                } else {
                    endPos = reading.length;
                }

                const kanjiReading = reading.slice(readPos, endPos);
                readPos = endPos;
                result.push(`<ruby>${this.esc(seg.text)}<rp>(</rp><rt>${this.esc(kanjiReading)}</rt><rp>)</rp></ruby>`);
            }
        }

        return result.join('');
    }

    private esc(str: string): string {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
}
