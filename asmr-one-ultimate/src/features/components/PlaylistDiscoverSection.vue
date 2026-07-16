<script setup lang="ts">
/**
 * PlaylistDiscoverSection — Collapsible "Discover Public Playlists" panel.
 *
 * Renders BELOW the native /playlists grid. Does not hide, replace, or
 * interfere with native search, filter, or pagination.
 *
 * Features:
 *  - Collapsed by default (persisted in GM storage)
 *  - Grid of cards styled with native Quasar classes
 *  - Text search filter (client-side on loaded metadata)
 *  - "Load more" batch loading
 *  - Google search trigger (optional)
 *  - Manual playlist URL addition
 */

import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { useBridge } from '../../composables/useBridge';
import { Logger } from '../../core/Utils';
import { PlaylistDiscoveryService } from '../playlist/PlaylistDiscoveryService';
import { GooglePlaylistScraper } from '../../scrapers/GooglePlaylistScraper';
import type { CachedPlaylistMetadata } from '../playlist/types';

// ---------------------------------------------------------------------------
// Composables & Service
// ---------------------------------------------------------------------------

const { t, format } = useI18n();
const bridge = useBridge();
const service = PlaylistDiscoveryService.getInstance();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BATCH_SIZE = 12;
const COLLAPSE_KEY = 'asmr_ultimate_discover_collapsed';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const collapsed = ref(true);
const textFilter = ref('');
const loadedPlaylists = ref<CachedPlaylistMetadata[]>([]);
const isLoading = ref(false);
const isSearching = ref(false);
const addUrl = ref('');
const addFeedback = ref<{ type: 'ok' | 'err'; text: string } | null>(null);
const searchFeedback = ref<{ type: 'ok' | 'err'; text: string } | null>(null);
let componentMounted = false;
let lifecycleGeneration = 0;
const feedbackTimers = new Set<number>();
const isDark = ref(false);
let themeObserver: MutationObserver | null = null;

function syncTheme(): void {
    isDark.value = document.body.classList.contains('body--dark')
        || document.body.classList.contains('q-dark');
}

function isLifecycleCurrent(generation: number): boolean {
    return componentMounted && generation === lifecycleGeneration;
}

function scheduleFeedbackCleanup(callback: () => void, delayMs: number, generation: number): void {
    if (!isLifecycleCurrent(generation)) return;
    const timer = window.setTimeout(() => {
        feedbackTimers.delete(timer);
        if (isLifecycleCurrent(generation)) callback();
    }, delayMs);
    feedbackTimers.add(timer);
}

/** IDs that have been queued for fetching (to avoid re-fetching) */
const fetchedIds = reactive(new Set<string>());
/** All discovered IDs snapshot (refreshed on expand / after Google search) */
const allIds = ref<string[]>([]);
// ---------------------------------------------------------------------------
// Computed
// ---------------------------------------------------------------------------

const filterCandidates = computed(() => {
    const merged = new Map<string, CachedPlaylistMetadata>();
    for (const playlist of loadedPlaylists.value) {
        merged.set(playlist.id.toLowerCase(), playlist);
    }
    for (const id of allIds.value) {
        const cached = service.getCachedMetadata(id);
        if (cached) {
            merged.set(cached.id.toLowerCase(), cached);
        }
    }
    return Array.from(merged.values());
});

const filteredPlaylists = computed(() => {
    const query = textFilter.value.trim().toLowerCase();
    if (!query) return loadedPlaylists.value;

    const tokens = query.split(/\s+/).filter(Boolean);
    return filterCandidates.value.filter((playlist) => {
        const tags = (playlist.tags || []).join(' ').toLowerCase();
        const haystack = `${playlist.name} ${playlist.user_name} ${tags}`.toLowerCase();
        return tokens.every(token => haystack.includes(token));
    });
});

const hasMore = computed(() => fetchedIds.size < allIds.value.length);

const statusText = computed(() => {
    if (isLoading.value) return t('playlistLoadingMore');
    if (!hasMore.value && loadedPlaylists.value.length > 0) {
        return format('playlistLoadStatusDone', {
            loaded: loadedPlaylists.value.length,
            total: allIds.value.length,
        });
    }
    return format('playlistLoadStatus', {
        loaded: loadedPlaylists.value.length,
        total: allIds.value.length,
    });
});

const fallbackGradient = computed(() =>
    isDark.value
        ? 'linear-gradient(135deg, #3a3a52 0%, #2a2a3e 50%, #1a1a2e 100%)'
        : 'linear-gradient(135deg, #667eea 0%, #764ba2 50%, #f093fb 100%)',
);

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function toggleCollapsed() {
    collapsed.value = !collapsed.value;
    GooglePlaylistScraper.safeSetValue(COLLAPSE_KEY, collapsed.value);
    if (!collapsed.value && loadedPlaylists.value.length === 0) {
        refreshAndLoad();
    }
}

