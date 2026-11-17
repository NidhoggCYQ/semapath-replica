<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { AcquisitionOrigin } from '@shared/analysisAcquisition'
defineProps<{ origin: AcquisitionOrigin }>()
const { t } = useI18n()
</script>
<template>
  <div class="acquisition-origin" data-testid="acquisition-origin">
    <p>{{ t('analysis.retrieval.generatedFor') }}: {{ origin.question }}</p>
    <p>{{ origin.modelName }} · {{ new Date(origin.generatedAt).toLocaleString() }}</p>
    <p class="hash">{{ t('analysis.retrieval.structureHash') }}: {{ origin.structureSha256 }}</p>
    <p v-if="origin.querySha256" class="hash">SQL / DAX SHA-256: {{ origin.querySha256 }}</p>
  </div>
</template>
<style scoped>
.acquisition-origin {
  margin: 10px 0;
}
p {
  font-size: 12px;
  line-height: 1.7;
  margin: 6px 0;
  overflow-wrap: anywhere;
}
.hash {
  font-family: Consolas, monospace;
  color: var(--analysis-muted);
}
</style>
