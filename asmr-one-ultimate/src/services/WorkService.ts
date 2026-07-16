import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { HttpClient } from '../infrastructure/HttpClient';
import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { Work, WorkInfo, TracksResponse } from '../types/api';
import { Logger } from '../core/Utils';
import { DEFAULT_API_SERVER, CACHE_TTL, RETRY } from '../core/Constants';

interface WorkCacheDB extends DBSchema {
    work: {
        key: number;
        value: {
            data: Work;
            timestamp: number;
        };
    };
    workInfo: {
        key: number;
        value: {
            data: WorkInfo;
            timestamp: number;
        };
    };
    tracks: {
        key: number;
        value: {
            data: TracksResponse;
            timestamp: number;
        };
    };
}

const DB_NAME = 'asmr-one-work-cache';
const DB_VERSION = 2; // Bump version to fix schema
const CACHE_TTL_MS = CACHE_TTL.TWENTY_FOUR_HOURS_MS;
const TRACKS_TTL_MS = CACHE_TTL.TWENTY_FOUR_HOURS_MS;

export class WorkServiceImpl {
    private dbPromise: Promise<IDBPDatabase<WorkCacheDB>>;
    private inflightWork = new Map<number, Promise<Work>>();
    private inflightTracks = new Map<number, Promise<TracksResponse>>();

    constructor() {
        this.dbPromise = openDB<WorkCacheDB>(DB_NAME, DB_VERSION, {
            upgrade(db, oldVersion) {
                // If upgrading from v1 (broken schema for 'work'), delete it
                if (oldVersion < 2 && db.objectStoreNames.contains('work')) {
                    db.deleteObjectStore('work');
                }

                if (!db.objectStoreNames.contains('work')) {
                    db.createObjectStore('work'); // Use out-of-line keys (no keyPath)
                }
                if (!db.objectStoreNames.contains('workInfo')) {
                    db.createObjectStore('workInfo');
                }
                if (!db.objectStoreNames.contains('tracks')) {
                    db.createObjectStore('tracks');
                }
            },
        }).catch(err => {
            Logger.error('[WorkService] DB init failed:', err);
            throw err;
        });
    }

    private getApiBaseUrl(): string {
        try {
            // Access KikoeruBridge
            const bridge = KikoeruBridge.getInstance();
            const axios = bridge.axios;
            const baseURL = axios?.defaults?.baseURL;
            if (baseURL && baseURL.startsWith('http')) {
                return baseURL.replace(/\/$/, '');
            }
        } catch { /* ignore */ }
        // Fallback to the default API server, NOT window.location.origin
        // which would return the website HTML instead of API JSON
        return DEFAULT_API_SERVER;
    }

    /**
     * Get full work details (including user data if logged in)
     * Strategies:
     * - Default: cache-first if fresh (< 1h), else network.
     * - Offline: always cache if available.
     */
    public async getWork(id: number | string, forceRefresh = false): Promise<Work> {
        const stripped = String(id).replace(/^[A-Za-z]+/, '');
        const workId = Number(stripped);
        if (!workId) throw new Error('Invalid work ID');

        if (!forceRefresh) {
            const cached = await this.getFromCache('work', workId);
            if (cached && this.isFresh(cached.timestamp, CACHE_TTL_MS)) {
                Logger.debug(`[WorkService] Cache hit for work ${workId}`);
                return cached.data;
            }
            Logger.debug(`[WorkService] Cache miss/stale for work ${workId}`);
        }

        // Deduplicate concurrent requests for the same work
        const inflight = this.inflightWork.get(workId);
        if (inflight && !forceRefresh) return inflight;

        const promise = this.fetchWork(workId);
        this.inflightWork.set(workId, promise);
        promise.finally(() => this.inflightWork.delete(workId));
        return promise;
    }

