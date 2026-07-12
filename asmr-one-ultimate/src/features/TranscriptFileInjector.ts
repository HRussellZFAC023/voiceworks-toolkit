import { Logger, Config, I18n } from '../core/Utils';
import { EventBus } from '../core/EventBus';
import { SharedCache, CacheKeys } from '../core/Cache';
import { getCleanText } from '../core/DomUtils';
import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import type { WhisperSegment } from '../types';
import {
    buildLrcFromSegments,
    buildPlainTextFromSegments,
    buildTranscriptFileName,
    buildVttFromSegments,
} from './transcriptFileUtils';

interface TranscriptIndexEntry {
    cacheKey: string;
    trackKey: string;
    trackTitle?: string;
    workId?: string;
    model: string;
    subtask: string;
    language: string;
    updatedAt: number;
    duration?: number;
}

interface CachedTranscript {
    text: string;
    segments: WhisperSegment[];
    model: string;
    subtask: string;
    language: string;
    createdAt: number;
    lrc?: string;
    vtt?: string;
    complete?: boolean;
    translations?: Record<string, { text: string; lrc: string; vtt?: string }>;
}

const BADGE_ATTR = 'data-asmr-transcript';

export class TranscriptFileInjector {
    private bridge = KikoeruBridge.getInstance();
    private cleanups: (() => void)[] = [];
    private refreshTimer: number | null = null;
    private flatAttachTimer: number | null = null;
    private flatObserver: MutationObserver | null = null;
    private flatDebounce: number | null = null;
    private enabled = false;

    public enable(): void {
        if (this.enabled) return;
        this.enabled = true;

        this.cleanups.push(EventBus.on('worktree:enhanced', (data: { workTree: HTMLElement }) => {
            this.injectBadges(data.workTree);
        }));

        this.cleanups.push(EventBus.on('flatview:toggle', (data: { active: boolean }) => {
            this.clearFlatAttachTimer();
            if (data.active) {
                this.flatAttachTimer = window.setTimeout(() => {
                    this.flatAttachTimer = null;
                    this.attachFlatPanel();
                }, 200);
            } else {
                this.detachFlatPanel();
            }
        }));

        this.cleanups.push(EventBus.on('whisper:complete', () => this.scheduleRefresh()));
        this.cleanups.push(EventBus.on('whisper:cache-updated', () => this.scheduleRefresh()));
        this.cleanups.push(EventBus.on('work:change', () => this.scheduleRefresh()));
        this.cleanups.push(EventBus.on('lang:change', () => this.scheduleRefresh()));
        this.cleanups.push(EventBus.on('config:change', ({ key }: { key: string }) => {
            if (key === 'subtitleLang') this.scheduleRefresh();
        }));

        this.refresh();
    }

    public disable(): void {
        if (!this.enabled) return;
        this.enabled = false;
        this.cleanups.forEach(fn => fn());
        this.cleanups = [];
        if (this.refreshTimer !== null) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
        this.clearFlatAttachTimer();
        this.detachFlatPanel();
        document.querySelectorAll(`[${BADGE_ATTR}]`).forEach(el => el.remove());
    }

    private scheduleRefresh(): void {
        if (!this.enabled) return;
        if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
        this.refreshTimer = window.setTimeout(() => {
            this.refreshTimer = null;
            this.refresh();
        }, 80);
    }

    private refresh(): void {
        if (!this.enabled) return;
        const workTree = document.getElementById('work-tree');
        if (workTree) this.injectBadges(workTree);

        const flatBody = document.querySelector('.asmr-flat-panel__body');
        if (flatBody) this.injectBadges(flatBody);
    }

    private attachFlatPanel(): void {
        if (!this.enabled) return;
        const body = document.querySelector('.asmr-flat-panel__body');
        if (!body) return;

        this.injectBadges(body);

        this.flatObserver?.disconnect();
        this.flatObserver = new MutationObserver(() => {
            if (!this.enabled) return;
            // Debounce: batch rapid Vue re-renders into one injection pass
            if (this.flatDebounce !== null) return;
            this.flatDebounce = window.setTimeout(() => {
                this.flatDebounce = null;
                if (this.enabled) this.injectBadges(body);
            }, 150);
        });
        this.flatObserver.observe(body, { childList: true, subtree: true });
    }

    private detachFlatPanel(): void {
        this.flatObserver?.disconnect();
        this.flatObserver = null;
        if (this.flatDebounce !== null) {
            clearTimeout(this.flatDebounce);
            this.flatDebounce = null;
        }
    }

    private clearFlatAttachTimer(): void {
        if (this.flatAttachTimer !== null) {
            clearTimeout(this.flatAttachTimer);
            this.flatAttachTimer = null;
        }
    }

