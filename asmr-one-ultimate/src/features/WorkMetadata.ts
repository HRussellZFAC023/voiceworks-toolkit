import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { DLsiteScraper, DLsiteMetadata } from './DLsiteScraper';

import { Logger, SafeUtils } from '../core/Utils';
import { CentralObserver } from '../core/CentralObserver';
import { CacheKeys, SharedCache } from '../core/Cache';
import { TranslationService } from '../services/TranslationService';
import { TranslatedTags } from './TranslatedTags';
import { I18n } from '../core/Config';
import { MediaViewer } from './MediaViewer';
import { EventBus } from '../core/EventBus';
import { AppStore } from '../store/AppStore';
import { isChinese } from '../core/DomUtils';
import { extractEmbeddedRjCode, extractPrimaryRjCode } from './rjCodeUtils';

/** Escape HTML special characters to prevent XSS */
function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export class WorkMetadata {
    private bridge: KikoeruBridge;
    private scraper: DLsiteScraper;
    private currentWorkId: string | null = null;
    private panel: HTMLElement | null = null;
    private processedWorkIds = new Set<string>();
    private titleTranslationEpoch = 0;

    constructor() {
        this.bridge = KikoeruBridge.getInstance();
        this.scraper = DLsiteScraper.getInstance();
    }

    public enable(): void {
        const app = this.bridge.app;
        if (app && typeof app.$watch === 'function') {
            app.$watch('$route', () => this.checkRoute());
        }
        this.checkRoute();

        // Register with central observer for re-renders that might kill our panel
        CentralObserver.register('WorkMetadata', () => {
            this.injectInDom();
            // Re-check if panel was lost by Vue re-render (only if we had one)
            if (this.currentWorkId && this.processedWorkIds.has(this.currentWorkId) && this.panel && !document.body.contains(this.panel)) {
                this.loadMetadata(this.currentWorkId);
            }
        }, 500);
    }

    private async checkRoute() {
        try {
            const route = this.bridge.router?.currentRoute;
            if (route && (route.name === 'work' || route.path?.startsWith('/work/'))) {
                const id = route.params?.id;
                if (id && id !== this.currentWorkId) {
                    this.titleTranslationEpoch++;
                    this.resetInjectedTitleElements();
                    this.currentWorkId = id;
                    this.loadMetadata(id);
                }
            } else {
                this.titleTranslationEpoch++;
                this.resetInjectedTitleElements();
                this.currentWorkId = null;
                this.removePanel();
            }
        } catch (e) {
            Logger.error('[WorkMetadata] checkRoute error:', e);
        }
    }

    private async loadMetadata(workId: string) {
        if (this.processedWorkIds.has(workId)) {
            // Already processed — but check if panel is still in DOM
            const panelAlive = this.panel && document.body.contains(this.panel);
            if (panelAlive) return;
            // Panel was lost (Vue re-render) — allow re-processing
            Logger.log(`[WorkMetadata] Re-processing ${workId} (panel lost)`);
            this.processedWorkIds.delete(workId);
        }

        this.removePanel();

        const work = await this.getPageWorkDetails(workId);
        if (!work) {
            Logger.warn('[WorkMetadata] Work details missing for', workId);
            return;
        }

        const rjCode = extractPrimaryRjCode({
            sourceId: work.source_id || work.sourceId,
            workId,
            title: work.title,
        }) ?? '';

        if (!rjCode) {
            Logger.log('[WorkMetadata] No RJ code found for work', workId);
            return;
        }

        // Prefer JP original RJ code for DLsite scraping (CN editions lack images/body)
        const jpRjCode = this.resolveJpRjCode(work, rjCode);
        const scrapeCode = jpRjCode || rjCode;
        if (jpRjCode && jpRjCode !== rjCode) {
            Logger.log(`[WorkMetadata] Resolved JP original: ${rjCode} → ${jpRjCode}`);
        }

        const fallback = this.buildFallbackMeta(work, rjCode);

        // Start title translation early (in parallel with DLsite scrape) — fire-and-forget
        const titleToTranslate = (work.title as string) || fallback?.title || '';
        if (titleToTranslate) this.translateTitle(titleToTranslate, workId);

        // Phase 0: Render fallback immediately for fast first paint
        if (fallback) {
            this.renderPanel(fallback, scrapeCode);
            this.processedWorkIds.add(workId);
        }

        try {
            Logger.log('[WorkMetadata] Fetching DLsite metadata for', scrapeCode);

            const onProgress = (partial: DLsiteMetadata) => {
                // Phase 1: Product API + Dynamic API arrived — re-render with enriched data
                if (this.currentWorkId !== workId) return; // navigated away
                partial.rjcode = rjCode;
                const merged = this.mergeMeta(partial, fallback);
                if (merged.title && merged.title !== titleToTranslate) {
                    this.translateTitle(merged.title, workId);
                }
                this.renderPanel(merged, scrapeCode);
            };

            const meta = await this.scraper.scrapeProgressive(scrapeCode, onProgress);
            if (this.currentWorkId !== workId) return; // navigated away during fetch

            // Phase 2: Full data with body — final render
            meta.rjcode = rjCode;
            const merged = this.mergeMeta(meta, fallback);

            if (merged.title && merged.title !== titleToTranslate) {
                this.translateTitle(merged.title, workId);
            }

            this.renderPanel(merged, scrapeCode);
            this.processedWorkIds.add(workId);
        } catch (e) {
            Logger.error('[WorkMetadata] Failed to load metadata', e);
            // Fallback already rendered in Phase 0, just ensure it's tracked
            if (fallback) this.processedWorkIds.add(workId);
        }
    }

    /** Check if translation mode is enabled in user config */
    private get shouldTranslate(): boolean {
        return !!AppStore.getConfig('translateMode');
    }

    private get cnToJpEnabled(): boolean {
        return !!AppStore.getConfig('translateCnToJp');
    }

    private async translateTitle(originalTitle: string, expectedWorkId: string) {
        const cnOnlyMode = !this.shouldTranslate && this.cnToJpEnabled;
        if (!originalTitle) return;

        const epoch = ++this.titleTranslationEpoch;
        const shouldSkipTranslation =
            (!this.shouldTranslate && !this.cnToJpEnabled) ||
            (cnOnlyMode && !isChinese(originalTitle)) ||
            (!cnOnlyMode && TranslationService.isUserLang(originalTitle));
        if (shouldSkipTranslation) {
            if (this.currentWorkId === expectedWorkId && epoch === this.titleTranslationEpoch) {
                this.resetInjectedTitleElements();
                EventBus.emit('title:update', { title: originalTitle });
            }
            return;
        }

        try {
            const translated = cnOnlyMode
                ? await TranslationService.translate(originalTitle, 'ja')
                : await TranslationService.translate(originalTitle);

            if (this.currentWorkId !== expectedWorkId || epoch !== this.titleTranslationEpoch) return;

            if (!translated || translated === originalTitle) {
                this.resetInjectedTitleElements();
                EventBus.emit('title:update', { title: originalTitle });
                return;
            }

            const h1 = await SafeUtils.waitForElement('h1.text-h6') as HTMLElement | null;
            if (!h1 || this.currentWorkId !== expectedWorkId || epoch !== this.titleTranslationEpoch) return;

            if (cnOnlyMode) {
                h1.parentElement?.querySelector('.asmr-original-title')?.remove();
                let transEl = h1.parentElement?.querySelector('.asmr-translated-title') as HTMLElement;
                if (!transEl) {
                    transEl = document.createElement('div');
                    transEl.className = 'text-h6 asmr-translated-title';
                    h1.parentElement?.insertBefore(transEl, h1.nextSibling);
                }
                transEl.textContent = translated;
                h1.style.display = 'none';
                EventBus.emit('title:update', { title: translated });
                return;
            }

            let originalSpan = h1.parentElement?.querySelector('.asmr-original-title') as HTMLElement;
            if (!originalSpan) {
                originalSpan = document.createElement('div');
                originalSpan.className = 'text-caption text-grey-5 q-mb-xs asmr-original-title';
                h1.parentElement?.insertBefore(originalSpan, h1);
            }
            originalSpan.textContent = originalTitle;

            let transEl = h1.parentElement?.querySelector('.asmr-translated-title') as HTMLElement;
            if (!transEl) {
                transEl = document.createElement('div');
                transEl.className = 'text-h6 asmr-translated-title';
                h1.parentElement?.insertBefore(transEl, h1.nextSibling);
            }
            transEl.textContent = translated;
            h1.style.display = 'none';
            EventBus.emit('title:update', { title: translated });
        } catch (e) {
            Logger.warn('[WorkMetadata] Title translation failed', e);
        }
    }

    private resetInjectedTitleElements(): void {
        document.querySelector('.asmr-original-title')?.remove();
        document.querySelector('.asmr-translated-title')?.remove();
        const h1 = document.querySelector('h1.text-h6') as HTMLElement | null;
        if (h1) h1.style.display = '';
    }
    private async getPageWorkDetails(id: string): Promise<Record<string, unknown> | null> {
        // Check Vuex store first (AudioPlayer work, then Works state)
        const storeWork = this.bridge.store?.state?.AudioPlayer?.work;
        if (storeWork && String(storeWork.id) === String(id)) return storeWork as unknown as Record<string, unknown>;

        const worksState = this.bridge.store?.state?.Works as (Record<string, unknown> | undefined);
        const cachedWork = (worksState?.work || worksState?.currentWork || worksState?.detail) as Record<string, unknown> | undefined;
        if (cachedWork && String(cachedWork.id) === String(id)) return cachedWork;

        // Fall back to host app's axios (same approach as CommentSection)
        try {
            const res = await this.bridge.axios.get<Record<string, unknown>>(`/api/work/${id}`);
            return res.data;
        } catch (e) {
            Logger.error('[WorkMetadata] API fetch failed for work', id, e);
            return null;
        }
    }

    private injectInDom() {
        if (!this.currentWorkId || !this.panel) return;
        if (document.body.contains(this.panel)) return;

        // Better injection strategy: target the info container specifically
        const selectors = [
            '.col-12.col-md-8.q-pa-sm.q-pt-md-md > .q-px-sm.q-py-none', // Exact path from user snippet
            '.work-info .q-px-sm.q-py-none',
            '.q-page .q-px-sm.q-py-none',
            'h1.text-h6'
        ];

        for (const selector of selectors) {
            const target = document.querySelector(selector);
            if (target && target.parentElement) {
                // If it's h1, we inject after it or its parent div
                const injectAfter = (target.tagName === 'H1') ? target : target;
                injectAfter.parentElement?.insertBefore(this.panel, injectAfter.nextSibling);
                return;
            }
        }
    }

    private removePanel() {
        if (this.panel) {
            this.panel.remove();
            this.panel = null;
        }
    }

    private renderPanel(meta: DLsiteMetadata, scrapeCode: string) {
        if (this.panel) this.removePanel();

        const p = document.createElement('div');
        p.className = 'asmr-metadata-panel q-mb-md q-mt-md';

        const content = document.createElement('div');
        content.className = 'asmr-meta-content';

        // === Top stats row: badge, price, rank, archives, refresh ===
        const statsRow = document.createElement('div');
        statsRow.className = 'asmr-meta-stats';

        const badge = document.createElement('span');
        badge.className = `asmr-meta-badge ${meta.age_category_string === 'R18' ? 'asmr-meta-badge--r18' : 'asmr-meta-badge--all'}`;
        badge.textContent = meta.age_category_string || 'R18';
        statsRow.appendChild(badge);

        if (meta.price) {
            const priceBlock = document.createElement('span');
            priceBlock.className = 'asmr-meta-price';
            if (meta.discount && meta.discount.rate > 0) {
                const discounted = Math.floor(meta.price * (100 - meta.discount.rate) / 100);
                priceBlock.innerHTML =
                    `<span class="asmr-meta-price-old">${meta.price}</span>` +
                    `<span class="asmr-meta-price-current">${discounted} JPY</span>` +
                    `<span class="asmr-meta-discount">-${meta.discount.rate}%</span>`;
            } else {
                priceBlock.innerHTML = `<span class="asmr-meta-price-current">${meta.price} JPY</span>`;
            }
            statsRow.appendChild(priceBlock);
        }

        if (meta.rank) {
            const r = meta.rank;
            const parts = [r.day ? `D${r.day}` : '', r.week ? `W${r.week}` : '', r.total ? `T${r.total}` : ''].filter(Boolean);
            if (parts.length) {
                const rankEl = document.createElement('span');
                rankEl.className = 'asmr-meta-stat';
                rankEl.innerHTML = `<i class="material-icons" style="font-size:14px;vertical-align:middle">leaderboard</i> ${parts.join('/')}`;
                statsRow.appendChild(rankEl);
            }
        }

        if (meta.dl_count) {
            const dlEl = document.createElement('span');
            dlEl.className = 'asmr-meta-stat';
            dlEl.innerHTML = `<i class="material-icons" style="font-size:14px;vertical-align:middle">archive</i> ${meta.dl_count}`;
            statsRow.appendChild(dlEl);
        }

        if (meta.rating_average > 0) {
            const ratingEl = document.createElement('span');
            ratingEl.className = 'asmr-meta-stat';
            ratingEl.innerHTML = `<i class="material-icons" style="font-size:14px;vertical-align:middle;color:#ffb300">star</i> ${meta.rating_average.toFixed(2)}`;
            statsRow.appendChild(ratingEl);
        }

        // Refresh button (far right via margin-left: auto)
        const refreshBtn = document.createElement('button');
        refreshBtn.type = 'button';
        refreshBtn.className = 'asmr-meta-refresh';
        refreshBtn.title = I18n.t('metaRefresh');
        refreshBtn.ariaLabel = I18n.t('metaRefresh');
        refreshBtn.innerHTML = '<i class="material-icons" style="font-size:16px" aria-hidden="true">refresh</i>';
        refreshBtn.addEventListener('click', () => {
            if (!this.currentWorkId) return;

            // Invalidate cache for the actual code used to scrape (e.g. JP original RJ code)
            const key = CacheKeys.dlsite(scrapeCode.toUpperCase());
            SharedCache.set(key, null as unknown as DLsiteMetadata, 0);

            // Also invalidate reviews cache just in case
            const reviewKey = CacheKeys.dlsiteReviews(scrapeCode.toUpperCase());
            SharedCache.set(reviewKey, null as unknown as Record<string, unknown>, 0);

            // Invalidate translations for visible metadata
            const textsToInvalidate = [
                meta.title,
                meta.description,
                meta.circle?.name,
                ...(meta.tags || []).map(t => t.name),
                ...(meta.cvs || []).map(c => c.name)
            ];
            textsToInvalidate.forEach(text => {
                if (text) SharedCache.set(CacheKeys.translation(text, 'en'), null as unknown as string, 0);
            });

            this.processedWorkIds.delete(this.currentWorkId);
            this.removePanel();
            this.titleTranslationEpoch++;
            this.resetInjectedTitleElements();
            this.loadMetadata(this.currentWorkId);
        });
        statsRow.appendChild(refreshBtn);

        content.appendChild(statsRow);

        // === Chips: circle, CVs, tags ===
        const chipRow = document.createElement('div');
        chipRow.className = 'asmr-meta-chips';

        const createChip = (label: string, variant: string, icon?: string) => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = `asmr-chip-tag asmr-chip-tag--${variant}`;
            chip.ariaLabel = label;
            chip.innerHTML = `${icon ? `<i class="material-icons asmr-chip-icon" aria-hidden="true">${icon}</i>` : ''}<span class="asmr-chip-label">${escapeHtml(label)}</span>`;
            chip.addEventListener('click', () => {
                window.open(`https://www.dlsite.com/maniax/fsr/=/keyword/${encodeURIComponent(label)}`, '_blank');
            });
            return chip;
        };


        if (meta.circle?.name) {
            const chip = createChip(meta.circle.name, 'circle', 'business');
            chipRow.appendChild(chip);
        }
        meta.cvs.forEach(cv => {
            const chip = createChip(cv.name, 'cv', 'record_voice_over');
            chipRow.appendChild(chip);
        });
        meta.tags.slice(0, 15).forEach(tag => {
            const chip = createChip(tag.name, 'tag');
            chipRow.appendChild(chip);
        });

        // Batch translate all added chips (only when translation mode or cnToJp is on)
        const batchTranslateChips = async () => {
            const cnOnlyMode = !this.shouldTranslate && this.cnToJpEnabled;
            if (!this.shouldTranslate && !this.cnToJpEnabled) return;
            const chips = Array.from(chipRow.querySelectorAll('.asmr-chip-tag')) as HTMLElement[];
            const labelsTranslate: { el: HTMLElement, text: string, id?: number }[] = [];

            chips.forEach(chip => {
                const labelEl = chip.querySelector('.asmr-chip-label') as HTMLElement;
                const text = labelEl?.textContent?.trim() || '';
                if (!text || !/[\u3040-\u30ff\u4e00-\u9faf]/.test(text)) return;
                if (cnOnlyMode && !isChinese(text)) return;

                // Try tag pre-translation first (skip in CN-only mode — we want JP, not EN)
                if (!cnOnlyMode) {
                    const tagIdAttr = chip.getAttribute('data-tag-id');
                    const tagId = tagIdAttr ? parseInt(tagIdAttr, 10) : undefined;
                    if (tagId) {
                        const tagList = TranslatedTags.getInstance().getTagList();
                        const match = tagList.find(t => t.id === tagId || t.ja === text);
                        if (match?.en && match.en !== match.ja) {
                            labelEl.textContent = TranslationService.formatPair(match.ja || text, match.en);
                            chip.title = text;
                            return;
                        }
                    }
                }

                labelsTranslate.push({ el: labelEl, text });
            });

            if (labelsTranslate.length === 0) return;

            const targetLang = cnOnlyMode ? 'ja' : 'en';
            const results = await TranslationService.translateBatch(labelsTranslate.map(l => l.text), targetLang);
            results.forEach((translated, i) => {
                const item = labelsTranslate[i];
                if (translated && translated !== item.text && item.el.isConnected) {
                    if (cnOnlyMode) {
                        // CN→JP: silently replace
                        item.el.textContent = translated;
                    } else {
                        item.el.textContent = TranslationService.formatPair(item.text, translated);
                        (item.el.parentElement as HTMLElement).title = item.text;
                    }
                }
            });
        };
        batchTranslateChips();

        content.appendChild(chipRow);

        // === Brief description (above the fold) ===
        if (meta.description) {
            const descSection = document.createElement('div');
            descSection.className = 'asmr-meta-description';

            const descEl = document.createElement('div');
            descEl.className = 'asmr-meta-description-cell asmr-meta-description-cell--original';
            descEl.textContent = meta.description;
            descSection.appendChild(descEl);

            if (this.shouldTranslate) {
                TranslationService.translate(meta.description).then(translated => {
                    if (translated && translated !== meta.description) {
                        const transEl = document.createElement('div');
                        transEl.className = 'asmr-meta-description-cell asmr-meta-description-cell--translated';
                        transEl.textContent = translated;
                        descSection.appendChild(transEl);
                    }
                });
            } else if (this.cnToJpEnabled && isChinese(meta.description)) {
                // CN→JP: replace original text inline
                TranslationService.translate(meta.description, 'ja').then(translated => {
                    if (translated && translated !== meta.description) {
                        descEl.textContent = translated;
                    }
                });
            }

            content.appendChild(descSection);
        }

        // === Expandable DLsite Details ===
        const detailsContainer = document.createElement('div');
        detailsContainer.className = 'asmr-meta-details-container';

        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'asmr-meta-toggle';
        toggleBtn.ariaExpanded = 'false';
        const updateToggle = (expanded: boolean) => {
            const label = expanded ? I18n.t('metaHideDetails') : I18n.t('metaShowDetails');
            toggleBtn.ariaExpanded = String(expanded);
            toggleBtn.ariaLabel = label;
            toggleBtn.innerHTML = `<span>${escapeHtml(label)}</span><i class="material-icons" aria-hidden="true">${expanded ? 'expand_less' : 'expand_more'}</i>`;
        };
        updateToggle(false);

        const detailsBody = document.createElement('div');
        detailsBody.className = 'asmr-meta-details';
        detailsBody.style.display = 'none';

        toggleBtn.addEventListener('click', () => {
            const expanding = detailsBody.style.display === 'none';
            detailsBody.style.display = expanding ? 'block' : 'none';
            updateToggle(expanding);
        });

        // -- Sample images gallery (inside details) --
        if (meta.image_samples?.length) {
            const gallery = document.createElement('div');
            gallery.className = 'asmr-meta-gallery';
            const allUrls = meta.image_samples;
            allUrls.forEach((url, idx) => {
                const imgWrap = document.createElement('div');
                imgWrap.className = 'asmr-meta-gallery-item';
                const img = document.createElement('img');
                img.src = url;
                img.loading = 'lazy';
                img.alt = 'Sample';
                img.referrerPolicy = 'no-referrer';

                let retryCount = 0;
                const maxRetries = 3;
                img.onerror = () => {
                    retryCount++;
                    if (retryCount <= maxRetries) {
                        const delay = Math.pow(2, retryCount - 1) * 1000;
                        Logger.debug(`[WorkMetadata] Sample image retry ${retryCount}/${maxRetries} in ${delay}ms`);
                        setTimeout(() => {
                            if (img.isConnected) {
                                const separator = url.includes('?') ? '&' : '?';
                                img.src = `${url}${separator}_r=${retryCount}`;
                            }
                        }, delay);
                    }
                };

                img.addEventListener('click', () => {
                    try {
                        MediaViewer.getInstance().showExternalImages(allUrls, idx);
                    } catch {
                        window.open(url, '_blank');
                    }
                });
                imgWrap.appendChild(img);
                gallery.appendChild(imgWrap);
            });
            detailsBody.appendChild(gallery);
        }

        // -- Full body content (deduplicated, sanitized, paragraph-aligned side-by-side) --
        const bodyText = meta.body || meta.intro || meta.summary || '';
        if (bodyText) {
            // Deduplicate: strip body's leading text that matches description
            let processedBody = bodyText;
            if (meta.description && processedBody.startsWith(meta.description)) {
                processedBody = processedBody.slice(meta.description.length).replace(/^[\s\n]+/, '');
            }

            // Aggressive sanitization + markdown-to-HTML conversion
            processedBody = this.sanitizeBody(processedBody);

            if (processedBody.length > 20) {
                const bodySection = document.createElement('div');
                bodySection.className = 'asmr-meta-body-section';

                // Split into paragraphs for aligned rendering
                const paragraphs = processedBody
                    .split(/\n\n+/)
                    .map(p => p.trim())
                    .filter(p => p.length > 0);

                // Build a table-like grid: each row = [original | translated]
                const grid = document.createElement('div');
                grid.className = 'asmr-meta-body-grid';

                const shouldTranslate = this.shouldTranslate;
                const cnToJp = this.cnToJpEnabled;
                const transCells: { el: HTMLElement, text: string }[] = [];
                const cnReplaceCells: { el: HTMLElement, text: string }[] = [];

                paragraphs.forEach(para => {
                    const row = document.createElement('div');
                    row.className = 'asmr-meta-body-row';

                    const origCell = document.createElement('div');
                    origCell.className = 'asmr-meta-body-cell asmr-meta-body-cell--original';
                    origCell.innerHTML = para.replace(/\n/g, '<br>');
                    row.appendChild(origCell);

                    const plainText = origCell.textContent || '';

                    if (shouldTranslate) {
                        const transCell = document.createElement('div');
                        transCell.className = 'asmr-meta-body-cell asmr-meta-body-cell--translated';
                        transCell.textContent = '...';
                        row.appendChild(transCell);

                        if (plainText.length > 0) {
                            transCells.push({ el: transCell, text: plainText });
                        }
                    }

                    // CN→JP: collect CN paragraphs for inline replacement
                    if (cnToJp && plainText.length > 0 && isChinese(plainText)) {
                        cnReplaceCells.push({ el: origCell, text: plainText });
                    }

                    grid.appendChild(row);
                });

                // Batch translate all paragraphs
                if (transCells.length > 0) {
                    TranslationService.translateBatch(transCells.map(c => c.text)).then(results => {
                        results.forEach((translated, i) => {
                            const cell = transCells[i];
                            if (translated && translated !== cell.text) {
                                cell.el.textContent = translated;
                            } else {
                                cell.el.textContent = '';
                            }
                        });
                    }).catch(() => {
                        transCells.forEach(c => c.el.textContent = '');
                    });
                }

                // CN→JP: translate Chinese paragraphs to Japanese and replace inline
                if (cnReplaceCells.length > 0) {
                    TranslationService.translateBatch(cnReplaceCells.map(c => c.text), 'ja').then(results => {
                        results.forEach((translated, i) => {
                            const cell = cnReplaceCells[i];
                            if (translated && translated !== cell.text) {
                                cell.el.textContent = translated;
                            }
                        });
                    }).catch(() => { /* silent */ });
                }

                bodySection.appendChild(grid);
                detailsBody.appendChild(bodySection);
            }
        }

        // -- File contents --
        if (meta.contents?.length) {
            const fileSection = document.createElement('div');
            fileSection.className = 'asmr-meta-files';
            const header = document.createElement('div');
            header.className = 'asmr-meta-section-label';
            header.innerHTML = `<i class="material-icons" style="font-size:16px;vertical-align:middle">folder</i> ${escapeHtml(I18n.format('metaFileContents', { count: String(meta.contents.length) }))}`;
            fileSection.appendChild(header);

            const scroll = document.createElement('div');
            scroll.className = 'asmr-meta-file-scroll';
            meta.contents.forEach(f => {
                const row = document.createElement('div');
                row.className = 'asmr-meta-file-row';
                row.innerHTML = `<span class="asmr-meta-file-name">${escapeHtml(f.file_name)}</span><span class="asmr-meta-file-size">${escapeHtml(f.file_size)}</span>`;
                scroll.appendChild(row);
            });
            fileSection.appendChild(scroll);
            detailsBody.appendChild(fileSection);
        }

        detailsContainer.appendChild(toggleBtn);
        detailsContainer.appendChild(detailsBody);
        content.appendChild(detailsContainer);

        p.appendChild(content);
        this.panel = p;
        this.injectInDom();
    }

    /**
     * Aggressively sanitize body text from DLsite HTML or Jina Reader markdown.
     * Strips page chrome, navigation, tracking, and converts markdown to HTML.
     */
    private sanitizeBody(body: string): string {
        let s = body;

        // === 1. Truncate at page-chrome boundaries (first pass, before any other processing) ===
        const stopMarkers = [
            'Select Language',
            'この作品を買った人',
            '最近チェックした作品',
            '関連サービス',
            'DLsiteについて',
            'ヘルプ&ガイド',
            'お支払い&ポイント',
            '推奨環境',
            '© 1996 DLsite',
            '成人向け入室確認',
            'SORRY...',
            '同人誌・同人ゲーム・同人ボイス',
            '言語と通貨を設定',
            '全年齢向けへ',
            '女性向け',
        ];
        for (const marker of stopMarkers) {
            const idx = s.indexOf(marker);
            if (idx !== -1) {
                s = s.substring(0, idx);
            }
        }

        // === 2. Strip dangerous HTML tags ===
        s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
        s = s.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
        s = s.replace(/<object[\s\S]*?<\/object>/gi, '');
        s = s.replace(/<style[\s\S]*?<\/style>/gi, '');

        // === 3. Strip tracking/banner images (HTML and markdown) ===
        s = s.replace(/<img[^>]*src="[^"]*(?:analytics|octopuspop|adsct|twitter|doubleclick|facebook|banner|modpub|logo|payment|recruit)[^"]*"[^>]*\/?>/gi, '');
        s = s.replace(/!\[Image \d+[^\]]*\]\([^)]*\)/g, '');
        s = s.replace(/!\[[^\]]*\]\([^)]*(?:banner|modpub|logo|payment|recruit|octopuspop|analytics|adsct)[^)]*\)/gi, '');

        // === 4. Strip non-product DLsite navigation markdown links and external service links ===
        s = s.replace(/\*?\s*\[([^\]]*)\]\(https?:\/\/(?:www\.nijiyome|ci-en|ch\.dlsite|chobit|triokini|play\.dlsite|hire\.wantedly|www\.eisys|www\.geonet|cs\.dlsite|min-hon|www\.youtube|x\.com|t\.co|analytics\.twitter)[^)]*\)/gi, '');
        // Strip DLsite registration/login/non-product links
        s = s.replace(/\*?\s*\[([^\]]*)\]\(https?:\/\/www\.dlsite\.com\/(?:maniax|home)\/(?:regist|login|mypage|guide|rule|faq|inquiry)[^)]*\)/gi, '');
        // Strip empty-text markdown links [](url) — these are navigation chrome artifacts
        s = s.replace(/\*?\s*\[\s*\]\([^)]*\)/g, '');

        // === 5. Convert remaining markdown to HTML ===
        // Images: ![alt](url) → <img>
        s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;border-radius:4px">');
        // Links: [text](url) → <a>
        s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
        // Headers: ### text or text\n=== → stripped to just bold text
        s = s.replace(/^#{1,6}\s+(.+)$/gm, '<strong>$1</strong>');
        s = s.replace(/^(.+)\n={3,}$/gm, '<strong>$1</strong>');
        // Bold: **text** or __text__
        s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
        // Italic: *text* or _text_ (single)
        s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');

        // === 6. Linkify bare URLs not already inside <a> tags or markdown links ===
        s = s.replace(/(^|[^("'])(https?:\/\/[^\s<>"')\]]+)/gm, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');

        // === 7. Replace TeX-style quotes with double quotes (common in translated Japanese reviews) ===
        s = s.replace(/``/g, '"');
        s = s.replace(/''/g, '"');

        // === 8. Clean up remaining markdown artifacts ===
        s = s.replace(/^\*\s*$/gm, '');                    // Empty bullets
        s = s.replace(/^\*\s+非表示にする\s*$/gm, '');     // "Hide" buttons
        s = s.replace(/^---+$/gm, '');                      // Horizontal rules
        s = s.replace(/^={3,}$/gm, '');                     // Stray === underlines

        // === 8. Final cleanup ===
        s = s.replace(/\n{3,}/g, '\n\n');
        s = s.trim();

        // If after all sanitization we still have navigation-like content, reject it
        if (s.length < 30) return '';
        // Check if most of the remaining text is URLs or link syntax
        const urlRatio = (s.match(/https?:\/\//g) || []).length / Math.max(1, s.split('\n').length);
        if (urlRatio > 0.5) return '';  // More than half the lines are URLs — it's page chrome

        return s;
    }

    private mergeMeta(primary: DLsiteMetadata, fallback: DLsiteMetadata | null): DLsiteMetadata {
        if (!fallback) return primary;
        const merged = { ...primary };
        if (!merged.title) merged.title = fallback.title;
        if (!merged.circle?.name && fallback.circle?.name) merged.circle = fallback.circle;
        if (merged.tags.length === 0 && fallback.tags.length) merged.tags = fallback.tags;
        if (merged.cvs.length === 0 && fallback.cvs.length) merged.cvs = fallback.cvs;
        if (!merged.release && fallback.release) merged.release = fallback.release;
        if (!merged.rating_average && fallback.rating_average) merged.rating_average = fallback.rating_average;
        if (!merged.price && fallback.price) merged.price = fallback.price;
        if (!merged.age_category_string && fallback.age_category_string) merged.age_category_string = fallback.age_category_string;
        return merged;
    }

    /**
     * Resolve the JP original RJ code from API work data.
     * CN/translated editions lack images and body — the JP original has them.
     */
    private resolveJpRjCode(work: Record<string, unknown>, currentCode: string): string | null {
        // 1. Direct original_workno field
        const origWorkno = work.original_workno;
        if (origWorkno && typeof origWorkno === 'string') {
            const code = extractEmbeddedRjCode(origWorkno);
            if (code) return code;
        }

        // 2. translation_info.original_workno or parent_workno
        const ti = work.translation_info as Record<string, unknown> | undefined;
        if (ti) {
            const orig = (ti.original_workno || ti.parent_workno) as string | undefined;
            if (orig && typeof orig === 'string') {
                const code = extractEmbeddedRjCode(orig);
                if (code) return code;
            }
        }

        // 3. language_editions — find the JPN edition
        const editions = work.language_editions;
        if (Array.isArray(editions)) {
            const jpn = (editions as Array<Record<string, unknown>>).find((e) => e.lang === 'JPN' || e.lang === 'jpn');
            if (jpn?.workno) {
                const code = extractEmbeddedRjCode(jpn.workno);
                if (code && code !== currentCode) return code;
            }
        }

        return null;
    }

    private buildFallbackMeta(work: Record<string, unknown>, rjCode: string): DLsiteMetadata | null {
        if (!work) return null;
        const circle = work.circle as Record<string, unknown> | undefined;
        const circleName = (circle?.name || work.circle_name || work.maker_name || work.circleName || '') as string;
        const circleId = Number(circle?.id || work.circle_id || work.maker_id || 0) || 0;
        const rawTags = (work.tags || work.genres || work.tags_replaced || []) as Array<Record<string, unknown>>;
        const tags = rawTags.map((t) => ({
            id: Number(t.id || t.tag_id || 0) || 0,
            name: (t.name || t.title || '') as string
        })).filter((t) => t.name);
        const rawCvs = (work.vas || work.voice_actors || work.voiceActors || work.cvs || []) as Array<Record<string, unknown>>;
        const cvs = rawCvs.map((c) => ({
            name: (c.name || c.title || '') as string
        })).filter((c) => c.name);

        const age = Number(work.age_category || work.age || 0) || 0;
        const ageString = age >= 3 ? 'R18' : age === 2 ? 'R15' : 'ALL';
        const release = (work.release_date || work.release || work.release_at || work.regist_date || '').toString().slice(0, 10);
        const rating = Number(work.rate || work.rating_average || work.rate_average_2dp || 0) || 0;
        const price = Number(work.price || 0) || 0;

        return {
            rjcode: rjCode,
            title: (work.title as string) || (work.name as string) || rjCode,
            nsfw: age >= 2 || !!work.nsfw,
            release,
            tags,
            cvs,
            rating_average: rating,
            price,
            age_category_string: ageString,
            circle: circleName ? { id: circleId, name: circleName } : undefined
        };
    }
}