function applyDiscoverySnapshot() {
    allIds.value = service.getDiscoveredIds().filter(id => !service.isFailed(id));
    fetchedIds.clear();

    // Pre-populate from cache
    const cached: CachedPlaylistMetadata[] = [];
    const uncached: string[] = [];
    for (const id of allIds.value) {
        const meta = service.getCachedMetadata(id);
        if (meta) {
            cached.push(meta);
            fetchedIds.add(id.toLowerCase());
        } else {
            uncached.push(id);
        }
    }
    loadedPlaylists.value = cached;

    // Fetch first batch of uncached
    if (uncached.length > 0) {
        void loadNextBatch();
    }
}

async function refreshAndLoad() {
    const generation = lifecycleGeneration;
    // Paint a previously verified snapshot synchronously, then revalidate the
    // one-file catalog in the background. Never crawl every playlist merely
    // because the section was opened.
    applyDiscoverySnapshot();
    try { await service.loadCommunityCatalog(); }
    catch (error) { Logger.debug('[PlaylistDiscoverSection] Community catalog revalidation failed', error); }
    if (!isLifecycleCurrent(generation)) return;
    applyDiscoverySnapshot();
}

async function loadNextBatch() {
    const generation = lifecycleGeneration;
    if (!isLifecycleCurrent(generation)) return;
    if (isLoading.value) return;
    if (service.isRateLimitedNow()) return;

    const remaining = allIds.value.filter((id) => isFetchableMetadataId(id));
    if (remaining.length === 0) return;

    isLoading.value = true;
    const batch = remaining.slice(0, BATCH_SIZE);

    try {
        for await (const meta of service.fetchMetadataBatch(batch, 2, 700)) {
            if (!isLifecycleCurrent(generation)) break;
            fetchedIds.add(meta.id.toLowerCase());
            // Only add if not already in the list (cache pre-populated it)
            if (!loadedPlaylists.value.some(p => p.id.toLowerCase() === meta.id.toLowerCase())) {
                loadedPlaylists.value.push(meta);
            }
        }
        if (!isLifecycleCurrent(generation)) return;
        // Mark IDs as fetched only if we actually have metadata or a permanent failure.
        for (const id of batch) {
            const normalized = id.toLowerCase();
            if (service.getCachedMetadata(normalized) || service.isFailed(normalized)) {
                fetchedIds.add(normalized);
            }
        }
    } catch (e) {
        if (isLifecycleCurrent(generation)) Logger.warn('[PlaylistDiscoverSection] Batch load error:', e);
    } finally {
        if (isLifecycleCurrent(generation)) isLoading.value = false;
    }
}

function isFetchableMetadataId(id: string): boolean {
    const normalized = id.toLowerCase();
    if (fetchedIds.has(normalized)) return false;
    if (service.isFailed(normalized)) return false;
    if (service.isTransientFailed(normalized)) return false;
    return true;
}

async function onGoogleSearch() {
    const generation = lifecycleGeneration;
    if (!isLifecycleCurrent(generation)) return;
    if (isSearching.value || service.isGoogleRateLimited) return;
    isSearching.value = true;
    searchFeedback.value = null;

    try {
        const ids = await service.triggerGoogleSearch((page, found) => {
            if (isLifecycleCurrent(generation)) {
                searchFeedback.value = { type: 'ok', text: format('playlistSearchingPage', { page, found }) };
            }
        });
        if (!isLifecycleCurrent(generation)) return;
        if (ids.length > 0) {
            searchFeedback.value = { type: 'ok', text: format('playlistSearchFound', { count: ids.length }) };
            // Refresh the ID list and load new ones
            allIds.value = service.getDiscoveredIds().filter(id => !service.isFailed(id));
            void loadNextBatch();
        } else {
            searchFeedback.value = {
                type: 'err',
                text: format('playlistDiscoverHint', { action: t('playlistFindMore') }),
            };
        }
    } catch (e) {
        if (isLifecycleCurrent(generation)) {
            searchFeedback.value = { type: 'err', text: t('playlistSearchFailed') };
        }
    } finally {
        if (isLifecycleCurrent(generation)) {
            isSearching.value = false;
            scheduleFeedbackCleanup(() => { searchFeedback.value = null; }, 5000, generation);
        }
    }
}

