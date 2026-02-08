/**
 * WorkSelector - Selects next work for Radio Mode
 *
 * Handles random work selection with deduplication and history tracking.
 */

import { KikoeruBridge } from '../../infrastructure/KikoeruBridge';
import { Logger } from '../../core/Utils';
import type { WorkSummary } from '../../types';

interface WorksApiResponse {
    works?: WorkSummary[];
    pagination?: {
        currentPage: number;
        pageSize: number;
        totalCount: number;
    };
}

const MAX_RECENT_WORKS = 8;
const MAX_SELECTION_ATTEMPTS = 6;

export class WorkSelector {
    private bridge: KikoeruBridge;
    private recentWorkIds: string[] = [];

    constructor() {
        this.bridge = KikoeruBridge.getInstance();
    }

    /**
     * Select the next random work, avoiding recently played works
     */
    async selectRandomWork(currentWorkId?: string): Promise<WorkSummary | null> {
        let lastCandidate: WorkSummary | null = null;

        for (let attempt = 0; attempt < MAX_SELECTION_ATTEMPTS; attempt++) {
            try {
                // Use the host app's axios client which has proper auth/cookies
                const response = await this.bridge.api.getWorks<WorksApiResponse>({
                    order: 'betterRandom',
                });

                Logger.debug('[WorkSelector] API response:', {
                    hasWorks: !!response?.works,
                    worksCount: response?.works?.length ?? 0,
                    pagination: response?.pagination,
                    responseType: typeof response,
                });

                const works = response?.works;

                if (!works || works.length === 0) {
                    Logger.warn('[WorkSelector] No works returned from API. Response:', 
                        JSON.stringify(response)?.slice(0, 200));
                    break;
                }

                const candidate = works[0] as WorkSummary;
                if (!candidate) break;

                lastCandidate = candidate;
                const candidateId = String(candidate.id);

                // Check if we should skip this work
                if (candidateId === currentWorkId || this.isRecentlyPlayed(candidateId)) {
                    Logger.log(`[WorkSelector] Skipping recent work ${candidateId} (attempt ${attempt + 1}/${MAX_SELECTION_ATTEMPTS})`);
                    continue;
                }

                return candidate;
            } catch (error) {
                Logger.error('[WorkSelector] Failed to fetch works:', error);
                break;
            }
        }

        // Return last candidate as fallback (may be recently played)
        if (lastCandidate) {
            Logger.warn('[WorkSelector] All candidates were recently played, returning last candidate as fallback');
        }
        return lastCandidate;
    }

    /**
     * Find the next work in a playlist (sequential mode)
     */
    findNextInPlaylist(currentWorkId: string): string | null {
        const store = this.bridge.store;

        // Check various store locations for work lists
        const workLists = [
            store.state.View?.works,
            store.state.Playlist?.works,
            store.state.Works?.list,
        ];

        for (const list of workLists) {
            if (!Array.isArray(list) || list.length === 0) continue;

            const currentIndex = list.findIndex((w) => String(w.id) === currentWorkId);
            if (currentIndex !== -1 && currentIndex < list.length - 1) {
                return String(list[currentIndex + 1].id);
            }
        }

        // DOM fallback
        return this.findNextInDOM(currentWorkId);
    }

    /**
     * Remember a work as recently played
     */
    rememberWork(workId: string): void {
        if (!workId) return;

        this.recentWorkIds = [
            workId,
            ...this.recentWorkIds.filter((id) => id !== workId),
        ].slice(0, MAX_RECENT_WORKS);
    }

    /**
     * Check if a work was recently played
     */
    isRecentlyPlayed(workId: string): boolean {
        return this.recentWorkIds.includes(workId);
    }

    /**
     * Clear recent work history
     */
    clearHistory(): void {
        this.recentWorkIds = [];
    }

    /**
     * Get recent work IDs
     */
    getRecentWorkIds(): string[] {
        return [...this.recentWorkIds];
    }

    // =========================================================================
    // Private Methods
    // =========================================================================

    private findNextInDOM(currentWorkId: string): string | null {
        try {
            const currentItem = document.querySelector(
                `.q-item[href*="${currentWorkId}"], .q-card[href*="${currentWorkId}"]`
            );

            if (!currentItem) return null;

            const nextItem = currentItem.nextElementSibling;
            if (!nextItem) return null;

            const link = nextItem.matches('a') ? nextItem : nextItem.querySelector('a');
            const href = link?.getAttribute('href');
            const match = href?.match(/\/work\/(\w+)/);

            return match?.[1] || null;
        } catch (error) {
            Logger.warn('[WorkSelector] DOM fallback failed:', error);
            return null;
        }
    }
}
