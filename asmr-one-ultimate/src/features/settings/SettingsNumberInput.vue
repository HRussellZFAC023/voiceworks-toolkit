<script setup lang="ts">
import { ref, watch } from 'vue';
import { useConfig } from '../../composables/useConfig';
import type { ConfigKey } from '../../types';

const props = defineProps<{
    configKey: ConfigKey;
    label: string;
    sublabel?: string;
    icon: string;
    min: number;
    max: number;
    step?: number;
    /** Shown instead of committing when the entry is not a number in range. */
    invalidText: string;
    /** Optional caption shown below the control (contextual warning). */
    hint?: string;
    hintColor?: string;
}>();

const value = useConfig(props.configKey);
const draft = ref(String(value.value ?? ''));
const invalid = ref(false);

watch(value, (next) => {
    draft.value = String(next ?? '');
    invalid.value = false;
});

function commit(): void {
    const trimmed = draft.value.trim();
    const parsed = Number(trimmed);
    // Out of range is refused, not clamped. Clamping would store a number the
    // user never chose and then report it back as if they had.
    if (!trimmed || !Number.isFinite(parsed) || parsed < props.min || parsed > props.max) {
        invalid.value = true;
        return;
    }
    invalid.value = false;
    draft.value = String(parsed);
    (value as { value: number }).value = parsed;
}

function onInput(event: Event): void {
    draft.value = (event.target as HTMLInputElement).value;
    if (invalid.value) invalid.value = false;
}
</script>

<template>
    <div role="listitem" class="q-py-sm q-item q-item-type row no-wrap asmr-settings-item">
        <div class="q-item__section column q-item__section--avatar q-item__section--side justify-center">
            <i class="q-icon notranslate material-icons asmr-settings-icon" aria-hidden="true">{{ icon }}</i>
        </div>
        <div class="q-item__section column q-item__section--main justify-center">
            <div class="q-item__label"><span class="text-weight-medium">{{ label }}</span></div>
            <div v-if="sublabel" class="q-item__label q-item__label--caption text-caption">{{ sublabel }}</div>
            <input
                class="asmr-input q-field__native asmr-settings-stacked-control asmr-settings-number-input"
                type="number"
                inputmode="decimal"
                :min="min"
                :max="max"
                :step="step || 1"
                :value="draft"
                :data-key="configKey"
                :data-asmr-number="configKey"
                :aria-label="label"
                :aria-invalid="invalid ? 'true' : 'false'"
                @input="onInput"
                @change="commit"
                @keydown.enter.prevent="commit"
            >
            <div
                v-if="invalid"
                class="q-item__label q-item__label--caption text-caption asmr-settings-invalid-text"
                role="alert"
                :data-asmr-invalid="configKey"
            >{{ invalidText }}</div>
            <div
                v-else-if="hint"
                class="q-item__label q-item__label--caption text-caption asmr-settings-number-hint"
                :style="{ color: hintColor || '' }"
            >{{ hint }}</div>
        </div>
    </div>
</template>