function onAddPlaylist() {
    const generation = lifecycleGeneration;
    if (!isLifecycleCurrent(generation)) return;
    if (!addUrl.value.trim()) return;
    const id = service.addManualPlaylist(addUrl.value);
    if (id) {
        addFeedback.value = { type: 'ok', text: t('playlistAddedBadge') };
        addUrl.value = '';
        allIds.value = service.getDiscoveredIds().filter(id2 => !service.isFailed(id2));
        // Immediately fetch metadata for the new one
        service.fetchMetadata(id).then(meta => {
            if (!isLifecycleCurrent(generation)) return;
            if (meta && !loadedPlaylists.value.some(p => p.id === meta.id)) {
                loadedPlaylists.value.unshift(meta);
            }
            if (meta) {
                // Sharing is intentionally UUID-only. The Worker repeats the
                // live existence/publicity check before accepting it.
                void service.submitCommunityPlaylist(id).catch(error => {
                    Logger.debug('[PlaylistDiscoverSection] Public catalog submission was not accepted', error);
                });
            }
        });
    } else {
        addFeedback.value = { type: 'err', text: t('playlistAddInvalid') };
    }
    scheduleFeedbackCleanup(() => { addFeedback.value = null; }, 3000, generation);
}

function randomize() {
    const arr = [...loadedPlaylists.value];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    loadedPlaylists.value = arr;
}

function navigateToPlaylist(id: string) {
    try {
        bridge.router?.push({ path: '/playlist', query: { id } });
    } catch {
        window.location.hash = `#/playlist?id=${id}`;
    }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

onMounted(() => {
    componentMounted = true;
    syncTheme();
    themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    // Restore collapse state
    const stored = GooglePlaylistScraper.safeGetValue(COLLAPSE_KEY, true);
    collapsed.value = stored !== false; // default collapsed

    if (!collapsed.value) {
        refreshAndLoad();
    }
});

onUnmounted(() => {
    componentMounted = false;
    lifecycleGeneration++;
    themeObserver?.disconnect();
    themeObserver = null;
    for (const timer of feedbackTimers) window.clearTimeout(timer);
    feedbackTimers.clear();
    isLoading.value = false;
    isSearching.value = false;
});
</script>

<template>
    <section id="asmr-ultimate-public-playlists" class="asmr-discover-section q-mt-lg">
        <!-- Collapsible Header -->
        <div
            class="asmr-discover-header row items-center q-px-sm q-py-xs cursor-pointer"
            data-testid="playlist-discover-toggle"
            role="button"
            tabindex="0"
            :aria-expanded="!collapsed"
            @click="toggleCollapsed"
            @keydown.enter.prevent="toggleCollapsed"
            @keydown.space.prevent="toggleCollapsed"
        >
            <span class="material-icons" style="font-size: 20px; opacity: 0.7; margin-right: 8px;">
                {{ collapsed ? 'expand_more' : 'expand_less' }}
            </span>
            <span class="text-subtitle1 text-weight-medium">
                {{ t('playlistPublicTitle') }}
            </span>
            <span id="public-playlist-count" class="text-caption q-ml-sm" style="opacity: 0.6;">
                ({{ allIds.length }})
            </span>
        </div>

        <!-- Expanded Content -->
        <div v-if="!collapsed" class="q-mt-sm" data-testid="playlist-discover-content">
            <!-- Controls Row -->
            <div class="row items-center q-gutter-sm q-px-sm q-mb-md" style="flex-wrap: wrap;">
                <!-- Text Search -->
                <input
                    v-model="textFilter"
                    type="text"
                    :placeholder="t('playlistFilterPlaceholder')"
                    class="asmr-discover-search"
                    data-testid="playlist-discover-filter"
                    style="max-width: 220px;"
                />

                <!-- Status -->
                <span id="public-playlist-status" class="text-caption" style="opacity: 0.6;">{{ statusText }}</span>

                <div style="flex: 1 1 auto;" />

                <!-- Randomize Button -->
                <button
                    class="asmr-discover-btn"
                    id="playlists-randomize-btn"
                    :disabled="loadedPlaylists.length < 2"
                    @click="randomize"
                >
                    <span class="material-icons" style="font-size: 16px;">shuffle</span>
                    {{ t('playlistRandomize') }}
                </button>

                <!-- Google Search Button -->
                <button
                    class="asmr-discover-btn"
                    id="search-google-btn"
                    :disabled="isSearching || service.isGoogleRateLimited"
                    @click="onGoogleSearch"
                >
                    <span class="material-icons" style="font-size: 16px;">search</span>
                    {{ isSearching ? t('playlistSearchingButton') : t('playlistFindMore') }}
                </button>

                <!-- Add URL -->
                <div class="row items-center q-gutter-xs" style="flex-wrap: nowrap;">
                    <input
                        v-model="addUrl"
                        type="text"
                        :placeholder="t('playlistAddPlaceholder')"
                        class="asmr-discover-search"
                        style="max-width: 200px;"
                        @keyup.enter="onAddPlaylist"
                    />
                    <button class="asmr-discover-btn" @click="onAddPlaylist">{{ t('playlistAddButton') }}</button>
                </div>
            </div>

            <!-- Feedback -->
            <div v-if="searchFeedback" class="text-caption q-px-sm q-mb-sm" :style="{ color: searchFeedback.type === 'ok' ? '#4caf50' : '#ff5252' }">
                {{ searchFeedback.text }}
            </div>
            <div v-if="addFeedback" class="text-caption q-px-sm q-mb-sm" :style="{ color: addFeedback.type === 'ok' ? '#4caf50' : '#ff5252' }">
                {{ addFeedback.text }}
            </div>

            <!-- Playlist Grid -->
            <div id="public-playlists-grid" class="row q-col-gutter-x-md q-col-gutter-y-md q-px-sm">
                <div
                    v-for="playlist in filteredPlaylists"
                    :key="playlist.id"
                    class="col-6 col-sm-4 col-md-3"
                >
                    <div
                        :class="isDark ? 'q-card q-card--dark q-dark' : 'q-card'"
                        class="cursor-pointer"
                        style="border-radius: 8px; overflow: hidden;"
                        @click="navigateToPlaylist(playlist.id)"
                    >
                        <!-- Cover -->
                        <div
                            class="asmr-discover-cover"
                            :style="{
                                background: playlist.coverUrl
                                    ? `url(${playlist.coverUrl}) center/cover no-repeat`
                                    : fallbackGradient,
                            }"
                        >
                            <div class="asmr-discover-cover-badge">
                                {{ format('playlistWorksCount', { count: playlist.worksCount }) }}
                            </div>
                        </div>
                        <!-- Info -->
                        <div class="q-pa-sm">
                            <div class="text-subtitle2 ellipsis">{{ playlist.name }}</div>
                            <div class="text-caption ellipsis" style="opacity: 0.6;">
                                {{ playlist.user_name }}
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Empty State -->
            <div v-if="filteredPlaylists.length === 0 && !isLoading" class="text-center text-caption q-pa-lg" style="opacity: 0.5;">
                {{ textFilter
                    ? t('playlistNoFilterMatches')
                    : format('playlistDiscoverHint', { action: t('playlistFindMore') }) }}
            </div>

            <!-- Load More -->
            <div class="text-center q-py-md">
                <button
                    v-if="hasMore"
                    class="asmr-discover-btn"
                    :disabled="isLoading"
                    @click="loadNextBatch"
                >
                    {{ isLoading ? t('playlistLoadingMore') : t('playlistLoadMore') }}
                </button>
            </div>
        </div>
    </section>
