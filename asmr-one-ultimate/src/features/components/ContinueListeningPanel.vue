<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { useBridge } from '../../composables/useBridge';
import { ReviewApi } from '../../api';
import { Logger } from '../../core/Logger';
import type { Work, WorkTag } from '../../types/api';

const { t } = useI18n();
const bridge = useBridge();

const works = ref<Work[]>([]);
const loading = ref(true);
const scrollContainer = ref<HTMLElement | null>(null);

// Mouse drag state
let isDragging = false;
let startX = 0;
let scrollLeft = 0;
let hasDragged = false;

function getRjCode(id: number): string {
    return `RJ${String(id).padStart(6, '0')}`;
}

function getTagName(tag: WorkTag): string {
    const lang = navigator.language;
    if (lang.startsWith('zh') && tag.i18n?.['zh-cn']?.name) return tag.i18n['zh-cn'].name;
    if (lang.startsWith('ja') && tag.i18n?.['ja-jp']?.name) return tag.i18n['ja-jp'].name;
    if (tag.i18n?.['en-us']?.name) return tag.i18n['en-us'].name;
    return tag.name;
}

function formatDuration(seconds: number): string {
    if (!seconds) return '';
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    return `${(seconds / 3600).toFixed(1)}h`;
}

function navigateToWork(id: number): void {
    if (hasDragged) return;
    const rj = getRjCode(id);
    if (bridge.router?.push) {
        bridge.router.push(`/work/${rj}`);
    } else {
        window.location.hash = `#/work/${rj}`;
    }
}

function navigateToCircle(id: number, event: Event): void {
    if (hasDragged) { event.preventDefault(); return; }
    event.stopPropagation();
    if (bridge.router?.push) {
        bridge.router.push(`/circle/${id}`);
    }
}

function navigateToTag(tagId: number, event: Event): void {
    if (hasDragged) { event.preventDefault(); return; }
    event.stopPropagation();
    if (bridge.router?.push) {
        bridge.router.push({ path: '/works', query: { tagId: String(tagId) } });
    }
}

function navigateToVa(vaId: string, event: Event): void {
    if (hasDragged) { event.preventDefault(); return; }
    event.stopPropagation();
    if (bridge.router?.push) {
        bridge.router.push(`/va/${vaId}`);
    }
}

// Mouse drag scrolling
function onMouseDown(e: MouseEvent): void {
    const el = scrollContainer.value;
    if (!el) return;
    isDragging = true;
    hasDragged = false;
    startX = e.pageX - el.offsetLeft;
    scrollLeft = el.scrollLeft;
    el.style.cursor = 'grabbing';
    el.style.userSelect = 'none';
}

function onMouseMove(e: MouseEvent): void {
    if (!isDragging) return;
    const el = scrollContainer.value;
    if (!el) return;
    e.preventDefault();
    const x = e.pageX - el.offsetLeft;
    const walk = x - startX;
    if (Math.abs(walk) > 5) hasDragged = true;
    el.scrollLeft = scrollLeft - walk;
}

function onMouseUp(): void {
    if (!isDragging) return;
    isDragging = false;
    const el = scrollContainer.value;
    if (el) {
        el.style.cursor = 'grab';
        el.style.userSelect = '';
    }
    // Reset hasDragged after a tick so click handlers can check it
    setTimeout(() => { hasDragged = false; }, 0);
}

async function fetchListeningWorks(): Promise<void> {
    try {
        const data = await ReviewApi.getReviews({
            filter: 'listening',
            page: 1,
            order: 'updated_at',
            sort: 'desc',
        });

        const rawWorks = data?.works || [];
        works.value = rawWorks.slice(0, 20);
    } catch (err) {
        Logger.debug('[ContinueListening] Failed to fetch listening works:', err);
    } finally {
        loading.value = false;
    }
}

onMounted(() => {
    fetchListeningWorks();
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
});

onUnmounted(() => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
});
</script>

