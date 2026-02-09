/**
 * WorkTreeManager - Coordinates folder diving and flat view prefetching.
 *
 * "Nuke & Enhance" pattern:
 * - Sync watcher sets _vnode=null on path change → Vue creates fresh DOM
 * - hook:updated runs a single coordinated enhancement pass
 * - No DOM cleanup needed (fresh DOM has no stale content)
 */

import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { Logger, Config } from '../core/Utils';
import { EventBus } from '../core/EventBus';
import { CentralObserver } from '../core/CentralObserver';
import { getCleanText } from '../core/DomUtils';
import { FolderDiver } from './FolderDiver';
import { FlatViewController } from './FlatViewController';
import { WorkService } from '../services/WorkService';
import type { TracksResponse } from '../types/api';

declare const unsafeWindow: Window & typeof globalThis;

const globalWindow = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as Window & {
    __ASMR_WORKTREE_MANAGER__?: WorkTreeManager;
};

const HOST_DIVER_WAIT_TIMEOUT = 150;
const HOST_DIVER_STABLE_TICKS = 2;

function arraysEqual(a: string[], b: string[]): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

export class WorkTreeManager {
    private static _instance: WorkTreeManager | null = null;
    private bridge: KikoeruBridge;
    private folderDiver: FolderDiver;
    private flatView: FlatViewController;
    private enabled = false;
    private diveToken = 0;
    private currentWorkId: string | null = null;
    private domDiveWorkId: string | null = null;
    private domDiveAt = 0;
    private lastPathKey = '';
    private treeObserver: MutationObserver | null = null;
    private manualOverrideUntil = 0;
    private autoDiveInProgress = false;
    private manualRouteKey = '';
    private manualRouteWorkId: string | null = null;
    private lastHostPathKey = '';
    private hostPathWatcherCleanup: (() => void) | null = null;
    private treeVmHooked = false;
    private syncWatcherCleanup: (() => void) | null = null;
    /** Dedup key for worktree:path-change emission from enhanceWorkTree */
    private lastEnhancedPathKey = '';

    private constructor() {
        this.bridge = KikoeruBridge.getInstance();
        this.folderDiver = FolderDiver.getInstance();
        this.flatView = new FlatViewController();
    }

    static getInstance(): WorkTreeManager {
        if (!WorkTreeManager._instance) {
            WorkTreeManager._instance = new WorkTreeManager();
        }
        return WorkTreeManager._instance;
    }

    enable(): void {
        if (this.enabled) return;
        this.enabled = true;

        this.flatView.enable();
        this.watchRoute();
        this.watchHostPath();
        this.observeWorkTreeDom();
        this.watchManualNav();

        if (this.bridge.route?.path?.includes('/work/')) {
            const workId = this.getWorkIdFromRoute(this.bridge.route) || this.bridge.currentWorkId;
            if (workId) {
                this.handleWorkRoute(String(workId));
            }
        }
    }

    disable(): void {
        if (!this.enabled) return;
        this.enabled = false;
        this.flatView.disable();
        this.treeObserver?.disconnect();
        this.treeObserver = null;
        this.hostPathWatcherCleanup?.();
        this.hostPathWatcherCleanup = null;
        this.syncWatcherCleanup?.();
        this.syncWatcherCleanup = null;
        this.treeVmHooked = false;
        this.bridge.invalidateWorkTreeCache();
        this.diveToken++;
    }

    // =========================================================================
    // Route Handling
    // =========================================================================

    private watchRoute(): void {
        const app = this.bridge.app;
        if (!app?.$watch) {
            Logger.warn('[WorkTreeManager] Vue $watch not available');
            return;
        }

        app.$watch('$route', (to: any, from: any) => {
            const workId = this.getWorkIdFromRoute(to);
            if (!workId) return;

            const toPath = this.getSegmentsFromRoute(to);
            const fromPath = this.getSegmentsFromRoute(from);
            const sameWork = this.getWorkIdFromRoute(from) === workId;
            const samePath = arraysEqual(toPath, fromPath);
            const routeKey = this.getRouteKey(to);
            const prevRouteKey = this.getRouteKey(from);
            const routeChanged = routeKey !== prevRouteKey;

            if (sameWork && !samePath) {
                this.syncWorkTreeToRoute(toPath);
            }

            if (sameWork && routeChanged && !this.autoDiveInProgress) {
                this.handleManual();
                this.manualRouteWorkId = String(workId);
                this.manualRouteKey = routeKey;
                this.cancelAutoDive();
                // If only query changed (e.g. stream param), still reset translations
                if (samePath) {
                    EventBus.emit('worktree:path-change', { path: toPath });
                }
            }

            if (sameWork && toPath.length < fromPath.length) {
                this.handleManual();
            }

            this.handleWorkRoute(String(workId));
        });
    }

