<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { SourceOrigin } from '@shared/analysisData'
import PowerBiOrigin from './PowerBiOrigin.vue'
import AcquisitionOrigin from './AcquisitionOrigin.vue'
import FileExecutionOrigin from './FileExecutionOrigin.vue'
defineProps<{ origin: SourceOrigin }>()
const { t } = useI18n()
</script>
<template>
  <section class="data-origin" data-testid="data-origin">
    <h3>
      {{
        t(
          origin.kind === 'powerbi'
            ? 'analysis.pbi.snapshot'
            : origin.kind === 'mysql'
              ? 'analysis.data.mysqlSnapshot'
              : origin.kind === 'file_execution'
                ? 'analysis.fileExecution.snapshot'
                : 'analysis.data.joinSnapshot'
        )
      }}
    </h3>
    <p>
      {{ origin.title }} · {{ new Date(origin.createdAt).toLocaleString() }} ·
      {{ t('analysis.data.resultRows', { count: origin.rows }) }}
    </p>
    <p class="muted">{{ t('analysis.data.frozenHint') }}</p>
    <AcquisitionOrigin v-if="origin.acquisition" :origin="origin.acquisition" />
    <template v-if="origin.kind === 'mysql' || origin.kind === 'powerbi'">
      <p>{{ origin.connectionName }} · {{ origin.database }}</p>
      <PowerBiOrigin v-if="origin.powerBi" :origin="origin.powerBi" />
      <p v-else class="muted">{{ t('analysis.data.rowOrdinalHint') }}</p>
      <details>
        <summary>{{ t('analysis.data.query') }}</summary>
        <pre>{{ origin.query }}</pre>
        <p v-for="column in origin.types" :key="column.column">
          {{ column.column }} · {{ column.type }}
        </p>
      </details>
    </template>
    <FileExecutionOrigin
      v-else-if="origin.kind === 'file_execution' && origin.fileExecution"
      :execution="origin.fileExecution"
    />
    <template v-else>
      <p>
        {{
          t('analysis.data.matched', {
            matched: origin.matched ?? 0,
            unmatched: origin.unmatched ?? 0
          })
        }}
      </p>
      <p class="muted">
        {{
          t('analysis.data.missingKeys', {
            left: origin.missingLeftKeys ?? 0,
            right: origin.missingRightKeys ?? 0
          })
        }}
      </p>
      <details>
        <summary>{{ t('analysis.data.parents') }}</summary>
        <div
          v-for="parent in origin.parents"
          :key="parent.id + parent.sha256 + parent.sheet"
          class="parent"
        >
          <p>{{ parent.name }} · {{ parent.sheet }}</p>
          <p v-if="parent.createdAt">{{ new Date(parent.createdAt).toLocaleString() }}</p>
          <p class="hash">{{ parent.sha256 }}</p>
          <pre v-if="parent.query">{{ parent.database }} · {{ parent.query }}</pre>
          <PowerBiOrigin v-if="parent.powerBi" :origin="parent.powerBi" />
          <AcquisitionOrigin v-if="parent.acquisition" :origin="parent.acquisition" />
          <FileExecutionOrigin v-if="parent.fileExecution" :execution="parent.fileExecution" />
          <p v-if="parent.kind === 'mysql'" class="muted">
            {{ t('analysis.data.rowOrdinalHint') }}
          </p>
          <p v-for="column in parent.types" :key="column.column">
            {{ column.column }} · {{ column.type }}
          </p>
        </div>
        <p v-for="(step, i) in origin.steps" :key="i">
          {{ step.input.left.sheet }} · {{ step.input.left.key }} → {{ step.input.right.sheet }} ·
          {{ step.input.right.key }} ·
          {{ t(step.input.kind === 'left' ? 'analysis.data.leftJoin' : 'analysis.data.innerJoin') }}
        </p>
      </details>
    </template>
  </section>
</template>
<style scoped>
.data-origin {
  margin: 16px 0;
  padding: 14px 0;
  border-bottom: 1px solid var(--border);
}
h3 {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 10px;
}
p {
  font-size: 12px;
  line-height: 1.7;
  overflow-wrap: anywhere;
  margin: 6px 0;
}
.muted {
  color: var(--analysis-muted);
}
summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--analysis-blue);
  margin-top: 12px;
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
  margin: 10px 0;
}
.hash {
  font-family: Consolas, monospace;
  color: var(--analysis-muted);
}
.parent {
  margin-top: 12px;
}
</style>
