<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { I18n } from '../../core/Utils';
import { EventBus } from '../../core/EventBus';
import type { JoiState } from '../joiDecisionUtils';

type JoiUiState = {
    state: JoiState;
    instructionKey: string;
    contextIntensity: number;
    countdownSec: number;
};

const props = defineProps<{
    uiState: JoiUiState;
}>();

const emit = defineEmits<{
    close: [];
}>();

const i18nTick = ref(0);
let cleanupLang: (() => void) | null = null;

onMounted(() => {
    cleanupLang = EventBus.on('lang:change', () => {
        i18nTick.value++;
    });
});

onUnmounted(() => {
    cleanupLang?.();
    cleanupLang = null;
});

const stateLabel = computed(() => {
    void i18nTick.value;
    const keyByState: Record<JoiState, string> = {
        idle: 'joiIdle',
        go: 'joiGo',
        stop: 'joiStop',
        edge: 'joiEdge',
        cum: 'joiCum',
        denied: 'joiDenied',
        ruined: 'joiRuined',
    };
    return I18n.t(keyByState[props.uiState.state]);
});

const instructionText = computed(() => {
    void i18nTick.value;
    return I18n.t(props.uiState.instructionKey);
});

const closeTitle = computed(() => {
    void i18nTick.value;
    return I18n.t('joiToggle');
});

const countdownText = computed(() => {
    void i18nTick.value;
    if (props.uiState.countdownSec <= 0) return '';
    return I18n.format('joiResuming', { sec: props.uiState.countdownSec });
});
</script>

<template>
    <div class="asmr-joi-status">
        <span class="asmr-joi-label">{{ stateLabel }}</span>
    </div>
    <div class="asmr-joi-instruction">{{ instructionText }}</div>
    <div class="asmr-joi-context">
        <span v-for="dot in 3" :key="dot" class="asmr-joi-context-dot" :class="{ active: dot <= uiState.contextIntensity }" />
    </div>
    <div class="asmr-joi-countdown" :style="{ display: uiState.countdownSec > 0 ? '' : 'none' }">{{ countdownText }}</div>
    <div class="asmr-joi-progress">
        <div class="asmr-joi-ring"></div>
    </div>
    <button class="asmr-joi-close" :title="closeTitle" @click.stop.prevent="emit('close')">
        <i class="material-icons" aria-hidden="true">close</i>
    </button>
</template>