<template>
    <div v-if="!loading && works.length > 0" class="q-pt-lg q-px-md">
        <a href="/favourites/progress/listening" style="color: inherit; text-decoration: none;">
            <h2 class="text-h5 q-mb-sm asmr-continue-title" style="font-weight: normal; display: flex; align-items: center; gap: 8px;">
                <i class="q-icon material-icons" style="font-size: 24px; color: #42a5f5;">headset</i>
                {{ t('continueListeningTitle') }} &gt;
            </h2>
        </a>

        <div class="justify-center">
            <div
                ref="scrollContainer"
                class="q-pa-md asmr-continue-listening-scroll"
                @mousedown="onMouseDown"
            >
                <div class="row q-col-gutter-x-md no-wrap">
                    <div
                        v-for="work in works"
                        :key="work.id"
                        class="col-xl-2 col-lg-2 col-md-3 col-xs-6 col-sm-4"
                        style="min-width: 280px; max-width: 418px;"
                    >
                        <div class="fit q-card asmr-continue-card">
                            <!-- Cover -->
                            <a :href="`/work/${getRjCode(work.id)}`" @click.prevent="navigateToWork(work.id)">
                                <div role="img" :aria-label="`Cover of ${work.title}`" class="q-img overflow-hidden q-img--menu" style="max-width: 560px;">
                                    <div style="padding-bottom: 75%;"></div>
                                    <div
                                        class="q-img__image absolute-full"
                                        :style="{ backgroundSize: 'cover', backgroundPosition: '50% 50%', backgroundImage: `url(${work.mainCoverUrl})` }"
                                    >
                                        <img :src="work.mainCoverUrl" aria-hidden="true" class="absolute-full fit">
                                    </div>
                                    <div class="q-img__content absolute-full">
                                        <!-- RJ code chip (top-left) -->
                                        <div class="absolute-top-left transparent" style="padding: 0;">
                                            <div class="q-chip row inline no-wrap items-center q-ma-sm bg-brown q-chip--colored q-chip--dense q-chip--square asmr-continue-colored-chip">
                                                <div class="q-chip__content col row no-wrap items-center q-anchor--skip">{{ getRjCode(work.id) }}</div>
                                            </div>
                                        </div>
                                        <!-- Date (bottom-right) -->
                                        <div v-if="work.release" class="absolute-bottom-right" style="padding: 2px;">{{ work.release }}</div>
                                        <!-- Playlist add button (top-right) -->
                                        <div class="absolute-top-right transparent" style="padding: 0px !important;">
                                            <div class="absolute-top-right transparent like-btn" style="padding: 4px;">
                                                <div class="q-chip row inline no-wrap items-center bg-brown q-chip--dense q-chip--square asmr-continue-colored-chip">
                                                    <div class="q-chip__content col row no-wrap items-center q-anchor--skip">
                                                        <i class="q-icon material-icons" style="font-size: 24px;">playlist_add</i>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </a>

                            <hr class="q-separator q-separator--horizontal asmr-continue-separator">

                            <div>
                                <!-- Title -->
                                <div class="q-mx-sm text-weight-medium ellipsis-3-lines">
                                    <a
                                        :href="`/work/${getRjCode(work.id)}`"
                                        style="color: inherit;"
                                        :title="work.title"
                                        :data-asmrtag="work.title"
                                        data-asmrtag-state="pending"
                                        @click.prevent="navigateToWork(work.id)"
                                    >{{ work.title }}</a>
                                </div>

                                <!-- Tags + Circle + VAs + Duration -->
                                <div class="q-ma-xs">
                                    <!-- Tags -->
                                    <div
                                        v-for="tag in work.tags"
                                        :key="tag.id"
                                        style="display: inline-block; cursor: pointer;"
                                        @click="navigateToTag(tag.id, $event)"
                                    >
                                        <div class="q-chip row inline no-wrap items-center chip shadow-0 text-weight-medium asmr-continue-neutral-chip" style="font-size: 10px;">
                                            <div class="q-chip__content col row no-wrap items-center q-anchor--skip">
                                                <span class="chip-content">{{ getTagName(tag) }}</span>
                                            </div>
                                        </div>
                                    </div>

                                    <!-- Circle (orange chip) -->
                                    <div
                                        v-if="work.circle?.name"
                                        style="display: inline; cursor: pointer;"
                                        @click="navigateToCircle(work.circle.id, $event)"
                                    >
                                        <div class="q-chip row inline no-wrap items-center chip shadow-0 text-weight-medium bg-orange asmr-continue-colored-chip" style="font-size: 10px;">
                                            <div class="q-chip__content col row no-wrap items-center q-anchor--skip">
                                                <span class="chip-content ellipsis">{{ work.circle.name }}</span>
                                            </div>
                                        </div>
                                    </div>

                                    <!-- VAs (green chips) -->
                                    <div
                                        v-for="va in work.vas"
                                        :key="va.id"
                                        style="display: inline-block; cursor: pointer;"
                                        @click="navigateToVa(va.id, $event)"
                                    >
                                        <div class="q-chip row inline no-wrap items-center chip shadow-0 text-weight-medium bg-green q-chip--colored asmr-continue-colored-chip" style="font-size: 10px;" :data-asmrtag="va.name" data-asmrtag-state="pending">
                                            <div class="q-chip__content col row no-wrap items-center q-anchor--skip">{{ va.name }}</div>
                                        </div>
                                    </div>

                                    <!-- Duration (grey chip) -->
                                    <div v-if="work.duration" class="q-chip row inline no-wrap items-center chip shadow-0 text-weight-medium asmr-continue-neutral-chip" style="font-size: 10px;">
                                        <i class="q-chip__icon q-chip__icon--left q-icon material-icons">schedule</i>
                                        <div class="q-chip__content col row no-wrap items-center q-anchor--skip">
                                            <span class="chip-content">{{ formatDuration(work.duration) }}</span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
/* Horizontal scroll container - matches host app's HorizontalWorkList pattern */
.asmr-continue-listening-scroll {
    overflow-x: auto;
    cursor: grab;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;         /* Firefox */
    -ms-overflow-style: none;      /* IE/Edge */
}
.asmr-continue-listening-scroll::-webkit-scrollbar {
    display: none;                 /* Chrome/Safari */
}

.asmr-continue-title,
.asmr-continue-card {
    color: var(--asmr-text-primary);
}

.asmr-continue-card {
    background: var(--asmr-bg-primary);
    border-color: var(--asmr-border-color);
}

.asmr-continue-separator {
    background: var(--asmr-border-color);
}

.asmr-continue-neutral-chip {
    color: var(--asmr-text-secondary);
    background: var(--asmr-bg-tertiary);
}

.asmr-continue-colored-chip {
    color: #fff;
}
</style>
