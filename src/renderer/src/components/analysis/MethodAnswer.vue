<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useThemeStore } from '@/stores/theme'
import type { AnalysisRun } from '@shared/analysis'
import { ANALYSIS_CHARTS, METHOD_RULES, type ChartKind } from '@shared/analysisStudy'
import { renderStudyCharts } from '@shared/analysisChartSvg'
const props = defineProps<{ run: AnalysisRun }>()
const emit = defineEmits<{ inspect: [id: string] }>()
const { t, locale } = useI18n()
const theme = useThemeStore()
const text = (item: { zh: string; en: string }) =>
  locale.value.startsWith('zh') ? item.zh : item.en
const study = computed(() => props.run.study!)
const kind = ref<ChartKind>(props.run.chart.kind)
watch(
  () => props.run.id,
  () => {
    kind.value = props.run.chart.kind
  }
)
const selected = computed(() => study.value.charts.find((chart) => chart.kind === kind.value))
const figures = computed(() =>
  selected.value
    ? renderStudyCharts(selected.value, props.run.values, {
        dark: theme.isDark,
        label: t(`analysis.methods.charts.${kind.value}`)
      })
    : []
)
const byId = computed(() => new Map(props.run.values.map((value) => [value.id, value])))
function select(event: MouseEvent) {
  const target = (event.target as Element).closest('[data-value-id]')
  if (target) {
    event.preventDefault()
    const id = target.getAttribute('data-value-id')
    if (id) emit('inspect', id)
  }
}
</script>
<template>
  <section class="method-answer" data-testid="method-answer">
    <div class="analysis-section-heading">
      <h3>{{ text(METHOD_RULES[study.method].title) }}</h3>
      <label class="method-chart-label"
        >{{ t('analysis.chart')
        }}<select v-model="kind" data-testid="method-chart" :aria-label="t('analysis.chart')">
          <option
            v-for="type in ANALYSIS_CHARTS"
            :key="type"
            :value="type"
            :disabled="!study.charts.some((chart) => chart.kind === type)"
          >
            {{ t(`analysis.methods.charts.${type}`)
            }}{{
              study.charts.some((chart) => chart.kind === type)
                ? ''
                : ` · ${t('analysis.methods.notApplicable')}`
            }}
          </option>
        </select></label
      >
    </div>
    <p v-if="kind !== run.chart.kind" class="analysis-muted">
      {{ t('analysis.methods.previewOnly') }}
    </p>
    <p class="analysis-muted">{{ text(study.requirements) }}</p>
    <p class="analysis-notice">{{ text(study.limits) }}</p>
    <dl v-if="study.statistics.length" class="method-statistics">
      <div v-for="id in study.statistics" :key="id">
        <dt>{{ byId.get(id)?.category }}</dt>
        <dd>
          <button type="button" class="evidence-link" @click="emit('inspect', id)">
            {{ byId.get(id)?.value }} {{ byId.get(id)?.unit }}
          </button>
        </dd>
      </div>
    </dl>
    <div v-if="kind !== 'table'" class="method-figures" @click="select">
      <figure v-for="(figure, index) in figures" :key="index">
        <div class="method-svg" v-html="figure" />
        <figcaption>{{ selected ? text(selected.note) : '' }}</figcaption>
      </figure>
      <p v-if="!figures.length" class="analysis-notice">
        {{ t('analysis.natural.dataOnlyChart') }}
      </p>
    </div>
    <div class="analysis-table-wrap">
      <table data-testid="method-results">
        <thead>
          <tr>
            <th>{{ t('analysis.category') }}</th>
            <th v-if="study.rows.some((row) => row.series)">{{ t('analysis.methods.series') }}</th>
            <th v-for="column in study.columns" :key="column.key">
              {{ column.label }}<span v-if="column.unit"> ({{ column.unit }})</span>
            </th>
            <th v-if="study.rows.some((row) => row.description)">
              {{ t('analysis.methods.classification') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, index) in study.rows" :key="index">
            <td>{{ row.label }}</td>
            <td v-if="study.rows.some((item) => item.series)">{{ row.series }}</td>
            <td v-for="column in study.columns" :key="column.key">
              <button
                v-if="row.values[column.key]"
                type="button"
                class="evidence-link"
                @click="emit('inspect', row.values[column.key])"
              >
                {{ byId.get(row.values[column.key])?.value }}</button
              ><span v-else>{{ t('analysis.methods.undefined') }}</span>
            </td>
            <td v-if="study.rows.some((item) => item.description)">{{ row.description }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <details class="method-checks" open>
      <summary>
        {{ t('analysis.methods.checks') }} ·
        {{ t('analysis.methods.version', { version: study.ruleVersion }) }}
      </summary>
      <ul>
        <li v-for="check in study.checks" :key="check.key" :data-check-state="check.state">
          <strong>{{ t(`analysis.methods.states.${check.state}`) }}</strong
          ><span>{{ text(check.detail) }}</span>
        </li>
      </ul>
    </details>
  </section>
</template>
<style scoped>
.method-answer {
  margin-block: 20px;
  min-width: 0;
}
.method-answer h3 {
  font-size: 17px;
  font-weight: 600;
}
.method-answer p {
  line-height: 1.8;
}
.method-chart-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.method-chart-label select {
  max-width: 300px;
}
.method-statistics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px 24px;
  margin-block: 22px;
}
.method-statistics > div {
  border-bottom: 1px solid var(--border);
  padding-bottom: 10px;
}
.method-statistics dt {
  font-size: 12px;
  color: var(--analysis-muted);
}
.method-statistics dd {
  margin: 5px 0 0;
  font-size: 16px;
  font-variant-numeric: tabular-nums;
}
.method-figures {
  min-width: 0;
}
.method-figures figure {
  margin: 18px 0;
}
.method-svg {
  overflow-x: auto;
  max-width: 100%;
}
.method-svg :deep(svg) {
  display: block;
  width: 100%;
  min-width: 620px;
  max-height: 430px;
}
.method-svg :deep(a) {
  cursor: pointer;
  outline-offset: 2px;
}
.method-figures figcaption {
  font-size: 12px;
  color: var(--analysis-muted);
  line-height: 1.7;
  margin-top: 7px;
}
.method-checks {
  padding-block: 16px;
  border-top: 1px solid var(--border);
  line-height: 1.8;
}
.method-checks summary {
  cursor: pointer;
  font-weight: 600;
}
.method-checks ul {
  padding: 0;
  list-style: none;
}
.method-checks li {
  display: grid;
  grid-template-columns: 100px minmax(0, 1fr);
  gap: 16px;
  padding-block: 8px;
}
.method-checks li strong {
  font-size: 12px;
}
.method-checks li span {
  overflow-wrap: anywhere;
}
.method-checks li[data-check-state='fail'] strong {
  color: var(--destructive);
}
@media (max-width: 900px) {
  .analysis-section-heading {
    align-items: flex-start;
    flex-direction: column;
    gap: 12px;
  }
  .method-chart-label {
    width: 100%;
  }
  .method-chart-label select {
    max-width: 100%;
    flex: 1;
  }
  .method-checks li {
    grid-template-columns: 75px minmax(0, 1fr);
  }
}
</style>
