/**
 * FolderDiver - Automatic folder navigation for works with nested directories
 *
 * Works alongside ASMR.one's built-in folder diver:
 * - Host app has its own folder diver that runs first
 * - We only intervene if the host's diver landed in a folder with NO direct audio files
 * - Can continue diving from a given path (not just from root)
 *
 * Uses folder scoring to select the most relevant content folder.
 * Navigation uses DOM click simulation for reliable Vue 2 reactivity.
 */

import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { Logger } from '../core/Logger';
import { calculateFolderScore } from '../core/WorkUtils';
import { LIMITS, SCORING } from '../core/Constants';
import { Config } from '../core/Config';
import type { TrackFolder, TrackItem, TracksResponse, WorkDetail, WorkFolder } from '../types/api';
import type { WorkTreeComponent } from '../types/store';
import { findFolderBySegment, hasDirectPlayableMedia, resolveNodesAtPath } from './folderDiverTreeUtils';
import {
    findBestFolderItem,
    getActiveBreadcrumbTitle,
    getActiveFolderItemTitle,
    getFolderItemLabel,
    isExactOrPrefixMatch,
} from './folderDiverDomUtils';

const DOM_CLICK_DELAY = 16;
const DOM_CLICK_RETRY_DELAY = 16;
const DOM_CLICK_MAX_ATTEMPTS = 4;

export interface DiveResult {
    success: boolean;
    path: string[];
    depth: number;
    reason: 'found_tracks' | 'max_depth' | 'no_folders' | 'no_best_folder' | 'disabled';
}

export class FolderDiver {
    private static _instance: FolderDiver | null = null;

    private bridge: KikoeruBridge;
    private currentPath: string[] = [];
    private diveGeneration = 0;
    private formatPriority: string[] = [];
    private deferredApplyToken = 0;

    private constructor() {
        this.bridge = KikoeruBridge.getInstance();
    }

    static getInstance(): FolderDiver {
        if (!FolderDiver._instance) {
            FolderDiver._instance = new FolderDiver();
        }
        FolderDiver._instance.bridge = KikoeruBridge.getInstance();
        return FolderDiver._instance;
    }

    setFormatPriority(formats: string[]): void {
        this.formatPriority = formats;
    }

    getHostPath(): string[] {
        const treeVm = this.bridge.findWorkTreeComponent() as WorkTreeComponent;
        if (treeVm?.path && Array.isArray(treeVm.path)) {
            return [...treeVm.path];
        }
        return this.bridge.getPathSegments();
    }

    syncPath(path: string[]): void {
        this.currentPath = [...path];
    }

    getPath(): string[] {
        return [...this.currentPath];
    }

    reset(): void {
        this.currentPath = [];
        this.diveGeneration++;
    }

    /**
     * Check if tree data needs diving (has folders but no root-level audio).
     * This is a quick check for the ROOT level only.
     */
    needsDive(tree: TracksResponse): boolean {
        return this.needsDiveFromPath(tree, []);
    }

    /**
     * Check if current path needs diving (folders exist but no direct audio files).
     */
    needsDiveFromPath(tree: TracksResponse, path: string[]): boolean {
        const nodes = this.getNodesAtPath(tree, path);
        if (!nodes.length) return false;
        const folders = this.getFolders(nodes);
        if (folders.length === 0) return false;
        return !this.hasDirectAudio(nodes);
    }

    /**
     * Resolve the nodes array at a given path.
     */
    getNodesAtPath(tree: TracksResponse, path: string[]): Array<TrackFolder | TrackItem> {
        return resolveNodesAtPath(tree, path, true);
    }

    hasDirectAudio(nodes: Array<TrackFolder | TrackItem>): boolean {
        return hasDirectPlayableMedia(nodes);
    }

    /**
     * Dive into the best folder structure starting from ROOT.
     * Use diveFromPath() if you need to continue from a specific path.
     */
    async dive(tree: TracksResponse): Promise<DiveResult> {
        return this.diveFromPath(tree, []);
    }

