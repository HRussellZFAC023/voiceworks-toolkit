<script setup lang="ts">
import { computed } from 'vue';
import { useBridge } from '../../composables/useBridge';

const bridge = useBridge();

const rjCode = computed(() => {
    const work = bridge.currentWork;
    const workId = bridge.currentWorkId;
    const sourceId = String(work?.source_id || work?.sourceId || '').trim();

    if (sourceId) {
        if (/^RJ\d{6,8}$/i.test(sourceId)) return sourceId.toUpperCase();
        if (/^\d{6,8}$/.test(sourceId)) return 'RJ' + sourceId;
    }

    const cleanId = String(workId || '').trim();
    if (/^RJ\d{6,8}$/i.test(cleanId)) return cleanId.toUpperCase();
    if (/^\d{6,8}$/.test(cleanId)) return 'RJ' + cleanId;

    return '';
});

const hvdbId = computed(() => rjCode.value.replace(/^RJ/i, ''));
const hvdbUrl = computed(() => hvdbId.value ? `https://hvdb.me/Dashboard/Add?id=${hvdbId.value}` : '');
const chobitUrl = computed(() => rjCode.value ? `https://chobit.cc/s/?f_category=all&q_keyword=${rjCode.value}` : '');
</script>

<template>
    <template v-if="rjCode">
        <div class="col-auto q-pl-sm asmr-hvdb-link">
            <i aria-hidden="true" role="presentation"
               class="q-icon notranslate material-icons"
               style="font-size: 18px">launch</i>
            <a rel="noreferrer noopener" target="_blank" class="text-blue"
               :href="hvdbUrl" style="margin-left: 4px">HVDB</a>
        </div>
        <div class="col-auto q-pl-sm asmr-chobit-link">
            <i aria-hidden="true" role="presentation"
               class="q-icon notranslate material-icons"
               style="font-size: 18px">search</i>
            <a rel="noreferrer noopener" target="_blank" class="text-blue"
               :href="chobitUrl" style="margin-left: 4px">Chobit</a>
        </div>
    </template>
</template>
