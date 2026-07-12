<script setup lang="ts">
import { useConfig } from '../../composables/useConfig';
import type { ConfigKey } from '../../types';

interface SettingsSelectOption {
    value: string;
    label: string;
}

const props = defineProps<{
    configKey: ConfigKey;
    label: string;
    sublabel?: string;
    icon: string;
    options: SettingsSelectOption[];
    /** Optional caption shown below the control (e.g. a contextual warning). */
    hint?: string;
    /** Optional colour for the hint caption. */
    hintColor?: string;
}>();

const value = useConfig(props.configKey);

function onChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    (value as { value: string }).value = target.value;
}
</script>

<template>
    <div role="listitem" class="q-py-sm q-item q-item-type row no-wrap asmr-settings-item">
        <div class="q-item__section column q-item__section--avatar q-item__section--side justify-center">
            <i class="q-icon notranslate material-icons asmr-settings-icon">{{ icon }}</i>
        </div>
        <div class="q-item__section column q-item__section--main justify-center">
            <div class="q-item__label"><span class="text-weight-medium">{{ label }}</span></div>
            <div v-if="sublabel" class="q-item__label q-item__label--caption text-caption">{{ sublabel }}</div>
            <div
                v-if="hint"
                class="q-item__label q-item__label--caption text-caption asmr-settings-select-hint"
                :style="{ color: hintColor || '' }"
            >{{ hint }}</div>
        </div>
        <div class="q-item__section column q-item__section--side justify-center col-grow">
            <select
                class="asmr-input asmr-select q-field__native"
                :value="value"
                :data-key="configKey"
                :data-asmr-select="configKey"
                :aria-label="label"
                @change="onChange"
            >
                <option
                    v-for="option in options"
                    :key="option.value"
                    :value="option.value"
                >{{ option.label }}</option>
            </select>
        </div>
    </div>
</template>