    /**
     * Dive into the best folder structure starting from a given path.
     * This is the main entry point when we need to continue from where
     * the host app's folder diver left off.
     *
     * @param fullTree The complete tree data from root
     * @param startPath The path to start diving from (can be empty for root)
     */
    async diveFromPath(fullTree: TracksResponse, startPath: string[]): Promise<DiveResult> {
        this.reset();
        const generation = this.diveGeneration;

        // Set current path to the starting position
        this.currentPath = [...startPath];

        // Navigate to the starting point in the tree
        let currentNodes = fullTree;
        for (const segment of startPath) {
            const folder = findFolderBySegment(currentNodes, segment);
            if (!folder) {
                Logger.warn(`[FolderDiver] Start path segment "${segment}" not found`);
                return { success: false, path: [], depth: 0, reason: 'no_folders' };
            }
            currentNodes = folder.children;
        }

        // Now dive recursively from this position (depth is relative to startPath)
        const result = this.diveRecursive(currentNodes, 0);

        if (result.success && result.path.length > 0) {
            // Only apply the NEW path segments (after startPath)
            const newSegments = result.path.slice(startPath.length);
            if (newSegments.length > 0) {
                Logger.debug(`[FolderDiver] Applying ${newSegments.length} new path segments: [${newSegments.join(' > ')}]`);
                const aborted = await this.applyAdditionalPath(newSegments, result.path, generation);
                if (aborted) {
                    Logger.warn('[FolderDiver] Dive aborted — navigation occurred during DOM clicks');
                    return { success: false, path: startPath, depth: startPath.length, reason: 'no_folders' };
                }
            } else {
                Logger.debug('[FolderDiver] No additional diving needed from current position');
            }
        }

        return result;
    }

    /**
     * Navigate to a specific folder by name
     */
    async navigateToFolder(folderName: string): Promise<void> {
        this.currentPath.push(folderName);
        await this.applyPathToWorkTree(this.currentPath);
        Logger.debug(`[FolderDiver] Navigated to: ${folderName}`);
    }

    /**
     * Navigate up one level
     */
    async navigateUp(): Promise<boolean> {
        if (this.currentPath.length === 0) return false;
        this.currentPath.pop();
        await this.applyPathToWorkTree(this.currentPath);
        Logger.debug('[FolderDiver] Navigated up');
        return true;
    }

    /**
     * Navigate to root
     */
    async navigateToRoot(): Promise<void> {
        this.currentPath = [];
        await this.navigateToRootViaDOM();
        Logger.debug('[FolderDiver] Navigated to root');
    }

    /**
     * Resolve the current folder object from a WorkDetail based on currentPath.
     * Used by PlaybackController to get tracks from the dived-into folder.
     * WorkDetail uses dirs/children properties (legacy format).
     */
    getCurrentFolder(work: WorkDetail): WorkFolder | WorkDetail | null {
        if (this.currentPath.length === 0) return null;

        let current: WorkDetail | WorkFolder = work;
        for (const segment of this.currentPath) {
            const dirs = current.dirs || current.children || [];
            const folder = dirs.find((d: WorkFolder) => (d.name || d.title) === segment);
            if (!folder) return null;
            current = folder;
        }
        return current;
    }

    // =========================================================================
    // DOM Click Navigation (Primary)
    // =========================================================================

    /**
     * Apply ADDITIONAL path segments via DOM clicks.
     * Unlike applyPathToWorkTree, this does NOT reset to root first.
     * Falls back to Vue path mutation if DOM clicks fail.
     */
    private async applyAdditionalPath(
        segments: string[],
        fullPath: string[],
        generation?: number
    ): Promise<boolean> {
        for (const segment of segments) {
            if (generation !== undefined && generation !== this.diveGeneration) {
                return true; // aborted
            }
            const clicked = await this.clickAndConfirm(segment);
            if (!clicked) {
                Logger.debug(`[FolderDiver] DOM click sequence failed for "${segment}", falling back to Vue path`);
                this.currentPath = [...fullPath];
                const applied = await this.applyPathViaVueWithRetry(fullPath);
                if (!applied) {
                    Logger.debug('[FolderDiver] Vue path fallback timed out, updating query path instead');
                    this.applyPathViaVue(fullPath);
                }
                return false;
            }
        }

        if (segments.length > 0) {
            Logger.debug(`[FolderDiver] Navigated via DOM clicks: [${segments.join(' > ')}]`);
        }
        return false;
    }

