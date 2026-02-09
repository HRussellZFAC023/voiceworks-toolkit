import { Logger, Config, I18n } from '../core/Utils';
import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { EventBus } from '../core/EventBus';
import { SharedCache, CacheKeys } from '../core/Cache';
import { getVueItem, getCleanText } from '../core/DomUtils';
import type { PlayerTrack, WhisperSegment } from '../types';

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

export class TranscriptFileInjector {
    private bridge: KikoeruBridge;
    private flatObserver: MutationObserver | null = null;
    private cleanups: (() => void)[] = [];

    constructor() {
        this.bridge = KikoeruBridge.getInstance();
    }

    public enable(): void {
        // Inject on fresh renders via worktree:enhanced (fired by WorkTreeManager after every Vue render)
        this.cleanups.push(EventBus.on('worktree:enhanced', (data: { workTree: HTMLElement }) => {
            const card = data.workTree.getElementsByClassName('q-card')[0];
            const listContainer = card?.children?.[0];
            if (listContainer) this.injectButtons(listContainer as Element, false);
        }));

        // Re-inject when whisper cache updates or transcription completes
        this.cleanups.push(EventBus.on('work:change', () => this.injectWorkTreeDirect()));
        this.cleanups.push(EventBus.on('whisper:cache-updated', () => this.injectWorkTreeDirect()));
        this.cleanups.push(EventBus.on('whisper:complete', () => this.injectWorkTreeDirect()));

        // Flat panel
        this.cleanups.push(EventBus.on('flatview:toggle', (data: { active: boolean }) => {
            if (data.active) {
                setTimeout(() => this.injectFlatPanel(), 400);
            } else {
                this.flatObserver?.disconnect();
                this.flatObserver = null;
            }
        }));

        this.injectWorkTreeDirect();
    }

    public disable(): void {
        this.cleanups.forEach(fn => fn());
        this.cleanups = [];
        this.flatObserver?.disconnect();
        this.flatObserver = null;
    }

    private getTranscriptIndex(): Record<string, TranscriptIndexEntry[]> {
        return SharedCache.get<Record<string, TranscriptIndexEntry[]>>(CacheKeys.whisperIndex()) || {};
    }

    private getLatestEntry(trackKey: string): TranscriptIndexEntry | null {
        const index = this.getTranscriptIndex();
        const list = index[trackKey];
        if (!list || list.length === 0) return null;
        return [...list].sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
    }

    private getTrackFromElement(el: Element, isFlatPanel: boolean): PlayerTrack | null {
        if (!isFlatPanel) {
            // Try Vue data binding first (works if item is passed as prop/attr)
            const data = getVueItem(el) as Record<string, unknown> | null;
            if (data?.type === 'audio') return data as unknown as PlayerTrack;

            // Fallback: look up item from host's fatherFolder by matching DOM index/title.
            return this.getTrackFromFatherFolder(el);
        }

        const hash = (el as HTMLElement).dataset.asmrFlatHash;
        if (!hash) return null;
        const store = this.bridge.store;
        const queue = store?.state?.AudioPlayer?.queue || store?.state?.AudioPlayer?.playlist || [];
        const track = queue.find((t: PlayerTrack) => t.hash === hash);
        if (track) return track;
        const labelEl = el.querySelector('.q-item__label');
        const title = labelEl ? getCleanText(labelEl) : '';
        return { hash, title } as PlayerTrack;
    }

    /**
     * Look up a track from the host WorkTree component's fatherFolder computed array.
     * Tries multiple strategies:
     * 1. data-asmr-hash attribute (set by ThumbnailManager on all items)
     * 2. DOM index matching against fatherFolder (both use index-based keys)
     * 3. Title text matching
     */
    private getTrackFromFatherFolder(el: Element): PlayerTrack | null {
        // Strategy 1: Use hash attribute set by ThumbnailManager
        const hash = (el as HTMLElement).dataset.asmrHash;
        if (hash) {
            const treeVm = this.bridge.findWorkTreeComponent() as any;
            const folder = treeVm?.fatherFolder;
            if (Array.isArray(folder)) {
                const match = folder.find((f: any) => f.hash === hash && f.type === 'audio');
                if (match) return match as unknown as PlayerTrack;
            }
        }

        const treeVm = this.bridge.findWorkTreeComponent() as any;
        if (!treeVm) return null;

        const folder = treeVm.fatherFolder;
        if (!Array.isArray(folder)) return null;

        // Strategy 2: DOM index matching (v-for uses :key="index")
        const parent = el.parentElement;
        if (parent) {
            const siblings = parent.querySelectorAll(':scope > [role="listitem"], :scope > .q-item');
            let idx = -1;
            for (let i = 0; i < siblings.length; i++) {
                if (siblings[i] === el) { idx = i; break; }
            }
            if (idx >= 0 && idx < folder.length) {
                const item = folder[idx];
                if (item?.type === 'audio') return item as unknown as PlayerTrack;
            }
        }

        // Strategy 3: match by title text
        const labelEl3 = el.querySelector('.q-item__label');
        const titleText = labelEl3 ? getCleanText(labelEl3) : '';
        if (titleText) {
            const match = folder.find((f: any) => f.type === 'audio' && f.title === titleText);
            if (match) return match as unknown as PlayerTrack;
        }

        return null;
    }

