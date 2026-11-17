<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AnalysisRun } from '@shared/analysis'
import { METHOD_RULES } from '@shared/analysisStudy'
import DataOrigin from './DataOrigin.vue'
const props = defineProps<{ run: AnalysisRun; selectedIndex: number }>()
const emit = defineEmits<{ select: [index: number] }>()
const { t, locale } = useI18n()
const page = ref(1)
watch(
  () => [props.run.id, props.selectedIndex],
  () => {
    page.value = 1
  }
)
const selected = computed(() => props.run.values[props.selectedIndex] ?? props.run.values[0])
const inputs = computed(() => selected.value.inputs.slice((page.value - 1) * 50, page.value * 50))
const pageCount = computed(() => Math.max(1, Math.ceil(selected.value.inputs.length / 50)))
const category = (value: AnalysisRun['values'][number]) =>
  value.category || t(props.run.plan.groupBy ? 'analysis.blankGroup' : 'analysis.allRows')
</script>
<template>
  <section data-testid="analysis-evidence" class="evidence-panel">
    <div class="analysis-section-heading">
      <h2>{{ t('analysis.evidence') }}</h2>
      <select
        :value="selectedIndex"
        :aria-label="t('analysis.category')"
        @change="emit('select', Number(($event.target as HTMLSelectElement).value))"
      >
        <option v-for="(value, index) in run.values" :key="value.id" :value="index">
          {{ category(value) }}
        </option>
      </select>
    </div>
    <p class="analysis-muted">
      {{ t('analysis.historical', { time: new Date(run.createdAt).toLocaleString() }) }}
    </p>
    <p v-if="run.plan.groupBy" class="analysis-muted">
      {{ t('analysis.natural.group', { field: run.groupLabel }) }} ·
      {{ t(`analysis.natural.${run.plan.grouping ?? 'raw'}`) }}
    </p>
    <p v-if="run.plan.rowScope" class="analysis-notice" data-testid="evidence-row-scope">
      {{ t('analysis.framework.scopeEvidence') }} ·
      {{ t('analysis.framework.rowCount', { count: run.plan.rowScope.rows.length }) }} ·
      {{ t('analysis.framework.inputRowsNotice') }}
    </p>
    <DataOrigin v-if="run.source.origin" :origin="run.source.origin" />
    <dl class="evidence-facts">
      <div>
        <dt>{{ t('analysis.value') }}</dt>
        <dd data-testid="evidence-value">
          {{ selected.value }} {{ selected.unit ?? run.plan.unit }}
        </dd>
      </div>
      <div>
        <dt>{{ t('analysis.exact') }}</dt>
        <dd>{{ selected.exact }}</dd>
      </div>
      <div>
        <dt>{{ t('analysis.operation') }}</dt>
        <dd>
          {{
            run.study
              ? locale.startsWith('zh')
                ? METHOD_RULES[run.study.method].title.zh
                : METHOD_RULES[run.study.method].title.en
              : t(`analysis.${run.plan.operation}`)
          }}
          ·
          {{ run.measureLabel || t('analysis.allRows') }}
        </dd>
      </div>
      <div>
        <dt>{{ t('analysis.numerator') }} / {{ t('analysis.denominator') }}</dt>
        <dd>
          {{ selected.rational?.numerator ?? selected.numerator }} /
          {{ selected.rational?.denominator ?? selected.denominator }}
        </dd>
      </div>
      <div>
        <dt>{{ t('analysis.included') }} / {{ t('analysis.blank') }}</dt>
        <dd>{{ selected.included }} / {{ selected.blank }}</dd>
      </div>
      <div>
        <dt>{{ t('analysis.period') }}</dt>
        <dd>{{ run.plan.period || t('analysis.periodUnset') }}</dd>
      </div>
      <div>
        <dt>{{ t('analysis.unit') }}</dt>
        <dd>{{ selected.unit ?? (run.plan.unit || t('analysis.unitUnset')) }}</dd>
      </div>
      <div>
        <dt>{{ t('analysis.filter') }}</dt>
        <dd>
          {{
            run.plan.filters.length
              ? run.plan.filters
                  .map(
                    (filter) =>
                      `${filter.column} ${t(`analysis.${filter.operator}`)} ${filter.operator === 'in' ? (filter.values ?? []).join(', ') : filter.value}`
                  )
                  .join('; ')
              : t('analysis.noFilter')
          }}
        </dd>
      </div>
      <div>
        <dt>{{ t('analysis.source') }}</dt>
        <dd>
          {{ run.source.name }} · {{ run.plan.sheet }} · {{ t('analysis.headerRow') }}
          {{ run.plan.headerRow }}
        </dd>
      </div>
      <div>
        <dt>{{ t('analysis.sourcePath') }}</dt>
        <dd class="break-value">{{ run.source.path }}</dd>
      </div>
      <div>
        <dt>{{ t('analysis.fingerprint') }}</dt>
        <dd class="break-value fingerprint">{{ run.source.sha256 }}</dd>
      </div>
      <div>
        <dt>{{ t('analysis.evidenceId') }}</dt>
        <dd class="break-value fingerprint">{{ run.evidenceId }}</dd>
      </div>
      <div>
        <dt>{{ t('analysis.sourceTime') }}</dt>
        <dd>
          {{ new Date(run.createdAt).toLocaleString()
          }}<span class="analysis-muted block">{{ t('analysis.timeNotice') }}</span>
        </dd>
      </div>
    </dl>
    <p class="analysis-muted">
      {{
        t('analysis.scopeHint', {
          scanned: run.scannedRows,
          matched: run.matchedRows,
          empty: run.emptyRows
        })
      }}
    </p>
    <p v-for="warning in run.warnings" :key="warning" class="analysis-notice">
      {{ t(`analysis.warnings.${warning}`) }}
    </p>
    <dl v-if="selected.formula" class="evidence-facts">
      <div>
        <dt>{{ t('analysis.methods.formula') }}</dt>
        <dd class="break-value">{{ selected.formula }}</dd>
      </div>
    </dl>
    <h3>{{ t('analysis.inputCells') }}</h3>
    <p v-if="run.plan.operation === 'count' && !run.study" class="analysis-muted">
      {{ t('analysis.countValueHint') }}
    </p>
    <div class="analysis-table-wrap">
      <table data-testid="evidence-inputs">
        <thead>
          <tr>
            <th>{{ t('analysis.row') }}</th>
            <th>{{ t('analysis.address') }}</th>
            <th>{{ t('analysis.rawValue') }}</th>
            <th v-if="inputs.some((input) => input.origin?.length)">
              {{ t('analysis.data.originalCells') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="input in inputs" :key="`${input.row}:${input.cell}`">
            <td>{{ input.row }}</td>
            <td>{{ input.cell }}</td>
            <td>{{ input.value }}</td>
            <td v-if="inputs.some((item) => item.origin?.length)">
              <p
                v-for="origin in input.origin"
                :key="origin.sourceId + origin.cell"
                data-testid="evidence-original-cell"
              >
                {{ origin.source }} · {{ origin.sheet }} · {{ origin.cell }} = {{ origin.value }}
              </p>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="pagination">
      <button type="button" class="analysis-button" :disabled="page <= 1" @click="page--">
        {{ t('analysis.previous') }}</button
      ><span>{{ t('analysis.pages', { page, count: pageCount }) }}</span
      ><button type="button" class="analysis-button" :disabled="page >= pageCount" @click="page++">
        {{ t('analysis.next') }}
      </button>
    </div>
    <details class="execution-record">
      <summary>{{ t('analysis.execution') }}</summary>
      <p>
        {{ t('analysis.engine') }}: {{ run.execution.engine }} · {{ t('analysis.duration') }}:
        {{ run.execution.durationMs }} ms
      </p>
      <h4>{{ t('analysis.plan') }}</h4>
      <pre>{{ run.execution.plan }}</pre>
      <h4>{{ t('analysis.stdout') }}</h4>
      <pre>{{ run.execution.stdout }}</pre>
    </details>
  </section>
</template>
<style scoped>
.evidence-facts {
  margin-block: 20px;
}
.evidence-facts > div {
  display: grid;
  grid-template-columns: minmax(130px, 190px) minmax(0, 1fr);
  gap: 16px;
  padding: 11px 0;
  border-bottom: 1px solid var(--border);
}
dt {
  color: var(--analysis-muted);
}
dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}
.break-value {
  overflow-wrap: anywhere;
}
.fingerprint {
  font-family: ui-monospace, monospace;
  font-size: 12px;
}
h3 {
  margin-top: 26px;
}
.execution-record {
  margin-top: 24px;
  border-top: 1px solid var(--border);
  padding-top: 16px;
}
summary {
  cursor: pointer;
  font-weight: 600;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--muted);
  border-radius: 6px;
  padding: 14px;
  font-size: 12px;
}
</style>