    /**
     * Apply FULL path to WorkTree via DOM click simulation.
     * First navigates to root, then clicks each folder in sequence.
     * Use applyAdditionalPath() if you only need to add more segments.
     */
    private async applyPathToWorkTree(pathSegments: string[], generation?: number): Promise<boolean> {
        // First navigate to root
        await this.navigateToRootViaDOM();

        // Then click each folder in sequence
        for (const segment of pathSegments) {
            if (generation !== undefined && generation !== this.diveGeneration) {
                return true; // aborted
            }
            const clicked = await this.clickAndConfirm(segment);
            if (!clicked) {
                Logger.warn(`[FolderDiver] DOM click sequence failed for "${segment}", trying Vue fallback`);
                const applied = await this.applyPathViaVueWithRetry(pathSegments);
                if (!applied) {
                    Logger.warn('[FolderDiver] Vue fallback timed out, updating query path instead');
                    this.applyPathViaVue(pathSegments);
                }
                return false;
            }
        }

        Logger.debug(`[FolderDiver] Navigated via DOM clicks: [${pathSegments.join(' > ')}]`);
        return false;
    }

    /**
     * Navigate to root by clicking the first breadcrumb.
     * Tries multiple selectors because Quasar breadcrumb markup varies by version.
     */
    private async navigateToRootViaDOM(): Promise<void> {
        const workTree = document.getElementById('work-tree');
        if (!workTree) return;

        // Try multiple breadcrumb selectors (Quasar uses different markup across versions)
        const breadcrumbs = workTree.querySelectorAll(
            '.q-breadcrumbs .q-btn, .q-breadcrumbs a, .q-breadcrumbs__el'
        );
        if (breadcrumbs.length > 1) {
            (breadcrumbs[0] as HTMLElement).click();
            await this.delay(DOM_CLICK_DELAY);
            return;
        }

        // Fallback: reset the Vue path directly
        const treeVm = this.bridge.findWorkTreeComponent() as WorkTreeComponent | null;
        if (treeVm && Array.isArray(treeVm.path)) {
            treeVm.path.splice(0, treeVm.path.length);
            this.syncParentFolder(treeVm, []);
            // Trigger Vue reactivity by also setting via $set if available
            if (typeof treeVm.$forceUpdate === 'function') {
                treeVm.$forceUpdate();
            }
            await this.delay(DOM_CLICK_DELAY);
        }
    }

    /**
     * Find and click a folder item in the native tree by its title text.
     */
    private async clickFolderByTitle(title: string): Promise<boolean> {
        const workTree = document.getElementById('work-tree');
        if (!workTree) return false;

        // Check if we are already in this folder via breadcrumbs
        const breadcrumbText = getActiveBreadcrumbTitle(workTree);
        if (isExactOrPrefixMatch(breadcrumbText, title)) {
            Logger.debug(`[FolderDiver] Already in folder (via breadcrumbs): "${title}"`);
            return true;
        }

        const bestItem = findBestFolderItem(workTree, title);
        if (bestItem) {
            bestItem.click();
            const label = getFolderItemLabel(bestItem);
            Logger.debug(`[FolderDiver] Clicked folder: "${label || title}" (matched title: "${title}")`);
            return true;
        }

        // Check active class
        const activeText = getActiveFolderItemTitle(workTree);
        if (isExactOrPrefixMatch(activeText, title)) {
            Logger.debug(`[FolderDiver] Folder already active: "${title}"`);
            return true;
        }

        return false;
    }