    private handleWorkRoute(workId: string): void {
        if (this.currentWorkId === workId) return;
        this.currentWorkId = workId;
        this.diveToken++;
        this.lastPathKey = '';
        this.lastEnhancedPathKey = '';
        this.manualRouteKey = '';
        this.manualRouteWorkId = null;

        this.flatView.prefetch(workId);

        if (!Config.get('autoFilterFolders')) {
            Logger.debug('[WorkTreeManager] autoFilterFolders disabled, skipping dive');
            return;
        }

        this.maybeAutoDive(workId, this.diveToken).catch((err) => {
            Logger.warn('[WorkTreeManager] Auto-dive failed:', err);
        });
    }

    // =========================================================================
    // Auto Dive Logic
    // =========================================================================

    private async maybeAutoDive(workId: string, token: number): Promise<void> {
        if (Date.now() < this.manualOverrideUntil) {
            Logger.debug('[WorkTreeManager] Manual navigation detected, skipping auto-dive');
            return;
        }
        if (this.isManualRouteOverrideActive(workId)) {
            Logger.debug('[WorkTreeManager] Manual route override active, skipping auto-dive');
            return;
        }
        if (this.hasExplicitPath(this.bridge.route)) {
            Logger.debug('[WorkTreeManager] Route has explicit path, skipping auto-dive');
            return;
        }

        const settled = await this.waitForHostDiver(token);
        if (!settled || token !== this.diveToken) {
            if (token !== this.diveToken || this.currentWorkId !== workId) return;
            Logger.debug('[WorkTreeManager] Host diver wait timed out, retrying once');
            const retry = await this.waitForHostDiver(token);
            if (retry && token === this.diveToken) {
                await this.withAutoDiveFlag(() => this.applyDiveDecision(workId, retry.tree, retry.path));
                return;
            }

            try {
                Logger.debug('[WorkTreeManager] Host tree unavailable, falling back to API tracks');
                const tree = await WorkService.getTracks(workId);
                if (token !== this.diveToken || !tree?.length) return;
                const path = this.folderDiver.getHostPath();
                await this.withAutoDiveFlag(() => this.applyDiveDecision(workId, tree, path));
            } catch (err) {
                Logger.warn('[WorkTreeManager] API fallback failed:', err);
            }
            return;
        }

        await this.withAutoDiveFlag(() => this.applyDiveDecision(workId, settled.tree, settled.path));
    }

    private async applyDiveDecision(workId: string, tree: TracksResponse, path: string[]): Promise<void> {
        if (!tree?.length) return;
        this.folderDiver.syncPath(path);

        const nodes = this.folderDiver.getNodesAtPath(tree, path);
        const hasDirectAudio = this.folderDiver.hasDirectAudio(nodes);

        Logger.debug('[WorkTreeManager] Host diver settled', {
            workId,
            path: path.join('/') || '(root)',
            hasDirectAudio,
        });

        if (hasDirectAudio) {
            Logger.debug('[WorkTreeManager] Current view has direct audio, no dive needed');
            return;
        }

        if (!this.folderDiver.needsDiveFromPath(tree, path)) {
            Logger.debug('[WorkTreeManager] No eligible folders to dive into');
            return;
        }

        Logger.debug('[WorkTreeManager] Diving deeper from current view');
        await this.folderDiver.diveFromPath(tree, path);
    }

