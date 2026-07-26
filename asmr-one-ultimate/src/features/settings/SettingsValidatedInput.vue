<script lang="ts">
/**
 * Shape check for a Hugging Face repo id (`owner/name`).
 *
 * Deliberately a shape check only: it rejects input that could never address a
 * repo, and accepts everything else so an experimental repo is never blocked by
 * this plugin's idea of which models exist. An empty string is not a valid id;
 * callers that treat empty as "unset" test for that separately.
 */
const HF_MODEL_ID_RE = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;

export function isHuggingFaceModelId(value: unknown): boolean {
    const trimmed = String(value ?? '').trim();
    if (!trimmed || trimmed.length > 128) return false;
    // `..` would escape the repo path when the id is interpolated into a URL.
    if (trimmed.includes('..')) return false;
    return HF_MODEL_ID_RE.test(trimmed);
}
</script>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { useConfig } from '../../composables/useConfig';
import type { ConfigKey } from '../../types';

const props = defineProps<{
    configKey: ConfigKey;
    label: string;
    sublabel?: string;
    placeholder?: string;
    icon: string;
    /** Returns true when `draft` may be written to config. */
    validate: (value: string) => boolean;
    /** Shown instead of committing when `validate` rejects the draft. */
    invalidText: string;
    /** Optional extra caption shown when a value is committed and non-empty. */
    activeText?: string;
    /**
     * By default an empty field clears the stored value. Set this when empty is
     * itself invalid. Phrased as an opt-in because Vue resolves an absent
     * boolean prop to `false`, so the default has to be the common case.
     */
    rejectEmpty?: boolean;
}>();

const value = useConfig(props.configKey);
const draft = ref(String(value.value ?? ''));
const invalid = ref(false);

// The committed value can change from elsewhere (reset button, another panel).
// Follow it, and drop a rejected draft when it does — the stored value is the
// truth, and leaving stale red text next to a value the user did not type would
// misrepresent what is actually configured.
watch(value, (next) => {
    draft.value = String(next ?? '');
    invalid.value = false;
});

function commit(): void {
    const trimmed = draft.value.trim();
    if (!trimmed && !props.rejectEmpty) {
        invalid.value = false;
        draft.value = '';
        (value as { value: string }).value = '';
        return;
    }
    if (!props.validate(trimmed)) {
        // Reject rather than silently repair: a half-understood id quietly
        // rewritten into something else is worse than being told it was not
        // accepted. The stored value stays whatever it already was.
        invalid.value = true;
        return;
    }
    invalid.value = false;
    draft.value = trimmed;
    (value as { value: string }).value = trimmed;
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
                class="asmr-input q-field__native asmr-settings-stacked-control"
                :placeholder="placeholder || ''"
                type="text"
                spellcheck="false"
                autocapitalize="off"
                autocomplete="off"
                :value="draft"
                :data-key="configKey"
                :data-asmr-input="configKey"
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
                v-else-if="activeText && String(value ?? '').trim()"
                class="q-item__label q-item__label--caption text-caption asmr-settings-active-text"
            >{{ activeText }}</div>
        </div>
    </div>
</template>