    private async fetchWork(workId: number): Promise<Work> {
        try {
            const baseUrl = this.getApiBaseUrl();
            const response = await HttpClient.getJsonViaCors<Work>(`${baseUrl}/api/work/${workId}`, {
                retry: RETRY.BLOB,
            });
            await this.setCache('work', workId, response.data);
            return response.data;
        } catch (error) {
            const cached = await this.getFromCache('work', workId);
            if (cached) {
                Logger.warn(`[WorkService] Network failed for work ${workId}, returning stale cache`, error);
                return cached.data;
            }
            throw new Error(`[WorkService] Failed for ${workId}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Get public work info (no user data)
     */
    public async getWorkInfo(id: number | string, forceRefresh = false): Promise<WorkInfo> {
        const stripped = String(id).replace(/^[A-Za-z]+/, '');
        const workId = Number(stripped);
        if (!workId) throw new Error('Invalid work ID');

        if (!forceRefresh) {
            const cached = await this.getFromCache('workInfo', workId);
            if (cached && this.isFresh(cached.timestamp, CACHE_TTL_MS)) {
                Logger.debug(`[WorkService] Cache hit for workInfo ${workId}`);
                return cached.data;
            }
            Logger.debug(`[WorkService] Cache miss/stale for workInfo ${workId}`);
        }

        try {
            const baseUrl = this.getApiBaseUrl();
            const response = await HttpClient.getJsonViaCors<WorkInfo>(`${baseUrl}/api/workInfo/${workId}`, {
                retry: RETRY.BLOB,
            });
            await this.setCache('workInfo', workId, response.data);
            return response.data;
        } catch (error) {
            const cached = await this.getFromCache('workInfo', workId);
            if (cached) return cached.data;
            throw new Error(`[WorkService] Failed for ${workId}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Get tracks structure
     */
    public async getTracks(
        id: number | string,
        forceRefresh = false,
        bypassInflight = false,
    ): Promise<TracksResponse> {
        const stripped = String(id).replace(/^[A-Za-z]+/, '');
        const workId = Number(stripped);
        if (!workId) throw new Error('Invalid work ID');

        if (!forceRefresh) {
            const cached = await this.getFromCache('tracks', workId);
            if (cached && this.isFresh(cached.timestamp, TRACKS_TTL_MS)) {
                if (!Array.isArray(cached.data)) {
                    Logger.warn(`[WorkService] Cached tracks invalid for ${workId}, ignoring`, typeof cached.data);
                } else {
                    Logger.debug(`[WorkService] Cache hit for tracks ${workId}`);
                    return cached.data;
                }
            }
            Logger.debug(`[WorkService] Cache miss/stale for tracks ${workId}`);
        }

        // Deduplicate concurrent requests for the same tracks
        const inflight = this.inflightTracks.get(workId);
        if (inflight && !forceRefresh && !bypassInflight) return inflight;

        const promise = this.fetchTracks(workId);
        if (bypassInflight) return promise;
        this.inflightTracks.set(workId, promise);
        promise.finally(() => this.inflightTracks.delete(workId));
        return promise;
    }

    private async fetchTracks(workId: number): Promise<TracksResponse> {
        try {
            const baseUrl = this.getApiBaseUrl();
            const response = await HttpClient.getJsonViaCors<TracksResponse>(`${baseUrl}/api/tracks/${workId}?v=2`, {
                retry: RETRY.BLOB,
            });
            const data = Array.isArray(response.data) ? response.data : [];
            await this.setCache('tracks', workId, data);
            return data;
        } catch (error) {
            const cached = await this.getFromCache('tracks', workId);
            if (cached) return cached.data;
            throw new Error(`[WorkService] Failed for ${workId}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Helper to get cached data
     */
    private async getFromCache<K extends keyof WorkCacheDB>(
        storeName: K,
        key: number
    ): Promise<WorkCacheDB[K]['value'] | undefined> {
        try {
            const db = await this.dbPromise;
            return await db.get(storeName as 'work' | 'workInfo' | 'tracks', key);
        } catch (err) {
            Logger.warn(`[WorkService] Cache read failed for ${storeName}:${key}`, err);
            return undefined;
        }
    }

    private async setCache<K extends keyof WorkCacheDB>(
        storeName: K,
        key: number,
        data: WorkCacheDB[K]['value']['data']
    ): Promise<void> {
        try {
            const db = await this.dbPromise;
            await db.put(storeName as 'work' | 'workInfo' | 'tracks', { data, timestamp: Date.now() }, key);
            Logger.debug(`[WorkService] Cached ${storeName} for id ${key}`);
        } catch (err) {
            Logger.warn(`[WorkService] Cache write failed for ${storeName}:${key}`, err);
        }
    }

    private isFresh(timestamp: number, ttl: number): boolean {
        return Date.now() - timestamp < ttl;
    }
}

export const WorkService = new WorkServiceImpl();