    /** Build lookup maps from the whisper index: by normalized title and by trackKey (hash). */
    private buildLookupMaps(): { byTitle: Map<string, TranscriptIndexEntry>; byHash: Map<string, TranscriptIndexEntry> } {
        const index = SharedCache.get<Record<string, TranscriptIndexEntry[]>>(CacheKeys.whisperIndex()) || {};
        const byTitle = new Map<string, TranscriptIndexEntry>();
        const byHash = new Map<string, TranscriptIndexEntry>();
        const currentWorkId = this.bridge.currentWorkId?.trim().toLowerCase() || '';
        const titleCandidates = new Map<string, TranscriptIndexEntry[]>();

        for (const [trackKey, list] of Object.entries(index)) {
            for (const entry of list) {
                // Exact hashes are safe across works and always take precedence.
                if (trackKey) {
                    const existing = byHash.get(trackKey);
                    if (!existing || entry.updatedAt > existing.updatedAt) {
                        byHash.set(trackKey, entry);
                    }
                }

                // Titles are not globally unique. Retain candidates here, then
                // admit only a current-work match or an unambiguous legacy row.
                const title = (entry.trackTitle || '').trim().toLowerCase();
                if (title) {
                    const candidates = titleCandidates.get(title) || [];
                    candidates.push(entry);
                    titleCandidates.set(title, candidates);
                }
            }
        }

        for (const [title, candidates] of titleCandidates) {
            const currentWorkMatches = currentWorkId
                ? candidates.filter(entry => entry.workId?.trim().toLowerCase() === currentWorkId)
                : [];
            const eligible = currentWorkMatches.length > 0
                ? currentWorkMatches
                : candidates.filter(entry => !entry.workId);
            const distinctTrackKeys = new Set(eligible.map(entry => entry.trackKey).filter(Boolean));

            // A filename fallback is safe only when it identifies one track,
            // even inside the same work (different folders may repeat names).
            if (distinctTrackKeys.size !== 1) continue;
            const newest = eligible.reduce<TranscriptIndexEntry | undefined>(
                (latest, entry) => !latest || entry.updatedAt > latest.updatedAt ? entry : latest,
                undefined,
            );
            if (newest) byTitle.set(title, newest);
        }
        return { byTitle, byHash };
    }

    private injectBadges(container: Element): void {
        const { byTitle, byHash } = this.buildLookupMaps();

        // Select worktree list items (skip breadcrumbs)
        const items = Array.from(container.querySelectorAll<HTMLElement>('.q-list > .q-item'));

        for (const li of items) {
            const label = li.querySelector('.q-item__label');
            // Prefer original text stored by TranslatedTags (data-asmrtag),
            // then getCleanText which handles furigana (data-jpdb-original / strips <rt>),
            // before falling back to raw textContent.
            const rawTitle = label
                ? ((label as HTMLElement).dataset?.asmrtag || getCleanText(label))
                : '';
            const title = rawTitle.trim().toLowerCase();

            // Exact row hashes beat filename fallbacks (filenames commonly repeat across works).
            const hash = li.dataset.asmrFlatHash || li.dataset.asmrHash || '';
            const entry = (hash ? byHash.get(hash) : undefined) || (title ? byTitle.get(title) : undefined);
            if (!entry) {
                li.querySelector(`[${BADGE_ATTR}]`)?.remove();
                continue;
            }

            const cached = SharedCache.get<CachedTranscript>(entry.cacheKey);
            if (!cached?.complete || !cached.segments?.length) {
                li.querySelector(`[${BADGE_ATTR}]`)?.remove();
                continue;
            }

            // Check if badge already matches this cache entry (including translation state)
            const targetLang = ((Config.get('subtitleLang') as string | undefined) || '').toLowerCase();
            const hasTranslation = !!(targetLang && cached.translations?.[targetLang]);
            const badgeKey = `${entry.cacheKey}:${hasTranslation ? targetLang : ''}`;
            const existingBadge = li.querySelector<HTMLElement>(`[${BADGE_ATTR}]`);
            if (existingBadge?.dataset.asmrTranscriptKey === badgeKey) continue;

            // Remove stale badge
            existingBadge?.remove();

            const badge = this.createBadgeGroup(entry, cached);
            if (!badge) continue;

            // Insert before copy button if present, else append
            const copyBtn = li.querySelector('[data-xxcopy]');
            if (copyBtn) {
                li.insertBefore(badge, copyBtn);
            } else {
                li.appendChild(badge);
            }
        }
    }