    private getTrackKey(track: PlayerTrack): string {
        return track.hash || track.mediaStreamUrl || track.src || track.title || '';
    }

    /** Inject buttons directly into the work tree (for non-event triggers like whisper completion) */
    private injectWorkTreeDirect(): void {
        const workTree = document.getElementById('work-tree');
        if (!workTree) return;

        const card = workTree.getElementsByClassName('q-card')[0];
        if (!card) return;

        const listContainer = card.children[0];
        if (!listContainer) return;

        this.injectButtons(listContainer as Element, false);
    }

    private injectFlatPanel(): void {
        const body = document.querySelector('.asmr-flat-panel__body');
        if (!body) return;

        this.injectButtons(body, true);
        this.flatObserver?.disconnect();
        this.flatObserver = new MutationObserver(() => {
            this.injectButtons(body, true);
        });
        this.flatObserver.observe(body, { childList: true, subtree: true });
    }

    private injectButtons(container: Element, isFlatPanel: boolean): void {
        const items = container.querySelectorAll('[role="listitem"]');
        items.forEach((li) => {
            if (li.querySelector('[data-asmr-transcript]')) return;
            // Defensive guard: if WorkTreeManager has marked this item's type, respect it.
            const itemType = (li as HTMLElement).dataset.itemType;
            if (itemType && itemType !== 'audio') return;
            const track = this.getTrackFromElement(li, isFlatPanel);
            if (!track) return;
            const trackKey = this.getTrackKey(track);
            if (!trackKey) return;
            const entry = this.getLatestEntry(trackKey);
            if (!entry) return;

            const buttonGroup = this.createButtonGroup(entry, track);
            if (!buttonGroup) return;
            const copyBtn = li.querySelector('[data-xxcopy]');
            if (copyBtn) {
                li.insertBefore(buttonGroup, copyBtn);
            } else {
                li.appendChild(buttonGroup);
            }
        });
    }

    private createButtonGroup(entry: TranscriptIndexEntry, track: PlayerTrack): HTMLElement | null {
        const cached = SharedCache.get<CachedTranscript>(entry.cacheKey);
        if (!cached || !cached.segments?.length) return null;
        // Don't show download buttons until transcription is complete
        if (!cached.complete) return null;

        const wrap = document.createElement('div');
        wrap.className = 'q-item__section column q-item__section--side justify-center asmr-transcript-actions';
        wrap.setAttribute('data-asmr-transcript', 'true');

        // LRC download — re-read cache at download time to get latest data
        const primaryLabel = I18n.t('whisperTranscriptDownload');
        wrap.appendChild(this.createDownloadButton(primaryLabel, () => {
            const fresh = SharedCache.get<CachedTranscript>(entry.cacheKey);
            const segs = fresh?.segments || cached.segments;
            const lrc = fresh?.lrc || this.buildLrcFromSegments(segs);
            if (!lrc) return;
            this.downloadTextFile(this.buildFileName(track, entry, (fresh || cached).language, 'lrc'), lrc);
        }));

        // VTT download (karaoke-style with word timestamps)
        const vttLabel = I18n.t('vttDownload');
        wrap.appendChild(this.createDownloadButton(vttLabel, () => {
            const fresh = SharedCache.get<CachedTranscript>(entry.cacheKey);
            const segs = fresh?.segments || cached.segments;
            const vtt = this.buildVttFromSegments(segs);
            if (vtt) this.downloadTextFile(this.buildFileName(track, entry, (fresh || cached).language, 'vtt'), vtt);
        }));

        const targetLang = ((Config.get('subtitleLang') as string | undefined) || '').toLowerCase();
        if (targetLang) {
            const translated = cached.translations?.[targetLang];
            if (translated?.lrc) {
                const translatedLabel = I18n.format('whisperTranscriptDownloadLang', { lang: targetLang.toUpperCase() });
                wrap.appendChild(this.createDownloadButton(translatedLabel, () => {
                    const fresh = SharedCache.get<CachedTranscript>(entry.cacheKey);
                    const tr = fresh?.translations?.[targetLang] || translated;
                    this.downloadTextFile(this.buildFileName(track, entry, targetLang, 'lrc'), tr.lrc);
                }, true));
            }

            if (translated?.vtt) {
                const translatedVttLabel = I18n.t('vttDownloadTranslated');
                wrap.appendChild(this.createDownloadButton(translatedVttLabel, () => {
                    const fresh = SharedCache.get<CachedTranscript>(entry.cacheKey);
                    const tr = fresh?.translations?.[targetLang] || translated;
                    if (tr.vtt) this.downloadTextFile(this.buildFileName(track, entry, targetLang, 'vtt'), tr.vtt);
                }, true));
            }
        }

        return wrap;
    }

