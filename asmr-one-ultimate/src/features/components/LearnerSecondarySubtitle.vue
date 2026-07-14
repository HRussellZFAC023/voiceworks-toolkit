<script setup lang="ts">
defineProps<{
    text: string;
    blurred: boolean;
    fallback: boolean;
    language: string;
    chineseLayout: boolean;
    ariaLabel: string;
}>();

defineEmits<{ toggle: [] }>();
</script>

<template>
    <button
        class="learner-en"
        :class="{ blurred: blurred && !!text, 'translation-fallback': fallback, 'learner-zh': chineseLayout }"
        :lang="language"
        :aria-label="ariaLabel"
        :aria-pressed="!blurred"
        @click.stop="$emit('toggle')"
    >{{ text }}</button>
</template>
