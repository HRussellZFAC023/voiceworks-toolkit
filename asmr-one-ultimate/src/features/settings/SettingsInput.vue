<script setup lang="ts">
import { useConfig } from '../../composables/useConfig';
import type { ConfigKey } from '../../types';

const props = defineProps<{
    configKey: ConfigKey;
    label: string;
    sublabel?: string;
    placeholder?: string;
    icon: string;
}>();

const value = useConfig(props.configKey);

function onInput(event: Event) {
    const target = event.target as HTMLInputElement;
    value.value = target.value as any;
}
</script>

<template>
    <div role="listitem" class="q-py-sm q-item q-item-type row no-wrap q-item--dark">
        <div class="q-item__section column q-item__section--avatar q-item__section--side justify-center">
            <i class="q-icon notranslate material-icons asmr-settings-icon">{{ icon }}</i>
        </div>
        <div class="q-item__section column q-item__section--main justify-center">
            <div class="q-item__label"><span class="text-weight-medium">{{ label }}</span></div>
            <div v-if="sublabel" class="q-item__label q-item__label--caption text-caption">{{ sublabel }}</div>
        </div>
        <div class="q-item__section column q-item__section--side justify-center col-grow">
            <input
                class="asmr-input q-field__native"
                :placeholder="placeholder || ''"
                type="text"
                :value="value"
                :data-key="configKey"
                :data-asmr-input="configKey"
                :aria-label="label"
                @change="onInput"
            >
        </div>
    </div>
</template>
