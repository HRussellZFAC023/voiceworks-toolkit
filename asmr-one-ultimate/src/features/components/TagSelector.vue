<script setup lang="ts">
import { ref, computed } from 'vue';
import type { TagEntry } from '../../types/api';
import { useI18n } from '../../composables/useI18n';

const props = defineProps<{
    label: string;
    filterPlaceholder: string;
    tags: TagEntry[];
    selected: TagEntry[];
    emptyMessage: string;
}>();

const emit = defineEmits<{
    select: [tag: TagEntry];
    remove: [tagId: number];
}>();

const { t, format } = useI18n();

const filterText = ref('');

const filteredTags = computed(() => {
    const needle = filterText.value.trim().toLowerCase();
    if (!needle) return props.tags.slice(0, 100);
    return props.tags.filter(tag => {
        const name = (tag.en || tag.ja || tag.name).toLowerCase();
        const ja = (tag.ja || tag.name).toLowerCase();
        return name.includes(needle) || ja.includes(needle);
    });
});

function getTagLabel(tag: TagEntry): string {
    const name = tag.en ? `${tag.ja || tag.name} (${tag.en})` : (tag.ja || tag.name);
    return tag.count ? `${name} (${tag.count})` : name;
}

function getTagDisplayText(tag: TagEntry): string {
    return tag.en ? `${tag.ja || tag.name} (${tag.en})` : (tag.ja || tag.name);
}

function onSelectChange(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const chosenIds = Array.from(select.selectedOptions).map(o => Number(o.value));
    const selectedIds = new Set(props.selected.map(s => s.id));
    for (const id of chosenIds) {
        if (!selectedIds.has(id)) {
            const tag = props.tags.find(t => t.id === id);
            if (tag) emit('select', tag);
        }
    }
}

function onFilterKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
        filterText.value = '';
        (event.target as HTMLElement).blur();
    }
}
</script>

<template>
    <div class="asmr-form-group">
        <label class="asmr-form-label">{{ label }}</label>
        <input
            type="text"
            class="asmr-filter-input"
            :placeholder="filterPlaceholder"
            v-model="filterText"
            @keydown="onFilterKeydown"
        />
        <select
            multiple
            size="6"
            class="asmr-include-select"
            :aria-label="label"
            @change="onSelectChange"
        >
            <option
                v-for="tag in filteredTags"
                :key="tag.id"
                :value="String(tag.id)"
                :selected="selected.some(s => s.id === tag.id)"
            >
                {{ getTagLabel(tag) }}
            </option>
            <option v-if="filteredTags.length === 0" disabled>
                {{ filterText.trim() ? t('advNoResults') : emptyMessage }}
            </option>
        </select>
        <div class="asmr-chips-container" aria-live="polite">
            <div
                v-for="tag in selected"
                :key="tag.id"
                class="asmr-filter-chip"
            >
                <span class="chip-text">{{ getTagDisplayText(tag) }}</span>
                <button
                    class="chip-remove"
                    :aria-label="format('advRemoveTag', { tag: getTagDisplayText(tag) })"
                    @click="emit('remove', tag.id)"
                >
                    <i class="material-icons" aria-hidden="true">close</i>
                </button>
            </div>
        </div>
    </div>
</template>