    private createBadgeGroup(entry: TranscriptIndexEntry, cached: CachedTranscript): HTMLElement | null {
        const hasSegments = cached.segments?.length > 0;
        if (!hasSegments) return null;

        const wrap = document.createElement('div');
        wrap.className = 'q-item__section column q-item__section--side justify-center asmr-transcript-actions';
        wrap.setAttribute(BADGE_ATTR, 'true');

        // Composite key includes translation state so badge invalidates when translations arrive
        const targetLang = ((Config.get('subtitleLang') as string | undefined) || '').toLowerCase();
        const hasTranslation = !!(targetLang && cached.translations?.[targetLang]);
        wrap.dataset.asmrTranscriptKey = `${entry.cacheKey}:${hasTranslation ? targetLang : ''}`;

        // LRC download
        const lrc = cached.lrc || buildLrcFromSegments(cached.segments);
        if (lrc) {
            wrap.appendChild(this.createButton(I18n.t('whisperTranscriptDownload'), () => {
                const fresh = SharedCache.get<CachedTranscript>(entry.cacheKey);
                const segs = fresh?.segments || cached.segments;
                const content = fresh?.lrc || buildLrcFromSegments(segs);
                if (content) this.download(buildTranscriptFileName(entry.trackTitle, entry.model, cached.language, 'lrc'), content);
            }));
        }

        // Keep the untranslated source text available for editing or use with
        // an external translation workflow.
        wrap.appendChild(this.createButton(I18n.t('whisperTranscriptDownloadTxt'), () => {
            const fresh = SharedCache.get<CachedTranscript>(entry.cacheKey);
            const segs = fresh?.segments || cached.segments;
            const text = buildPlainTextFromSegments(segs) || fresh?.text || cached.text;
            if (text) this.download(buildTranscriptFileName(entry.trackTitle, entry.model, cached.language, 'txt'), text);
        }, true));

        // VTT download
        wrap.appendChild(this.createButton(I18n.t('vttDownload'), () => {
            const fresh = SharedCache.get<CachedTranscript>(entry.cacheKey);
            const segs = fresh?.segments || cached.segments;
            const vtt = buildVttFromSegments(segs);
            if (vtt) this.download(buildTranscriptFileName(entry.trackTitle, entry.model, cached.language, 'vtt'), vtt);
        }));

        // Translated variants
        const translated = targetLang ? cached.translations?.[targetLang] : undefined;
        if (translated) {
            if (translated.lrc) {
                wrap.appendChild(this.createButton(
                    I18n.format('whisperTranscriptDownloadLang', { lang: targetLang.toUpperCase() }),
                    () => {
                        const fresh = SharedCache.get<CachedTranscript>(entry.cacheKey);
                        const tr = fresh?.translations?.[targetLang] || translated;
                        this.download(buildTranscriptFileName(entry.trackTitle, entry.model, targetLang, 'lrc'), tr.lrc);
                    },
                    true,
                ));
            }
            if (translated.vtt) {
                wrap.appendChild(this.createButton(I18n.t('vttDownloadTranslated'), () => {
                    const fresh = SharedCache.get<CachedTranscript>(entry.cacheKey);
                    const tr = fresh?.translations?.[targetLang] || translated;
                    if (tr.vtt) this.download(buildTranscriptFileName(entry.trackTitle, entry.model, targetLang, 'vtt'), tr.vtt);
                }, true));
            }
        }

        return wrap.children.length > 0 ? wrap : null;
    }

    private createButton(label: string, onClick: () => void, isSecondary = false): HTMLElement {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `q-btn q-btn-item non-selectable no-outline q-btn--standard q-btn--rectangle q-btn--dense q-btn--actionable q-focusable q-hoverable asmr-transcript-btn${isSecondary ? ' asmr-transcript-btn--secondary' : ''}`;
        btn.title = label;
        btn.ariaLabel = label;

        const focus = document.createElement('span');
        focus.className = 'q-focus-helper';

        const content = document.createElement('span');
        content.className = 'q-btn__content text-center col items-center q-anchor--skip justify-center row';

        const icon = document.createElement('i');
        icon.setAttribute('aria-hidden', 'true');
        icon.setAttribute('role', 'img');
        icon.className = 'q-icon notranslate material-icons';
        icon.textContent = 'subtitles';

        const labelEl = document.createElement('span');
        labelEl.className = 'asmr-transcript-label';
        labelEl.textContent = label;

        content.appendChild(icon);
        content.appendChild(labelEl);
        btn.appendChild(focus);
        btn.appendChild(content);

        btn.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            onClick();
        });
        return btn;
    }

    private download(filename: string, content: string): void {
        try {
            const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            link.style.display = 'none';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (err) {
            Logger.error('[TranscriptFileInjector] Download failed:', err);
        }
    }
}
