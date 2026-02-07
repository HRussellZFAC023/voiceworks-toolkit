<script setup lang="ts">
/**
 * EntitySelector - Reusable single-select with filter and chip display.
 * Used for VA and Circle selection in Advanced Search.
 */
import { ref, computed } from 'vue';
import { useI18n } from '../../composables/useI18n';

export interface EntityItem {
    id: string | number;
    name: string;
    count?: number;
}

const props = defineProps<{
    label: string;
    filterPlaceholder: string;
    items: EntityItem[];
    selected: EntityItem | null;
    /** Map of original name -> translated name */
    translationCache: Map<string, string>;
    emptyMessage: string;
    removeAriaLabel: string;
}>();

const emit = defineEmits<{
    select: [item: EntityItem];
    clear: [];
}>();

const { t } = useI18n();

const filterText = ref('');

function getTranslatedName(name: string): string {
    const en = props.translationCache.get(name);
    if (en && en !== name) return `${name} (${en})`;
    return name;
}

const filteredItems = computed(() => {
    const needle = filterText.value.trim().toLowerCase();
    if (!needle) return props.items.slice(0, 100);
    return props.items.filter(item => {
        const name = item.name.toLowerCase();
        const en = (props.translationCache.get(item.name) || '').toLowerCase();
        return name.includes(needle) || en.includes(needle);
    });
});

function getItemLabel(item: EntityItem): string {
    const displayName = getTranslatedName(item.name);
    return item.count ? `${displayName} (${item.count})` : displayName;
}

function onSelectChange(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const selectedId = select.value;
    const item = props.items.find(i => String(i.id) === selectedId);
    if (item) {
        emit('select', item);
        filterText.value = '';
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
            size="5"
            class="asmr-va-select"
            :aria-label="label"
            @change="onSelectChange"
        >
            <option
                v-for="item in filteredItems"
                :key="item.id"
                :value="String(item.id)"
            >
                {{ getItemLabel(item) }}
            </option>
            <option v-if="filteredItems.length === 0" disabled>
                {{ filterText.trim() ? t('advNoResults') : emptyMessage }}
            </option>
        </select>
        <div class="asmr-selected-va" aria-live="polite">
            <div v-if="selected" class="asmr-selected-chip">
                <span>{{ getTranslatedName(selected.name) }}</span>
                <button
                    class="chip-remove"
                    :aria-label="removeAriaLabel"
                    @click="emit('clear')"
                >
                    <i class="material-icons" aria-hidden="true">close</i>
                </button>
            </div>
        </div>
    </div>
</template>
