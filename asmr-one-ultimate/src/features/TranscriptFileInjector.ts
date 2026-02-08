import { Logger, Config, I18n } from '../core/Utils';
import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { CentralObserver } from '../core/CentralObserver';
import { EventBus } from '../core/EventBus';
import { SharedCache, CacheKeys } from '../core/Cache';
import { getVueItem } from '../core/DomUtils';
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
    private observer: MutationObserver | null = null;
    private flatObserver: MutationObserver | null = null;
    private cleanups: (() => void)[] = [];

    constructor() {
        this.bridge = KikoeruBridge.getInstance();
    }

    public enable(): void {
        CentralObserver.register('TranscriptFileInjector', () => this.injectWorkTree(), 800);

        this.cleanups.push(EventBus.on('work:change', () => this.injectWorkTree()));
        this.cleanups.push(EventBus.on('whisper:cache-updated', () => this.injectWorkTree()));
        this.cleanups.push(EventBus.on('whisper:complete', () => this.injectWorkTree()));
        this.cleanups.push(EventBus.on('flatview:toggle', (data: { active: boolean }) => {
            if (data.active) {
                setTimeout(() => this.injectFlatPanel(), 400);
            } else {
                this.flatObserver?.disconnect();
                this.flatObserver = null;
            }
        }));

        this.injectWorkTree();
    }

    public disable(): void {
        this.cleanups.forEach(fn => fn());
        this.cleanups = [];
        CentralObserver.unregister('TranscriptFileInjector');
        this.observer?.disconnect();
        this.observer = null;
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
            const data = getVueItem(el) as Record<string, unknown> | null;
            if (data?.type === 'audio') return data as unknown as PlayerTrack;
            return null;
        }

        const hash = (el as HTMLElement).dataset.asmrFlatHash;
        if (!hash) return null;
        const store = this.bridge.store;
        const queue = store?.state?.AudioPlayer?.queue || store?.state?.AudioPlayer?.playlist || [];
        const track = queue.find((t: PlayerTrack) => t.hash === hash);
        if (track) return track;
        const title = el.querySelector('.q-item__label')?.textContent?.trim() || '';
        return { hash, title } as PlayerTrack;
    }

    private getTrackKey(track: PlayerTrack): string {
        return track.hash || track.mediaStreamUrl || track.src || track.title || '';
    }

    private injectWorkTree(): void {
        const workTree = document.getElementById('work-tree');
        if (!workTree) return;

        const card = workTree.getElementsByClassName('q-card')[0];
        if (!card) return;

        const listContainer = card.children[0];
        if (!listContainer) return;

        this.injectButtons(listContainer as Element, false);

        if (this.observer) this.observer.disconnect();
        this.observer = new MutationObserver(() => {
            this.injectButtons(listContainer as Element, false);
        });
        this.observer.observe(listContainer, { childList: true, subtree: true });
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
            const track = this.getTrackFromElement(li, isFlatPanel);
            if (!track) return;
            const trackKey = this.getTrackKey(track);
            if (!trackKey) return;
            const entry = this.getLatestEntry(trackKey);
            if (!entry) return;

            const buttonGroup = this.createButtonGroup(entry, track);
            if (buttonGroup) li.appendChild(buttonGroup);
        });
    }

    private createButtonGroup(entry: TranscriptIndexEntry, track: PlayerTrack): HTMLElement | null {
        const cached = SharedCache.get<CachedTranscript>(entry.cacheKey);
        if (!cached || !cached.segments?.length) return null;

        const wrap = document.createElement('div');
        wrap.className = 'q-item__section column q-item__section--side justify-center asmr-transcript-actions';
        wrap.setAttribute('data-asmr-transcript', 'true');

        // LRC download
        const primaryLabel = I18n.t('whisperTranscriptDownload');
        wrap.appendChild(this.createDownloadButton(primaryLabel, () => {
            const lrc = cached.lrc || this.buildLrcFromSegments(cached.segments);
            if (!lrc) return;
            this.downloadTextFile(this.buildFileName(track, entry, cached.language, 'lrc'), lrc);
        }));

        // VTT download (karaoke-style with word timestamps)
        const vttLabel = I18n.t('vttDownload');
        wrap.appendChild(this.createDownloadButton(vttLabel, () => {
            // Re-read cache at download time to get latest segments
            const fresh = SharedCache.get<CachedTranscript>(entry.cacheKey);
            const segs = fresh?.segments || cached.segments;
            const vtt = this.buildVttFromSegments(segs);
            if (vtt) this.downloadTextFile(this.buildFileName(track, entry, cached.language, 'vtt'), vtt);
        }));

        const targetLang = ((Config.get('subtitleLang') as string | undefined) || '').toLowerCase();
        const translated = targetLang ? cached.translations?.[targetLang] : undefined;
        if (translated?.lrc) {
            const translatedLabel = I18n.format('whisperTranscriptDownloadLang', { lang: targetLang.toUpperCase() });
            wrap.appendChild(this.createDownloadButton(translatedLabel, () => {
                this.downloadTextFile(this.buildFileName(track, entry, targetLang, 'lrc'), translated.lrc);
            }, true));
        }

        // Translated VTT download
        if (translated?.vtt) {
            const translatedVttLabel = I18n.t('vttDownloadTranslated');
            wrap.appendChild(this.createDownloadButton(translatedVttLabel, () => {
                this.downloadTextFile(this.buildFileName(track, entry, targetLang, 'vtt'), translated.vtt!);
            }, true));
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
            const safeEnd = Math.max(seg.start + 0.01, seg.end); // Prevent zero-duration cues
            lines.push(`${i + 1}`); // Cue index for spec compliance
            lines.push(`${this.formatVttTimestamp(seg.start)} --> ${this.formatVttTimestamp(safeEnd)}`);
            // Karaoke-style: embed word-level timestamps for progressive display
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
