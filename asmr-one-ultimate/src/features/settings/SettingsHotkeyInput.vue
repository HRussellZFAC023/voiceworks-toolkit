<script setup lang="ts">
import { ref, computed } from 'vue';
import { useConfig } from '../../composables/useConfig';
import { useI18n } from '../../composables/useI18n';
import { AppStore } from '../../store/AppStore';
import type { ConfigKey } from '../../types';

const props = defineProps<{
    configKey: ConfigKey;
    label: string;
    sublabel?: string;
    placeholder?: string;
    icon: string;
}>();

const { t } = useI18n();
const value = useConfig(props.configKey);
const listening = ref(false);

/** Pretty-print key names for display */
const DISPLAY_NAMES: Record<string, string> = {
    ' ': 'Space',
    'ArrowLeft': '←',
    'ArrowRight': '→',
    'ArrowUp': '↑',
    'ArrowDown': '↓',
    'Escape': 'Esc',
    'Backspace': '⌫',
    'Delete': 'Del',
    'Enter': '↵',
    'Tab': 'Tab',
};

const displayValue = computed(() => {
    const v = String(value.value || '');
    if (!v) return '';
    if (v === 'Space') return 'Space';
    return DISPLAY_NAMES[v] || v;
});

function startListening() {
    listening.value = true;
}

function onKeydown(e: KeyboardEvent) {
    e.preventDefault();
    e.stopPropagation();

    // Escape cancels without changing
    if (e.key === 'Escape') {
        listening.value = false;
        (e.target as HTMLElement).blur();
        return;
    }

    // Backspace clears the binding
    if (e.key === 'Backspace') {
        value.value = '' as any;
        listening.value = false;
        (e.target as HTMLElement).blur();
        return;
    }

    // Ignore bare modifier keys
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;

    // Normalize space
    const keyValue = e.key === ' ' ? 'Space' : e.key;
    value.value = keyValue as any;
    listening.value = false;
    (e.target as HTMLElement).blur();
}

function onBlur() {
    listening.value = false;
}

function resetToDefault() {
    const defaultVal = AppStore.getConfigDefault(props.configKey);
    value.value = defaultVal;
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
        <div class="q-item__section column q-item__section--side justify-center col-grow" style="flex-direction: row; align-items: center; gap: 4px; justify-content: flex-end;">
            <input
                class="asmr-hotkey-input q-field__native"
                type="text"
                readonly
                :value="listening ? '' : displayValue"
                :placeholder="listening ? t('hotkeyPressKey') : (placeholder || '')"
                :data-key="configKey"
                :data-asmr-input="configKey"
                :aria-label="label"
                :class="{ 'asmr-hotkey-listening': listening }"
                @focus="startListening"
                @keydown="onKeydown"
                @blur="onBlur"
            >
            <button
                v-if="value"
                class="asmr-hotkey-reset"
                :title="t('hotkeyReset')"
                @click="resetToDefault"
                type="button"
            >
                <i class="q-icon notranslate material-icons" style="font-size: 16px;">restart_alt</i>
            </button>
        </div>
    </div>
</template>

<style scoped>
.asmr-hotkey-input {
    text-align: center;
    max-width: 100px;
    cursor: pointer;
    caret-color: transparent;
}
.asmr-hotkey-input:focus {
    outline: 1px solid rgba(255, 255, 255, 0.5);
    border-radius: 4px;
}
.asmr-hotkey-listening {
    animation: pulse-border 1s ease-in-out infinite;
}
@keyframes pulse-border {
    0%, 100% { outline-color: rgba(255, 255, 255, 0.3); }
    50% { outline-color: rgba(255, 255, 255, 0.8); }
}
.asmr-hotkey-reset {
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.5);
    cursor: pointer;
    padding: 2px;
    line-height: 1;
    display: flex;
    align-items: center;
}
.asmr-hotkey-reset:hover {
    color: rgba(255, 255, 255, 0.9);
}
</style>
