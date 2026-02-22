<script setup lang="ts">
import type { FuriganaSegment } from '../../lib/jpdb-segments';

defineProps<{
    karaokeHighlightStart: number;
    karaokeSplitIndex: number;
    jpdbEnabled: boolean;
    segmentMode: boolean;
    primaryText: string;
    karaokePast: string;
    karaokeCurrent: string;
    karaokeUpcoming: string;
    furiganaPast: FuriganaSegment[];
    furiganaCurrent: FuriganaSegment[];
    furiganaUpcoming: FuriganaSegment[];
    furiganaAll: FuriganaSegment[];
}>();
</script>

<template>
    <template v-if="karaokeHighlightStart >= 0 && karaokeSplitIndex >= 0 && jpdbEnabled">
        <span class="karaoke-past">
            <template v-for="(seg, i) in furiganaPast" :key="`p-${i}`">
                <span
                    v-if="seg.vid !== undefined"
                    class="jpdb-word"
                    :class="[seg.stateClass, seg.pitchClass]"
                    :data-vid="seg.vid"
                    :data-sid="seg.sid"
                    data-jpdb="true"
                >
                    <ruby v-if="seg.rt">{{ seg.base }}<rt class="jpdb-furi">{{ seg.rt }}</rt></ruby>
                    <template v-else>{{ seg.base }}</template>
                </span>
                <template v-else>{{ seg.base }}</template>
            </template>
        </span>

        <span class="karaoke-spoken">
            <template v-for="(seg, i) in furiganaCurrent" :key="`c-${i}`">
                <span
                    v-if="seg.vid !== undefined"
                    class="jpdb-word"
                    :class="[seg.stateClass, seg.pitchClass]"
                    :data-vid="seg.vid"
                    :data-sid="seg.sid"
                    data-jpdb="true"
                >
                    <ruby v-if="seg.rt">{{ seg.base }}<rt class="jpdb-furi">{{ seg.rt }}</rt></ruby>
                    <template v-else>{{ seg.base }}</template>
                </span>
                <template v-else>{{ seg.base }}</template>
            </template>
        </span>

        <span class="karaoke-upcoming" :class="{ 'karaoke-hidden': !segmentMode }">
            <template v-for="(seg, i) in furiganaUpcoming" :key="`u-${i}`">
                <span
                    v-if="seg.vid !== undefined"
                    class="jpdb-word"
                    :class="[seg.stateClass, seg.pitchClass]"
                    :data-vid="seg.vid"
                    :data-sid="seg.sid"
                    data-jpdb="true"
                >
                    <ruby v-if="seg.rt">{{ seg.base }}<rt class="jpdb-furi">{{ seg.rt }}</rt></ruby>
                    <template v-else>{{ seg.base }}</template>
                </span>
                <template v-else>{{ seg.base }}</template>
            </template>
        </span>
    </template>

    <template v-else-if="jpdbEnabled && furiganaAll.length > 0">
        <template v-for="(seg, i) in furiganaAll" :key="`a-${i}`">
            <span
                v-if="seg.vid !== undefined"
                class="jpdb-word"
                :class="[seg.stateClass, seg.pitchClass]"
                :data-vid="seg.vid"
                :data-sid="seg.sid"
                data-jpdb="true"
            >
                <ruby v-if="seg.rt">{{ seg.base }}<rt class="jpdb-furi">{{ seg.rt }}</rt></ruby>
                <template v-else>{{ seg.base }}</template>
            </span>
            <template v-else>{{ seg.base }}</template>
        </template>
    </template>

    <template v-else-if="karaokeHighlightStart >= 0 && karaokeSplitIndex >= 0">
        <span class="karaoke-past">{{ karaokePast }}</span>
        <span class="karaoke-spoken">{{ karaokeCurrent }}</span>
        <span class="karaoke-upcoming" :class="{ 'karaoke-hidden': !segmentMode }">{{ karaokeUpcoming }}</span>
    </template>

    <template v-else>{{ primaryText }}</template>
</template>