    private createDownloadButton(label: string, onClick: () => void, isSecondary = false): HTMLElement {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `q-btn q-btn-item non-selectable no-outline q-btn--standard q-btn--rectangle q-btn--dense q-btn--actionable q-focusable q-hoverable asmr-transcript-btn${isSecondary ? ' asmr-transcript-btn--secondary' : ''}`;
        btn.title = label;
        btn.ariaLabel = label;
        btn.innerHTML = `
            <span class="q-focus-helper"></span>
            <span class="q-btn__content text-center col items-center q-anchor--skip justify-center row">
                <i aria-hidden="true" role="img" class="q-icon notranslate material-icons">subtitles</i>
                <span class="asmr-transcript-label">${label}</span>
            </span>
        `;
        btn.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            onClick();
        });
        return btn;
    }

    private buildLrcFromSegments(segments: WhisperSegment[]): string {
        if (!segments?.length) return '';
        return segments.map((seg) => `[${this.formatLrcTimestamp(seg.start)}]${seg.text}`).join('\n');
    }

    private formatLrcTimestamp(seconds: number): string {
        const safe = Math.max(0, seconds);
        const minutes = Math.floor(safe / 60);
        const secs = safe % 60;
        const mm = String(minutes).padStart(2, '0');
        const ss = String(Math.floor(secs)).padStart(2, '0');
        const xx = String(Math.floor((secs - Math.floor(secs)) * 100)).padStart(2, '0');
        return `${mm}:${ss}.${xx}`;
    }

    private buildFileName(track: PlayerTrack, entry: TranscriptIndexEntry, lang: string, ext = 'lrc'): string {
        const title = track.title || entry.trackTitle || 'transcript';
        const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_');
        const modelSuffix = entry.model?.split('/').pop() || 'whisper';
        return `${safeTitle}.${lang}.${modelSuffix}.${ext}`;
    }

    private buildVttFromSegments(segments: WhisperSegment[]): string {
        if (!segments?.length) return '';
        const lines = ['WEBVTT', ''];
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            const safeEnd = Math.max(seg.start + 0.01, seg.end);
            lines.push(`${i + 1}`);
            lines.push(`${this.formatVttTimestamp(seg.start)} --> ${this.formatVttTimestamp(safeEnd)}`);
            if (seg.words?.length) {
                const parts = seg.words.map(w => `<${this.formatVttTimestamp(w.start)}>${w.text}`);
                lines.push(parts.join(''));
            } else {
                lines.push(seg.text);
            }
            lines.push('');
        }
        return lines.join('\n');
    }

    private formatVttTimestamp(seconds: number): string {
        const safe = Math.max(0, seconds);
        const hours = Math.floor(safe / 3600);
        const minutes = Math.floor((safe % 3600) / 60);
        const secs = safe % 60;
        const hh = String(hours).padStart(2, '0');
        const mm = String(minutes).padStart(2, '0');
        const ss = String(Math.floor(secs)).padStart(2, '0');
        const mmm = String(Math.floor((secs - Math.floor(secs)) * 1000)).padStart(3, '0');
        return `${hh}:${mm}:${ss}.${mmm}`;
    }

    private downloadTextFile(filename: string, content: string): void {
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
