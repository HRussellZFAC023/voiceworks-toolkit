/**
 * WorkTreeManager - Coordinates folder diving and flat view prefetching.
 *
 * Ensures host app's folder diver runs first, then applies our own
 * folder dive ONLY if the current view has no direct audio files.
 */

import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { Logger, Config } from '../core/Utils';
import { EventBus } from '../core/EventBus';
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
    private pendingFolderSync = false;
    private pendingPathKey = '';
    private autoDiveInProgress = false;
    private manualRouteKey = '';
    private manualRouteWorkId: string | null = null;

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

            // P1 FIX: Detect manual "up" navigation via route change (back button or breadcrumbs)
            // If the work is the same but the path is shorter, it's a manual "up" interaction.
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
                // Any manual URL change should pause auto-dive for this route
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
        this.lastPathKey = ''; // Reset path key on work change
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

            // Fallback: fetch full tree and attempt a dive from current path
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

            // Run an initial check without waiting for a mutation.
            check();
        });
    }

    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
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

    private syncWorkTreeToRoute(path: string[]): void {
        const treeVm = this.bridge.findWorkTreeComponent() as any;
        if (!treeVm) return;

        const currentPath = Array.isArray(treeVm.path) ? treeVm.path : [];
        const targetPath = Array.isArray(path) ? path : [];
        const samePath = arraysEqual(currentPath, targetPath);

        if (!samePath) {
            // Mark that we need to sync fatherFolder for this new path
            this.pendingFolderSync = true;
            this.pendingPathKey = targetPath.join('\x00');

            // Notify translation system to reset BEFORE Vue updates DOM
            // This prevents stale translated text from persisting on reused DOM elements
            EventBus.emit('worktree:path-change', { path: targetPath });

            if (typeof treeVm.$set === 'function') {
                treeVm.$set(treeVm, 'path', [...targetPath]);
            } else if (Array.isArray(treeVm.path)) {
                treeVm.path.splice(0, treeVm.path.length, ...targetPath);
            } else {
                treeVm.path = [...targetPath];
            }
        }

        const tree = treeVm.tree || treeVm.$data?.tree || treeVm._data?.tree;
        // IMPORTANT: Always access fatherFolder through the reactive property (treeVm.fatherFolder)
        // NOT through $data or _data which bypasses Vue's reactivity system
        const folderTarget = treeVm.fatherFolder;
        if (Array.isArray(tree) && Array.isArray(folderTarget)) {
            const nextFolder = this.folderDiver.getNodesAtPath(tree, targetPath);

            // Validate nextFolder is correct for the path (not a fallback to root)
            // If path is non-empty but nextFolder equals root tree, path wasn't found
            const isRootFallback = targetPath.length > 0 && nextFolder === tree;
            if (isRootFallback) {
                Logger.warn('[WorkTreeManager] Path not found in tree, skipping fatherFolder update', {
                    path: targetPath.join('/'),
                    treeLength: tree.length
                });
                return;
            }

            // Use pendingFolderSync to ensure update happens even if tree loaded after path change
            const needsUpdate = this.pendingFolderSync || !this.isSameFolder(folderTarget, nextFolder);
            if (needsUpdate && nextFolder.length > 0) {
                const nextItems = [...nextFolder];
                // Use $set for guaranteed reactivity, falling back to splice on the reactive array
                if (typeof treeVm.$set === 'function') {
                    treeVm.$set(treeVm, 'fatherFolder', nextItems);
                } else {
                    // Splice on the reactive property directly
                    treeVm.fatherFolder.splice(0, treeVm.fatherFolder.length, ...nextItems);
                }

                // Mark sync complete if this is the pending path
                if (this.pendingPathKey === targetPath.join('\x00')) {
                    this.pendingFolderSync = false;
                }
                Logger.debug('[WorkTreeManager] Updated fatherFolder with', nextItems.length, 'items for path', targetPath.join('/') || '(root)');
            }
        }

        if (typeof treeVm.$forceUpdate === 'function') {
            treeVm.$forceUpdate();
        }
        this.folderDiver.syncPath(targetPath);
        Logger.debug('[WorkTreeManager] Synced WorkTree path with route', { path: targetPath.join('/') || '(root)' });
    }

    private isSameFolder(a: any[], b: any[]): boolean {
        if (a === b) return true;
        if (!Array.isArray(a) || !Array.isArray(b)) return false;
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            const aItem = a[i];
            const bItem = b[i];
            const aKey = aItem?.hash || aItem?.title || aItem?.name || '';
            const bKey = bItem?.hash || bItem?.title || bItem?.name || '';
            if (aKey !== bKey) return false;
        }
        return true;
    }

    private observeWorkTreeDom(): void {
        if (this.treeObserver) return;
        const root = document.getElementById('work-tree') || document.body;
        this.treeObserver = new MutationObserver(() => {
            const workId = this.getWorkIdFromRoute(this.bridge.route) || this.bridge.currentWorkId;
            const hasItems = !!document.querySelector('#work-tree .q-item');
            if (!hasItems) return;

            const routePath = this.getSegmentsFromRoute(this.bridge.route);
            if (workId) {
                this.syncWorkTreeToRoute(routePath);
            }

            if (!workId || !Config.get('autoFilterFolders')) return;

            const pathKey = this.folderDiver.getHostPath().join('/');
            const now = Date.now();

            // Only throttle if we are on the EXACT SAME path in the same work AND sync is complete
            if (this.domDiveWorkId === workId && this.lastPathKey === pathKey &&
                now - this.domDiveAt < 2000 && !this.pendingFolderSync) {
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
