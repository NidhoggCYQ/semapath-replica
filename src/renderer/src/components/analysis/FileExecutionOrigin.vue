<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { FileExecutionOrigin } from '@shared/analysisFileExecution'
defineProps<{ execution: FileExecutionOrigin }>()
const { t } = useI18n()
</script>
<template>
  <div class="file-execution-origin" data-testid="file-execution-origin">
    <p>{{ t('analysis.fileExecution.recordedHint') }}</p>
    <p class="hash">{{ t('analysis.fileExecution.executionId') }}: {{ execution.id }}</p>
    <p>
      {{ new Date(execution.finishedAt).toLocaleString() }} ·
      {{
        t(
          execution.skillStatus === 'loaded'
            ? 'analysis.fileExecution.skillLoaded'
            : 'analysis.fileExecution.skillNotLoaded'
        )
      }}
    </p>
    <details>
      <summary>{{ t('analysis.fileExecution.inputs') }}</summary>
      <div v-for="(input, index) in execution.inputs" :key="index">
        <p>{{ input.name }} · {{ input.sheet }} · {{ input.range }}</p>
        <p class="hash">SHA-256: {{ input.sha256 }}</p>
      </div>
    </details>
    <details>
      <summary>{{ t('analysis.fileExecution.command') }}</summary>
      <pre>{{ execution.command }}</pre>
      <p class="hash">SHA-256: {{ execution.commandSha256 }}</p>
    </details>
    <p class="hash">{{ t('analysis.fileExecution.resultHash') }}: {{ execution.resultSha256 }}</p>
  </div>
</template>
<style scoped>
.file-execution-origin {
  margin: 10px 0;
  color: var(--foreground);
}
p {
  font-size: 12px;
  line-height: 1.7;
  overflow-wrap: anywhere;
  margin: 6px 0;
}
.hash {
  font-family: Consolas, monospace;
}
summary {
  cursor: pointer;
  font-size: 12px;
  margin: 10px 0;
}
summary:focus-visible {
  outline: 2px solid var(--analysis-blue);
  outline-offset: 2px;
}
pre {
  font:
    12px/1.7 Consolas,
    monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 240px;
  overflow: auto;
}
</style>