    private async waitForHostDiver(token: number): Promise<{ tree: TracksResponse; path: string[] } | null> {
        return new Promise((resolve) => {
            let stableTicks = 0;
            let lastPathKey = '';
            let lastSeen: { tree: TracksResponse; path: string[] } | null = null;

            const check = () => {
                if (token !== this.diveToken) {
                    cleanup();
                    resolve(null);
                    return;
                }
                const treeVm = this.bridge.findWorkTreeComponent() as any;
                const tree = treeVm?.tree as TracksResponse | undefined;
                const path = this.folderDiver.getHostPath();
                if (Array.isArray(tree) && tree.length > 0) {
                    lastSeen = { tree, path };
                    const key = (path || []).join('\x00');
                    if (key === lastPathKey) {
                        stableTicks++;
                    } else {
                        lastPathKey = key;
                        stableTicks = 0;
                    }
                    if (stableTicks >= HOST_DIVER_STABLE_TICKS) {
                        cleanup();
                        resolve({ tree, path });
                        return;
                    }
                }
            };

            const cleanup = () => {
                if (observer) observer.disconnect();
                if (timeoutId) clearTimeout(timeoutId);
            };

            const target = document.getElementById('work-tree') || document.body;
            const observer = new MutationObserver(() => check());
            observer.observe(target, { childList: true, subtree: true });

            const timeoutId = window.setTimeout(() => {
                cleanup();
                Logger.debug('[WorkTreeManager] Host diver wait timed out');
                resolve(lastSeen);
            }, HOST_DIVER_WAIT_TIMEOUT);

            check();
        });
    }

    // =========================================================================
    // Path Sync & Route Helpers
    // =========================================================================

    /**
     * Sync the WorkTree component path to match the route.
     * Setting path triggers the sync watcher (_vnode=null) → Vue creates fresh DOM
     * → hook:updated fires enhanceWorkTree.
     */
    private syncWorkTreeToRoute(path: string[]): void {
        const treeVm = this.bridge.findWorkTreeComponent() as any;
        if (!treeVm) return;

        this.installTreeHooks(treeVm);

        const currentPath = Array.isArray(treeVm.path) ? treeVm.path : [];
        const targetPath = Array.isArray(path) ? path : [];
        if (arraysEqual(currentPath, targetPath)) return;

        // Validate path exists in tree before setting it
        const tree = treeVm.tree || treeVm.$data?.tree || treeVm._data?.tree;
        if (Array.isArray(tree) && targetPath.length > 0) {
            const resolved = this.folderDiver.getNodesAtPath(tree, targetPath);
            if (resolved === tree) {
                Logger.warn('[WorkTreeManager] Path not found in tree, skipping path update', {
                    path: targetPath.join('/'),
                    treeLength: tree.length
                });
                return;
            }
        }

        // Set path — sync watcher fires immediately, nukes _vnode.
        // Vue then creates fresh DOM, hook:updated runs enhanceWorkTree.
        if (typeof treeVm.$set === 'function') {
            treeVm.$set(treeVm, 'path', [...targetPath]);
        } else if (Array.isArray(treeVm.path)) {
            treeVm.path.splice(0, treeVm.path.length, ...targetPath);
        } else {
            treeVm.path = [...targetPath];
        }

        this.lastHostPathKey = targetPath.join('\x00');
        this.folderDiver.syncPath(targetPath);
        Logger.debug('[WorkTreeManager] Synced WorkTree path with route', { path: targetPath.join('/') || '(root)' });
    }

    /**
     * Watch treeVm.path for changes made by the HOST app (folder clicks, breadcrumbs).
     * The host updates path internally without changing the route. We watch it to
     * keep FolderDiver in sync. Enhancement is handled by hook:updated.
     */
    private watchHostPath(): void {
        const app = this.bridge.app;
        if (!app?.$watch) return;

        const getPathKey = (): string => {
            const treeVm = this.bridge.findWorkTreeComponent() as any;
            if (!treeVm?.path || !Array.isArray(treeVm.path)) return '';
            this.installTreeHooks(treeVm);
            return treeVm.path.join('\x00');
        };

        this.lastHostPathKey = getPathKey();

        this.hostPathWatcherCleanup = app.$watch(getPathKey, (next: string, prev: string) => {
            if (next === prev) return;
            this.lastHostPathKey = next;
            const newPath = next ? next.split('\x00') : [];
            this.folderDiver.syncPath(newPath);
            // Enhancement (markItemTypes, copy/transcript buttons, path-change event)
            // is handled by hook:updated → enhanceWorkTree
        });
    }

