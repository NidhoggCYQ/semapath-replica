<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { AnalysisTask } from '@shared/analysis'
import type { RetrievalTrace } from '@shared/analysisAcquisition'
defineProps<{ trace: RetrievalTrace; task: AnalysisTask }>()
const emit = defineEmits<{ source: [id: string] }>()
const { t } = useI18n()
</script>
<template>
  <details v-if="trace.steps.length" class="retrieval-trace" data-testid="retrieval-trace">
    <summary>{{ t('analysis.retrieval.trace', { count: trace.steps.length }) }}</summary>
    <ol>
      <li v-for="step in trace.steps" :key="step.sourceId">
        <div class="step-heading">
          <span>{{ t(`analysis.retrieval.${step.kind}`) }} · {{ step.title }}</span>
          <span>{{ t('analysis.data.resultRows', { count: step.rows }) }}</span>
        </div>
        <pre v-if="step.query">{{ step.query }}</pre>
        <p class="hash">SHA-256: {{ step.sourceSha256 }}</p>
        <button
          v-if="
            task.sources.some(
              (source) => source.id === step.sourceId && source.sha256 === step.sourceSha256
            )
          "
          type="button"
          class="analysis-button"
          @click="emit('source', step.sourceId)"
        >
          {{ t('analysis.retrieval.viewSnapshot') }}
        </button>
        <p v-else class="analysis-muted">{{ t('analysis.retrieval.detached') }}</p>
      </li>
    </ol>
  </details>
</template>
<style scoped>
.retrieval-trace {
  border-block: 1px solid var(--border);
  padding-block: 12px;
  margin-block: 18px;
  font-size: 12px;
}
summary {
  cursor: pointer;
  color: var(--analysis-blue);
  padding-block: 5px;
}
summary:focus-visible {
  outline: 2px solid var(--analysis-blue);
  outline-offset: 2px;
}
ol {
  padding-inline-start: 24px;
}
li {
  margin-top: 18px;
}
.step-heading {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px;
  line-height: 1.8;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 200px;
  overflow: auto;
  margin-block: 10px;
  font:
    12px/1.7 Consolas,
    monospace;
}
.hash {
  font-family: Consolas, monospace;
  overflow-wrap: anywhere;
  color: var(--analysis-muted);
  margin-block: 8px;
}
</style>