</template>

<style scoped>
.asmr-discover-section {
    border-top: 1px solid rgba(128, 128, 128, 0.15);
    padding-top: 8px;
}

.asmr-discover-header {
    user-select: none;
    border-radius: 6px;
    transition: background 0.15s;
}

.asmr-discover-header:hover {
    background: rgba(128, 128, 128, 0.08);
}

.asmr-discover-search {
    padding: 4px 10px;
    border-radius: 6px;
    border: 1px solid var(--asmr-border-color, rgba(128, 128, 128, 0.3));
    background: var(--asmr-bg-secondary, rgba(128, 128, 128, 0.08));
    color: inherit;
    font-size: 0.85rem;
    outline: none;
    min-width: 0;
    flex: 0 1 auto;
}

.asmr-discover-search:focus {
    border-color: var(--asmr-accent, #1976d2);
}

.asmr-discover-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 12px;
    min-height: 30px;
    border-radius: 6px;
    border: 1px solid var(--asmr-border-color, rgba(128, 128, 128, 0.3));
    background: var(--asmr-bg-secondary, rgba(128, 128, 128, 0.08));
    color: inherit;
    font-size: 0.85rem;
    cursor: pointer;
    transition: background 0.15s;
    white-space: nowrap;
}

.asmr-discover-btn:hover:not(:disabled) {
    background: var(--asmr-bg-tertiary, rgba(128, 128, 128, 0.15));
}

.asmr-discover-btn:disabled {
    opacity: 0.5;
    cursor: default;
}

.asmr-discover-cover {
    position: relative;
    width: 100%;
    padding-top: 56.25%; /* 16:9 */
    background-size: cover;
    background-position: center;
}

.asmr-discover-cover-badge {
    position: absolute;
    bottom: 4px;
    right: 4px;
    padding: 1px 6px;
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
    font-size: 0.7rem;
}
</style>
