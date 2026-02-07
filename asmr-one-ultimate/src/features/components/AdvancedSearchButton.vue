<script setup lang="ts">
/**
 * AdvancedSearchButton - Trigger button for the Advanced Search dialog.
 *
 * This component is injected into the header toolbar by AdvancedSearchController.
 * It renders a small icon button and manages the dialog open/close state.
 */

import { ref } from 'vue';
import { useI18n } from '../../composables/useI18n';
import AdvancedSearchDialog from './AdvancedSearchDialog.vue';

const { t } = useI18n();

const dialogVisible = ref(false);

function open(): void {
    dialogVisible.value = true;
}
</script>

<template>
    <button
        class="q-btn q-btn-flat q-btn-dense asmr-playlist-btn text-white"
        :title="t('advSearchBtn')"
        :aria-label="t('advSearchBtn')"
        @click="open"
    >
        <span class="q-btn__content">
            <i class="q-icon material-icons" aria-hidden="true">playlist_add</i>
        </span>
    </button>
    <AdvancedSearchDialog v-model:visible="dialogVisible" />
</template>
