<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { PbiProvenance } from '@shared/analysisPowerBi'
defineProps<{ origin: PbiProvenance }>()
const { t } = useI18n()
</script>
<template>
  <div class="pbi-origin" data-testid="pbi-origin">
    <p>
      {{ t(origin.kind === 'local' ? 'analysis.localPbi' : 'analysis.cloudPbi') }} ·
      {{ origin.transport }} · {{ origin.modelName }}
    </p>
    <p>{{ t('analysis.pbi.model') }} · {{ origin.modelId }}</p>
    <p v-if="origin.workspaceName || origin.workspaceId">
      {{ t('analysis.pbi.workspace') }} · {{ origin.workspaceName }} · {{ origin.workspaceId }}
    </p>
    <p v-if="origin.environment">
      {{ t('analysis.pbi.environment') }} · {{ t('analysis.pbi.' + origin.environment) }} ·
      {{ origin.tenantId }}
    </p>
    <p class="muted">{{ t('analysis.pbi.resultHint') }}</p>
    <p class="muted">{{ t('analysis.pbi.precisionHint') }}</p>
    <p class="hash">DAX SHA-256 · {{ origin.querySha256 }}</p>
    <details v-if="origin.schema">
      <summary>{{ t('analysis.pbi.coverage') }}</summary>
      <p>{{ origin.schema.source }} · {{ new Date(origin.schema.fetchedAt).toLocaleString() }}</p>
      <p v-for="(coverage, area) in origin.schema.coverage" :key="area">
        {{ t('analysis.pbi.' + area) }} · {{ t('analysis.pbi.' + coverage) }}
      </p>
    </details>
    <p v-else class="muted">{{ t('analysis.pbi.noSchemaHint') }}</p>
  </div>
</template>
<style scoped>
p {
  font-size: 12px;
  line-height: 1.7;
  margin: 6px 0;
  overflow-wrap: anywhere;
}
.muted {
  color: var(--analysis-muted);
}
.hash {
  font:
    12px/1.7 Consolas,
    monospace;
}
summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--analysis-blue);
  margin: 10px 0;
}
summary:focus-visible {
  outline: 2px solid var(--analysis-blue);
  outline-offset: 2px;
}
</style>