    /**
     * Click a folder and wait for it to actually become active or the tree to update.
     * This prevents "jumping" over folders when the DOM is slow.
     */
    private async clickAndConfirm(title: string): Promise<boolean> {
        for (let attempt = 1; attempt <= DOM_CLICK_MAX_ATTEMPTS; attempt++) {
            const clicked = await this.clickFolderByTitle(title);
            if (clicked) {
                // Wait for breadcrumbs or active item to reflect the change
                for (let j = 0; j < 5; j++) {
                    await this.delay(DOM_CLICK_RETRY_DELAY);
                    const workTree = document.getElementById('work-tree');
                    if (!workTree) continue;

                    const breadcrumbText = getActiveBreadcrumbTitle(workTree);
                    if (isExactOrPrefixMatch(breadcrumbText, title)) {
                        return true;
                    }
                }
            }
            Logger.debug(`[FolderDiver] Click retry ${attempt}/${DOM_CLICK_MAX_ATTEMPTS} for "${title}"`);
            await this.delay(DOM_CLICK_DELAY);
        }
        return false;
    }

    /**
     * Fallback: Apply path via direct Vue path mutation.
     */
    private async applyPathViaVueWithRetry(pathSegments: string[], timeout = 1000): Promise<boolean> {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const treeVm = this.bridge.findWorkTreeComponent() as WorkTreeComponent;
            if (treeVm && Array.isArray(treeVm.path)) {
                this.applyPathToVm(treeVm, pathSegments);
                Logger.debug(`[FolderDiver] Set WorkTree path via Vue fallback: [${pathSegments.join(' > ')}]`);
                return true;
            }
            await this.delay(100);
        }
        this.scheduleDeferredVueApply(pathSegments);
        return false;
    }

    private applyPathViaVue(pathSegments: string[]): void {
        const treeVm = this.bridge.findWorkTreeComponent() as WorkTreeComponent;
        if (treeVm && Array.isArray(treeVm.path)) {
            this.applyPathToVm(treeVm, pathSegments);
            Logger.debug(`[FolderDiver] Set WorkTree path via Vue fallback: [${pathSegments.join(' > ')}]`);
        } else {
            this.bridge.updatePath(pathSegments);
            this.scheduleDeferredVueApply(pathSegments);
            Logger.debug('[FolderDiver] WorkTree component not found, fell back to route query');
        }
    }

    private applyPathToVm(treeVm: WorkTreeComponent, pathSegments: string[]): void {
        if (typeof treeVm.$set === 'function') {
            treeVm.$set(treeVm, 'path', [...pathSegments]);
        } else {
            treeVm.path.splice(0, treeVm.path.length, ...pathSegments);
        }
        this.syncParentFolder(treeVm, pathSegments);
        if (typeof treeVm.$forceUpdate === 'function') {
            treeVm.$forceUpdate();
        }
    }

    private scheduleDeferredVueApply(pathSegments: string[]): void {
        const token = ++this.deferredApplyToken;
        const target = pathSegments.join('\x00');
        const attempt = (remaining: number) => {
            if (token !== this.deferredApplyToken) return;
            const treeVm = this.bridge.findWorkTreeComponent() as WorkTreeComponent;
            if (treeVm && Array.isArray(treeVm.path)) {
                const current = (treeVm.path || []).join('\x00');
                if (current !== target) {
                    this.applyPathToVm(treeVm, pathSegments);
                    Logger.debug('[FolderDiver] Deferred Vue path applied');
                }
                return;
            }
            if (remaining <= 0) return;
            window.setTimeout(() => attempt(remaining - 1), 100);
        };
        window.setTimeout(() => attempt(12), 100);
    }

    /**
     * fatherFolder is a COMPUTED property in the host WorkTree component,
     * derived from tree + path. Do NOT mutate it directly — only update `path`.
     * The computed will automatically derive the correct fatherFolder.
     */
    private syncParentFolder(_treeVm: WorkTreeComponent, _pathSegments: string[]): void {
        // No-op: fatherFolder is computed from tree+path.
        // Setting path (done by callers) is sufficient.
    }

    // =========================================================================
    // Recursive Dive Logic
    // =========================================================================

    private diveRecursive(nodes: Array<TrackFolder | TrackItem>, depth: number): DiveResult {
        if (depth >= LIMITS.MAX_DIVE_DEPTH) {
            Logger.warn(`[FolderDiver] Max dive depth (${LIMITS.MAX_DIVE_DEPTH}) reached, stopping recursion`);
            return { success: this.currentPath.length > 0, path: [...this.currentPath], depth: this.currentPath.length, reason: 'max_depth' };
        }

        const folders = this.getFolders(nodes);
        if (folders.length === 0) {
            return { success: this.currentPath.length > 0, path: [...this.currentPath], depth: this.currentPath.length, reason: 'no_folders' };
        }

        const bestFolder = this.selectBestTreeFolder(folders);
        if (!bestFolder) {
            return { success: this.currentPath.length > 0, path: [...this.currentPath], depth: this.currentPath.length, reason: 'no_best_folder' };
        }

        this.currentPath.push(bestFolder.title);
        Logger.debug(`[FolderDiver] Dived into: ${bestFolder.title} (depth: ${this.currentPath.length})`);

        const directAudio = bestFolder.children.filter(n => n.type === 'audio');
        const subFolders = this.getFolders(bestFolder.children);

        if (directAudio.length > 0 && subFolders.length === 0) {
            return { success: true, path: [...this.currentPath], depth: this.currentPath.length, reason: 'found_tracks' };
        }

        if (subFolders.length > 0 && directAudio.length === 0) {
            return this.diveRecursive(bestFolder.children, depth + 1);
        }

        if (directAudio.length > 0 && subFolders.length > 0) {
            return { success: true, path: [...this.currentPath], depth: this.currentPath.length, reason: 'found_tracks' };
        }

        const deepAudio = this.collectAudioFromTree(bestFolder.children);
        if (deepAudio.length > 0) {
            return { success: true, path: [...this.currentPath], depth: this.currentPath.length, reason: 'found_tracks' };
        }

        return { success: this.currentPath.length > 0, path: [...this.currentPath], depth: this.currentPath.length, reason: 'no_folders' };
    }

    private getFolders(nodes: Array<TrackFolder | TrackItem>): TrackFolder[] {
        return nodes.filter((n): n is TrackFolder => n.type === 'folder');
    }

    private collectAudioFromTree(nodes: Array<TrackFolder | TrackItem>): TrackItem[] {
        const audio: TrackItem[] = [];
        for (const node of nodes) {
            if (node.type === 'folder') {
                audio.push(...this.collectAudioFromTree((node as TrackFolder).children));
            } else if (node.type === 'audio') {
                audio.push(node as TrackItem);
            }
        }
        return audio;
    }

    private selectBestTreeFolder(folders: TrackFolder[]): TrackFolder | null {
        if (!folders.length) return null;

        const sePref = Config.get('sePref');

        const scored = folders.map(folder => {
            const audioChildren = this.collectAudioFromTree(folder.children);
            const audioCount = audioChildren.length;
            const childFormats = Array.from(new Set(
                audioChildren.map(track => {
                    const title = (track.title || track.hash || '').toLowerCase();
                    const match = title.match(/\.([a-z0-9]+)$/);
                    return match ? match[1] : '';
                }).filter(Boolean)
            ));

            let score = calculateFolderScore(
                folder.title,
                audioCount,
                '',
                false,
                this.formatPriority,
                childFormats,
                sePref
            );

            if (audioCount === 0) score += SCORING.NO_AUDIO_PENALTY;

            return { folder, score };
        });

        scored.sort((a, b) => b.score - a.score);

        const best = scored[0];
        if (best.score <= SCORING.MINIMUM_VIABLE_SCORE) return null;

        Logger.debug(`[FolderDiver] Best folder: "${best.folder.title}" (score: ${best.score})`);
        return best.folder;
    }

    private delay(ms: number): Promise<void> {
        return new Promise(r => setTimeout(r, ms));
    }
}