    private getWorkIdFromRoute(route?: { path?: string; params?: { id?: string }; query?: any } | null): string | null {
        if (!route) return null;
        const paramId = route.params?.id;
        if (paramId) return String(paramId);
        const path = route.path || '';
        const match = path.match(/\/work\/([^/?#]+)/i);
        return match?.[1] || null;
    }

    private getSegmentsFromRoute(route?: any): string[] {
        const raw = route?.query?.path;
        if (!raw) return [];
        if (Array.isArray(raw)) {
            return raw.map((segment) => String(segment));
        }
        if (typeof raw !== 'string') return [];
        try {
            const p = JSON.parse(raw);
            return Array.isArray(p) ? p : [];
        } catch {
            return [];
        }
    }

    private handleManual(): void {
        this.manualOverrideUntil = Date.now() + 5000;
        Logger.debug('[WorkTreeManager] Manual navigation detected, deferring auto-dive for 5s');
    }

    private cancelAutoDive(): void {
        this.diveToken++;
        this.folderDiver.reset();
    }

    private withAutoDiveFlag<T>(fn: () => Promise<T>): Promise<T> {
        this.autoDiveInProgress = true;
        return fn().finally(() => {
            this.autoDiveInProgress = false;
        });
    }

    private isManualRouteOverrideActive(workId: string): boolean {
        if (!this.manualRouteKey || this.manualRouteWorkId !== workId) return false;
        const currentKey = this.getRouteKey(this.bridge.route);
        return !!currentKey && currentKey === this.manualRouteKey;
    }

    private getRouteKey(route?: { fullPath?: string; path?: string; query?: any } | null): string {
        if (!route) return '';
        const fullPath = route.fullPath || route.path || '';
        if (fullPath) return fullPath.split('#')[0];
        const path = route.path || '';
        const queryKey = this.normalizeQuery(route.query);
        return queryKey ? `${path}?${queryKey}` : path;
    }

    private normalizeQuery(value: unknown): string {
        if (!value || typeof value !== 'object') return value ? String(value) : '';
        const entries = Object.keys(value as Record<string, unknown>)
            .sort()
            .map((key) => [key, (value as Record<string, unknown>)[key]]);
        try {
            return JSON.stringify(entries);
        } catch {
            return String(value);
        }
    }

    private hasExplicitPath(route?: { query?: any } | null): boolean {
        const query = route?.query;
        if (!query || typeof query !== 'object') return false;
        return Object.prototype.hasOwnProperty.call(query, 'path');
    }

    // =========================================================================
    // "Nuke & Enhance" — Core Pattern
    // =========================================================================

    /**
     * Install sync watcher + lifecycle hooks on the WorkTree Vue component.
     *
     * Sync watcher on `path`:
     * - Fires IMMEDIATELY inside the reactive setter (before Vue queues render)
     * - Sets _vnode=null → Vue does a full mount (creates fresh DOM from scratch)
     * - No stale vnode.elm references, no cleanup needed
     *
     * hook:updated:
     * - Fires after Vue renders fresh DOM
     * - Runs single coordinated enhancement pass (item types, buttons, events)
     *
     * hook:beforeDestroy:
     * - Clears treeVmHooked so hooks are reinstalled on new VM instance
     */
    private installTreeHooks(treeVm: any): void {
        if (this.treeVmHooked) return;
        if (!treeVm?.$watch || !treeVm?.$on) return;
        this.treeVmHooked = true;

        // Sync watcher: nuke vnode + force update BEFORE Vue's render watcher.
        // Vue sees prevVnode=null → full mount (fresh DOM, no stale refs).
        // $forceUpdate() ensures render is scheduled even during Vue's scheduler flush
        // (matches KikoeruBridge.forceWorkTreeRerender() which also calls both).
        const unwatch = treeVm.$watch('path', () => {
            Logger.debug('[WorkTreeManager] Sync path watcher: nuking vnode for fresh render');
            treeVm._vnode = null;
            treeVm.$forceUpdate();

            // Pre-render: reset TranslatedTags/FuriganaRenderer state BEFORE Vue renders.
            // TranslatedTags modifies .q-item__label textContent (detaches Vue's text nodes).
            // Resetting here strips data-asmrtag attributes on the OLD DOM so Vue can patch
            // correctly even if _vnode=null somehow fails to create fresh DOM.
            const path = Array.isArray(treeVm.path) ? [...treeVm.path] : [];
            const pathKey = path.join('\x00');
            if (pathKey !== this.lastEnhancedPathKey) {
                this.lastEnhancedPathKey = pathKey;
                if (!this.autoDiveInProgress) {
                    EventBus.emit('worktree:path-change', { path });
                    Logger.debug('[WorkTreeManager] Path changed (pre-render)', { path: path.join('/') || '(root)' });
                }
            }
        }, { sync: true, deep: true });
        this.syncWatcherCleanup = unwatch || null;

        // After every render: single coordinated enhancement pass.
        treeVm.$on('hook:updated', () => {
            this.enhanceWorkTree(treeVm);
        });

        // Also on initial mount (hook:updated only fires on re-renders).
        treeVm.$on('hook:mounted', () => {
            this.enhanceWorkTree(treeVm);
        });

        // Detect component destruction → re-install hooks on recreation.
        treeVm.$on('hook:beforeDestroy', () => {
            Logger.debug('[WorkTreeManager] WorkTree VM destroyed, clearing hooks');
            this.treeVmHooked = false;
            this.syncWatcherCleanup = null;
            this.lastEnhancedPathKey = '';
            this.bridge.invalidateWorkTreeCache();
        });

        Logger.debug('[WorkTreeManager] Installed sync watcher + lifecycle hooks on WorkTree');
    }

    /**
     * Single coordinated enhancement pass after Vue renders fresh DOM.
     * Called from hook:updated and hook:mounted on the WorkTree VM.
     *
     * 1. Mark item types from fatherFolder data
     * 2. Emit worktree:enhanced for WorkTreeCopy/TranscriptFileInjector
     * 3. Verify DOM matches data (safety net)
     *
     * Note: worktree:path-change is emitted in the sync watcher (before render)
     * so TranslatedTags/FuriganaRenderer reset state BEFORE Vue renders fresh DOM.
     */
    private enhanceWorkTree(treeVm: any): void {
        const workTree = document.getElementById('work-tree');
        if (!workTree) return;

        // 0. Force correct text on reused DOM elements.
        //    Vue 2 reuses elements via :key="index". Features like FuriganaRenderer
        //    and TranslatedTags modify .q-item__label, detaching Vue's tracked text
        //    nodes. On navigation, Vue writes new text to detached nodes — the visible
        //    DOM keeps stale content. This fixup runs synchronously in hook:updated
        //    (before browser paint) and overwrites stale text from fatherFolder data.
        this.fixWorkTreeText(treeVm, workTree);

        // 1. Mark item types from fatherFolder
        this.markItemTypes();

        // 2. Trigger copy buttons + transcript chips
        EventBus.emit('worktree:enhanced', { workTree });
    }

    /**
     * Force-correct .q-item__label text from fatherFolder data.
     *
     * Runs synchronously after every Vue render (hook:updated / hook:mounted).
     * Compares each label's clean text (stripping furigana/translation artifacts)
     * with the expected title from fatherFolder. On mismatch, resets the element
     * to the correct text and strips stale feature state.
     *
     * This makes the work tree resilient to DOM corruption from any source
     * (FuriganaRenderer ruby replacement, TranslatedTags, or Vue patch failures).
     */
    private fixWorkTreeText(treeVm: any, workTree: HTMLElement): void {
        try {
            const fatherFolder = treeVm.fatherFolder;
            if (!Array.isArray(fatherFolder) || fatherFolder.length === 0) return;

            const labels = workTree.querySelectorAll('.q-item__label:not(.q-item__label--caption)');
            if (labels.length === 0) return;

            // Collect mismatches first, then batch-fix inside withModification
            // to avoid triggering CentralObserver (FuriganaRenderer, TranslatedTags)
            const fixes: Array<{ label: HTMLElement; expected: string }> = [];

            for (let i = 0; i < Math.min(labels.length, fatherFolder.length); i++) {
                const label = labels[i] as HTMLElement;
                const expected = fatherFolder[i]?.title;
                if (!label || !expected) continue;

                // getCleanText reads data-jpdb-original if furigana was applied,
                // or strips <rt>/<rp> from ruby annotations, falling back to textContent
                const domText = getCleanText(label);
                if (domText === expected || domText.includes(expected)) continue;

                fixes.push({ label, expected });
            }

            if (fixes.length === 0) return;

            CentralObserver.withModification(() => {
                for (const { label, expected } of fixes) {
                    // Mismatch: force correct text and strip stale feature state
                    label.textContent = expected;
                    delete label.dataset.asmrtag;
                    delete label.dataset.asmrtagState;
                    delete label.dataset.asmrtagScope;
                    delete label.dataset.asmrtagTranslation;
                    label.classList.remove('asmr-translated');
                    label.classList.remove('asmr-worktree-translation');
                    label.removeAttribute('data-jpdb');
                    label.removeAttribute('data-jpdb-original');
                }
            });

            if (fixes.length > 0) {
                Logger.debug(`[WorkTreeManager] Fixed ${fixes.length} stale label(s)`);
            }
        } catch {
            // fatherFolder computed may throw if path is invalid — ignore
        }
    }

    /**
     * Mark each q-item with data-item-type from fatherFolder.
     * Features check this attribute before injecting elements
     * (e.g., skip transcript buttons on folders).
     */
    private markItemTypes(): void {
        const treeVm = this.bridge.workTreeVm as any;
        const fatherFolder = treeVm?.fatherFolder;
        if (!Array.isArray(fatherFolder) || fatherFolder.length === 0) return;

        const workTree = document.getElementById('work-tree');
        if (!workTree) return;

        const items = workTree.querySelectorAll('.q-list > .q-item');
        items.forEach((item, i) => {
            if (i >= fatherFolder.length) return;
            const data = fatherFolder[i];
            if (!data) return;
            (item as HTMLElement).dataset.itemType = data.type || 'unknown';
        });
    }

    // =========================================================================
    // DOM Observation (auto-dive only)
    // =========================================================================

    /**
     * Observe work tree DOM changes for auto-dive detection and lazy hook installation.
     * Does NOT handle enhancement — that's done by hook:updated.
     */
    private observeWorkTreeDom(): void {
        if (this.treeObserver) return;
        const root = document.getElementById('work-tree') || document.body;
        this.treeObserver = new MutationObserver(() => {
            // Lazily install hooks when WorkTree component becomes available
            if (!this.treeVmHooked) {
                const treeVm = this.bridge.findWorkTreeComponent() as any;
                if (treeVm) this.installTreeHooks(treeVm);
            }

            const workId = this.getWorkIdFromRoute(this.bridge.route) || this.bridge.currentWorkId;
            const hasItems = !!document.querySelector('#work-tree .q-item');
            if (!hasItems) return;

            if (!workId || !Config.get('autoFilterFolders')) return;

            const pathKey = this.folderDiver.getHostPath().join('/');
            const now = Date.now();

            // Throttle: skip if same work + same path + within 2s
            if (this.domDiveWorkId === workId && this.lastPathKey === pathKey &&
                now - this.domDiveAt < 2000) {
                return;
            }

            this.domDiveWorkId = workId;
            this.lastPathKey = pathKey;
            this.domDiveAt = now;

            this.diveToken++;
            Logger.debug('[WorkTreeManager] Work-tree ready, checking auto-dive', { workId, path: pathKey || '(root)' });
            void this.maybeAutoDive(workId, this.diveToken);
        });
        this.treeObserver.observe(root, { childList: true, subtree: true });
    }

    private watchManualNav(): void {
        document.addEventListener('pointerdown', (evt) => {
            const tree = document.getElementById('work-tree');
            if (!tree) return;
            if (tree.contains(evt.target as Node)) {
                this.handleManual();
            }
        }, true);

        document.addEventListener('keydown', (evt) => {
            if (evt.key === 'Enter' || evt.key === ' ') {
                const tree = document.getElementById('work-tree');
                if (tree?.contains(evt.target as Node)) {
                    this.handleManual();
                }
            }
        }, true);
    }
}
