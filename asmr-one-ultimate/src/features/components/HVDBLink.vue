<script setup lang="ts">
import { computed } from 'vue';
import { useBridge } from '../../composables/useBridge';
import { extractRjCode, buildHvdbUrl, buildChobitUrl } from '../hvdbLinkUtils';

const bridge = useBridge();

const rjCode = computed(() => {
    return extractRjCode(bridge.currentWork, bridge.currentWorkId);
});

const hvdbUrl = computed(() => buildHvdbUrl(rjCode.value));
const chobitUrl = computed(() => buildChobitUrl(rjCode.value));
</script>

<template>
    <template v-if="rjCode">
        <div class="col-auto q-pl-sm asmr-hvdb-link">
            <i aria-hidden="true" role="presentation"
               class="q-icon notranslate material-icons"
               style="font-size: 18px">launch</i>
            <a rel="noreferrer noopener" target="_blank" class="text-blue"
               :href="hvdbUrl">HVDB</a>
        </div>
        <div class="col-auto q-pl-sm asmr-chobit-link">
            <i aria-hidden="true" role="presentation"
               class="q-icon notranslate material-icons"
               style="font-size: 18px">search</i>
            <a rel="noreferrer noopener" target="_blank" class="text-blue"
               :href="chobitUrl">Chobit</a>
        </div>
    </template>
</template>
