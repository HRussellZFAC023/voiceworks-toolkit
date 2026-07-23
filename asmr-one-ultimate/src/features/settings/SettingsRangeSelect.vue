<script setup lang="ts">
import { computed } from 'vue';
import { useConfig } from '../../composables/useConfig';
import type { ConfigKey } from '../../types';

export interface SettingsRangeOption {
    value: string | number;
    label: string;
}

const props = defineProps<{
    configKey: ConfigKey;
    label: string;
    sublabel?: string;
    icon: string;
    options: SettingsRangeOption[];
    hint?: string;
    hintColor?: string;
}>();

const value = useConfig(props.configKey);
const selectedIndex = computed(() => {
    const index = props.options.findIndex(option => String(option.value) === String(value.value));
    return index >= 0 ? index : 0;
});
const selectedLabel = computed(() => props.options[selectedIndex.value]?.label ?? '');

function select(index: number): void {
    const option = props.options[index];
    if (option) (value as { value: string | number }).value = option.value;
}

function onInput(event: Event): void {
    select(Number((event.target as HTMLInputElement).value));
}
</script>

<template>
    <div role="listitem" class="q-py-sm q-item q-item-type row no-wrap asmr-settings-item asmr-range-setting">
        <div class="q-item__section column q-item__section--avatar q-item__section--side justify-center">
            <i class="q-icon notranslate material-icons asmr-settings-icon" aria-hidden="true">{{ icon }}</i>
        </div>
        <div class="q-item__section column q-item__section--main justify-center">
            <div class="q-item__label"><span class="text-weight-medium">{{ label }}</span></div>
            <div v-if="sublabel" class="q-item__label q-item__label--caption text-caption">{{ sublabel }}</div>
            <div class="asmr-range-control">
                <div class="asmr-range-selected text-weight-medium">{{ selectedLabel }}</div>
                <input
                    class="asmr-range-input"
                    type="range"
                    min="0"
                    :max="Math.max(0, options.length - 1)"
                    step="1"
                    :value="selectedIndex"
                    :data-key="configKey"
                    :data-asmr-range="configKey"
                    :aria-label="label"
                    :aria-valuetext="selectedLabel"
                    @input="onInput"
                >
                <div class="asmr-range-ticks">
                    <button
                        v-for="(option, index) in options"
                        :key="option.value"
                        type="button"
                        :class="{ active: index === selectedIndex }"
                        :aria-pressed="index === selectedIndex"
                        @click="select(index)"
                    >{{ option.label }}</button>
                </div>
            </div>
            <div
                v-if="hint"
                class="q-item__label q-item__label--caption text-caption asmr-settings-range-hint"
                :style="{ color: hintColor || '' }"
            >{{ hint }}</div>
        </div>
    </div>
</template>

<style scoped>
.asmr-range-control {
    margin-top: 10px;
    min-width: 0;
}

.asmr-range-selected {
    color: var(--asmr-accent);
    margin-bottom: 2px;
}

.asmr-range-input {
    width: 100%;
    min-height: 28px;
    margin: 0;
    accent-color: var(--asmr-accent);
    cursor: pointer;
}

.asmr-range-input:focus-visible {
    outline: 2px solid var(--asmr-accent);
    outline-offset: 2px;
}

.asmr-range-ticks {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: 1fr;
    gap: 6px;
    color: var(--asmr-text-secondary);
}

.asmr-range-ticks button {
    appearance: none;
    border: 0;
    padding: 2px;
    overflow-wrap: anywhere;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 0.7rem;
    line-height: 1.2;
    text-align: center;
    cursor: pointer;
}

.asmr-range-ticks button.active {
    color: var(--asmr-accent);
    font-weight: 600;
}

@media (max-width: 600px) {
    .asmr-range-ticks {
        gap: 2px;
    }

    .asmr-range-ticks button {
        font-size: 0.62rem;
    }
}
</style>
