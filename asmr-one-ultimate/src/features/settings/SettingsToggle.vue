<script setup lang="ts">
import { useConfig } from '../../composables/useConfig';
import type { ConfigKey } from '../../types';

const props = defineProps<{
    configKey: ConfigKey;
    label: string;
    sublabel?: string;
    icon: string;
}>();

const emit = defineEmits<{
    change: [key: ConfigKey, value: boolean];
}>();

const value = useConfig(props.configKey);

function toggle() {
    (value as { value: boolean }).value = !(value as { value: boolean }).value;
    emit('change', props.configKey, value.value as unknown as boolean);
}
</script>

<template>
    <div role="listitem" class="q-py-sm q-item q-item-type row no-wrap q-item--dark">
        <div class="q-item__section column q-item__section--avatar q-item__section--side justify-center">
            <i class="q-icon notranslate material-icons asmr-settings-icon" style="font-size: 28px;">{{ icon }}</i>
        </div>
        <div class="q-item__section column q-item__section--main justify-center">
            <div class="q-item__label"><span class="text-weight-medium">{{ label }}</span></div>
            <div v-if="sublabel" class="q-item__label q-item__label--caption text-caption">
                <span class="text-weight-medium">{{ sublabel }}</span>
            </div>
        </div>
        <div class="q-item__section column q-item__section--side justify-center">
            <div
                tabindex="0"
                role="switch"
                :aria-checked="String(!!value)"
                :aria-label="label"
                class="q-toggle cursor-pointer no-outline row inline no-wrap items-center q-toggle--dark q-toggle--dense asmr-toggle"
                :data-key="configKey"
                :data-asmr-toggle="configKey"
                @click="toggle"
                @keydown.enter.prevent="toggle"
                @keydown.space.prevent="toggle"
            >
                <div
                    aria-hidden="true"
                    class="q-toggle__inner relative-position non-selectable"
                    :class="value ? 'q-toggle__inner--truthy' : 'q-toggle__inner--falsy'"
                >
                    <input type="checkbox" class="hidden q-toggle__native absolute q-ma-none q-pa-none" :checked="!!value">
                    <div class="q-toggle__track"></div>
                    <div class="q-toggle__thumb absolute flex flex-center no-wrap"></div>
                </div>
                <span tabindex="-1" class="no-outline"></span>
            </div>
        </div>
    </div>
</template>
