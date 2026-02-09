import { Logger } from '../../core/Utils';
import { getCleanText } from '../../core/DomUtils';
import { WorkService } from '../../services/WorkService';
import type { TrackFolder, TrackItem } from '../../types/api';
import type { MediaFile, WorkTreeComponent } from './types';

export interface ThumbnailManagerDeps {
    getModal: () => HTMLElement | null;
    findWorkTreeElement: () => HTMLElement | null;
    findWorkTreeComponent: () => WorkTreeComponent | null;
    getWorkIdFromUrl: () => string | null;
    flattenTracksResponse: (tracks: Array<TrackFolder | TrackItem>) => MediaFile[];
    getWorkTreeTree: () => Array<TrackFolder | TrackItem> | null;
    getFileExtension: (fileName: string) => string;
    isImage: (ext: string) => boolean;
    isVideo: (ext: string) => boolean;
    getMediaUrl: (hash: string, fileData: MediaFile) => string;
    thumbnailCache: Map<string, string>;
}

export class ThumbnailManager {
    private deps: ThumbnailManagerDeps;

    constructor(deps: ThumbnailManagerDeps) {
        this.deps = deps;
    }

    clearStaleThumbnails(): void {
        const workTreeEl = this.deps.findWorkTreeElement();
        if (!workTreeEl) return;

        const thumbContainers = workTreeEl.querySelectorAll('.media-thumb-container');
        thumbContainers.forEach(container => {
            const iconSection = container.parentElement;
            container.remove();
            // Restore the original icon
            const hiddenIcon = iconSection?.querySelector('.q-icon.hidden');
            if (hiddenIcon) {
                hiddenIcon.classList.remove('hidden');
            }
        });
    }

    async injectThumbnails(): Promise<void> {
        const workTreeEl = this.deps.findWorkTreeElement();
        if (!workTreeEl) return;

        const modal = this.deps.getModal();
        if (modal?.classList.contains('active')) return;

        this.clearStaleThumbnails();

        const workTree = this.deps.findWorkTreeComponent();
        let fatherFolder = workTree?.fatherFolder || [];

        // Fallback: fetch from API if fatherFolder is empty
        if (fatherFolder.length === 0) {
            const workId = this.deps.getWorkIdFromUrl();
            if (workId) {
                try {
                    const tracks = await WorkService.getTracks(workId);
                    if (Array.isArray(tracks)) {
                        fatherFolder = this.deps.flattenTracksResponse(tracks);
                        Logger.debug(`[MediaViewer] Thumbnails: fetched ${fatherFolder.length} tracks from API`);
                    } else {
                        Logger.warn('[MediaViewer] Thumbnails: tracks is not an array:', typeof tracks);
                    }
                } catch (err) {
                    Logger.warn('[MediaViewer] Thumbnails: failed to fetch tracks', err);
                }
            }
        }
        if (fatherFolder.length === 0) {
            const tree = this.deps.getWorkTreeTree();
            if (tree?.length) {
                fatherFolder = this.deps.flattenTracksResponse(tree);
                Logger.debug(`[MediaViewer] Thumbnails: flattened ${fatherFolder.length} tracks from WorkTree.tree`);
            }
        }

        // Create a map of titles to file data for faster lookup
        const fileMap = new Map<string, MediaFile>();
        fatherFolder.forEach((f: MediaFile) => {
            fileMap.set(f.title, f);
            // Also map without extension for flexibility
            const baseName = f.title.replace(/\.[^.]+$/, '');
            fileMap.set(baseName, f);
        });

        Logger.debug(`[MediaViewer] Thumbnails: fileMap has ${fileMap.size} entries from ${fatherFolder.length} items`);

        const items = workTreeEl.querySelectorAll('.q-item');
        items.forEach((item) => {
            const labelEl = item.querySelector('.q-item__section--main');
            const iconSection = item.querySelector('.q-item__section--avatar');
            if (!labelEl || !iconSection) return;

            // Get the raw title text - prefer .q-item__label if present (folders have nested labels)
            const labelDirect = item.querySelector('.q-item__label');
            const labelTarget = labelDirect || labelEl;
            let title = '';

            title = getCleanText(labelTarget);

            // Collapse internal whitespace (from HTML formatting)
            title = title.replace(/\s+/g, ' ');

            // Strip translation suffix from CSS ::after pseudo-element won't affect textContent,
            // but strip English translation suffix if present: "file.jpg (Translation)"
            const translationMatch = title.match(/^(.+?)\s*\([^)]+\)$/);
            if (translationMatch) {
                title = translationMatch[1].trim();
            }

            // Look up file data
            let fileData = fileMap.get(title);
            if (!fileData) {
                // Try partial matching
                for (const [key, value] of fileMap.entries()) {
                    if (title.includes(key) || key.includes(title)) {
                        fileData = value;
                        break;
                    }
                }
            }

            if (!fileData?.hash) return;

            // Stash the hash on ALL items (not just images) for cross-feature use
            // (e.g., TranscriptFileInjector needs hashes on audio items)
            (item as HTMLElement).dataset.asmrHash = fileData.hash;

            // Skip thumbnail injection if already has one
            if (iconSection.querySelector('.media-thumb-container')) return;

            const ext = this.deps.getFileExtension(title);
            if (this.deps.isImage(ext)) {
                const thumbUrl = this.deps.getMediaUrl(fileData.hash, fileData);
                this.createThumbnail(iconSection as HTMLElement, thumbUrl, fileData.hash);
            }
        });
    }

    private createThumbnail(iconSection: HTMLElement, url: string, hash: string): void {
        // Hide existing icon
        const existingIcon = iconSection.querySelector('.q-icon');
        if (existingIcon) {
            existingIcon.classList.add('hidden');
        }

        // Create thumbnail container
        const thumbContainer = document.createElement('div');
        thumbContainer.className = 'media-thumb-container';

        // Create loading placeholder
        const placeholder = document.createElement('div');
        placeholder.className = 'media-thumb-loading';
        placeholder.innerHTML = '<span class="material-icons">hourglass_empty</span>';
        thumbContainer.appendChild(placeholder);

        // Create image
        const thumb = document.createElement('img');
        thumb.className = 'media-thumb';
        thumb.alt = 'Thumbnail';
        thumb.loading = 'lazy';

        thumb.onload = () => {
            placeholder.remove();
            thumb.classList.add('loaded');
            // Cache the URL for this hash
            this.deps.thumbnailCache.set(hash, url);
        };

        let retryCount = 0;
        const maxRetries = 3;
        thumb.onerror = () => {
            retryCount++;
            if (retryCount <= maxRetries) {
                const delay = retryCount * 1000; // 1s, 2s, 3s backoff
                Logger.debug(`[MediaViewer] Thumbnail retry ${retryCount}/${maxRetries} for ${hash} in ${delay}ms`);
                setTimeout(() => {
                    // Append cache-bust param to force re-fetch
                    const separator = url.includes('?') ? '&' : '?';
                    thumb.src = `${url}${separator}_r=${retryCount}`;
                }, delay);
            } else {
                Logger.debug(`[MediaViewer] Thumbnail failed after ${maxRetries} retries: ${hash}`);
                thumbContainer.remove();
                if (existingIcon) {
                    existingIcon.classList.remove('hidden');
                }
            }
        };

        // Use cached thumbnail or load new one
        if (this.deps.thumbnailCache.has(hash)) {
            thumb.src = this.deps.thumbnailCache.get(hash)!;
            placeholder.remove();
        } else {
            thumb.src = url;
        }

        thumbContainer.appendChild(thumb);
        iconSection.appendChild(thumbContainer);
    }

}
