<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import type { AnalysisRun, AnalysisTask, NaturalTurn, NaturalDerived } from '@shared/analysis'
import { compareAnalysisValues } from '@shared/analysisDecimal'
import AnalysisChart from './AnalysisChart.vue'
import MethodAnswer from './MethodAnswer.vue'
import AnalysisFrame from './AnalysisFrame.vue'
import DataOrigin from './DataOrigin.vue'
const props = defineProps<{ task: AnalysisTask; turn: NaturalTurn }>()
const emit = defineEmits<{
  inspect: [runId: string, valueId: string]
  derived: [turnId: string, factId: string]
  scope: [queryKey: string]
  continue: [questionId: string]
}>()
const { t } = useI18n()
const queryRun = (key: string) =>
  props.task.runs.find(
    (run) => run.id === props.turn.queryRuns.find((reference) => reference.key === key)?.runId
  )
const sections = computed(() =>
  (props.turn.plan?.views ?? []).map((view, viewIndex) => {
    const run = queryRun(view.queryKey)!
    const baseline = view.baselineQueryKey ? queryRun(view.baselineQueryKey) : undefined
    const facts = props.turn.derived.filter((fact) => fact.viewIndex === viewIndex)
    const values =
      view.kind === 'ranking'
        ? [...run.values]
            .sort((a, b) => compareAnalysisValues(a, b) * (view.direction === 'ascending' ? 1 : -1))
            .slice(0, view.limit ?? 10)
        : run.values
    const plottedFacts = facts.filter((fact) =>
      view.kind === 'share' ? fact.kind === 'share' : fact.kind === 'difference'
    )
    const points = ['share', 'comparison'].includes(view.kind)
      ? plottedFacts
          .filter((fact) => fact.value != null)
          .map((fact) => ({
            id: fact.id,
            category: fact.category,
            value: fact.value!,
            exact: fact.exact
          }))
      : values
    return { view, viewIndex, run, baseline, facts, values, points }
  })
)
const label = (category: string, run: AnalysisRun) =>
  category || t(run.plan.groupBy ? 'analysis.blankGroup' : 'analysis.allRows')
function selectChart(section: (typeof sections.value)[number], index: number) {
  const point = section.points[index]
  if (['share', 'comparison'].includes(section.view.kind)) emit('derived', props.turn.id, point.id)
  else emit('inspect', section.run.id, point.id)
}
function derivedFor(facts: NaturalDerived[], category: string, kind: NaturalDerived['kind']) {
  return facts.find((fact) => fact.category === category && fact.kind === kind)!
}
const filterText = (run: AnalysisRun) =>
  run.plan.filters
    .map(
      (filter) =>
        `${filter.column} ${t(`analysis.${filter.operator}`)} ${filter.operator === 'in' ? (filter.values ?? []).join(', ') : filter.value}`
    )
    .join('; ') || t('analysis.noFilter')
</script>
<template>
  <article
    data-testid="natural-answer"
    class="natural-answer"
    :data-analysis-quote-origin="
      JSON.stringify({ kind: 'turn', turnId: turn.id, candidateHash: turn.answer.candidateHash })
    "
  >
    <h2>{{ turn.question }}</h2>
    <p class="analysis-muted">
      {{ t('analysis.natural.allViews') }} · {{ t('analysis.natural.reviewed') }}
    </p>
    <AnalysisFrame
      v-if="turn.framework"
      :frame="turn.framework"
      :task="task"
      @inspect="(runId, valueId) => emit('inspect', runId, valueId)"
      @continue="emit('continue', $event)"
    />
    <section
      v-for="section in sections"
      :key="section.viewIndex"
      class="natural-result-section"
      :data-testid="`natural-view-${section.viewIndex}`"
    >
      <button
        type="button"
        class="query-drilldown"
        :data-testid="'analysis-drilldown-' + section.view.queryKey"
        @click="emit('scope', section.view.queryKey)"
      >
        <Icon icon="lucide:git-branch" aria-hidden="true" />{{ t('analysis.framework.drillQuery') }}
      </button>
      <DataOrigin v-if="section.run.source.origin" :origin="section.run.source.origin" />
      <MethodAnswer
        v-if="section.run.study"
        :run="section.run"
        @inspect="emit('inspect', section.run.id, $event)"
      />
      <template v-else>
        <h3>
          {{
            section.run.plan.operation === 'count'
              ? t('analysis.natural.allRecords')
              : section.run.measureLabel
          }}
          · {{ t(`analysis.natural.${section.view.kind}`) }}
        </h3>
        <p>
          {{
            t('analysis.natural.scopeSentence', {
              file: section.run.source.name,
              sheet: section.run.plan.sheet,
              measure: section.run.measureLabel || t('analysis.natural.allRecords'),
              operation: t(`analysis.${section.run.plan.operation}`)
            })
          }}
        </p>
        <p v-if="section.view.kind === 'ranking'" class="analysis-muted">
          {{
            t('analysis.natural.rankSummary', {
              count: section.run.values.length,
              limit: section.values.length,
              direction: t(
                section.view.direction === 'ascending'
                  ? 'analysis.natural.ascending'
                  : 'analysis.natural.descending'
              )
            })
          }}
        </p>
        <p v-if="section.view.kind === 'share'" class="analysis-muted">
          {{ t('analysis.natural.shareSummary') }}
        </p>
        <p v-if="section.view.kind === 'comparison'" class="analysis-muted">
          {{ t('analysis.natural.comparisonSummary') }}
        </p>
        <details class="natural-scope">
          <summary>{{ t('analysis.natural.scope') }}</summary>
          <p>{{ t('analysis.filter') }}: {{ filterText(section.run) }}</p>
          <p v-if="section.run.plan.groupBy">
            {{ t('analysis.natural.group', { field: section.run.groupLabel }) }} ·
            {{ t(`analysis.natural.${section.run.plan.grouping ?? 'raw'}`) }}
          </p>
          <p>
            {{
              t('analysis.scopeHint', {
                scanned: section.run.scannedRows,
                matched: section.run.matchedRows,
                empty: section.run.emptyRows
              })
            }}
          </p>
          <p v-if="section.baseline">
            {{ t('analysis.natural.baseline') }}: {{ filterText(section.baseline) }}
          </p>
        </details>
        <ul
          v-if="section.view.kind === 'summary' || section.view.kind === 'ranking'"
          class="answer-facts"
        >
          <li v-for="(value, index) in section.values" :key="value.id">
            <span>{{ label(value.category, section.run) }}</span
            ><button
              type="button"
              class="evidence-link"
              :data-testid="`natural-value-${section.viewIndex}-${index}`"
              @click="emit('inspect', section.run.id, value.id)"
            >
              {{ value.value }}<Icon icon="lucide:arrow-up-right" aria-hidden="true" />
            </button>
          </li>
        </ul>
        <ul v-else-if="section.view.kind === 'share'" class="answer-facts">
          <li v-for="(fact, index) in section.facts" :key="fact.id">
            <span>{{ label(fact.category, section.run) }}</span
            ><button
              type="button"
              class="evidence-link"
              :data-testid="`natural-share-${section.viewIndex}-${index}`"
              @click="emit('derived', turn.id, fact.id)"
            >
              {{ fact.value }} %<Icon icon="lucide:arrow-up-right" aria-hidden="true" />
            </button>
          </li>
        </ul>
        <div v-else class="analysis-table-wrap">
          <table>
            <thead>
              <tr>
                <th>{{ t('analysis.category') }}</th>
                <th>{{ t('analysis.natural.current') }}</th>
                <th>{{ t('analysis.natural.baseline') }}</th>
                <th>{{ t('analysis.natural.difference') }}</th>
                <th>{{ t('analysis.natural.percent_change') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="value in section.run.values" :key="value.id">
                <td>{{ label(value.category, section.run) }}</td>
                <td>
                  <button
                    type="button"
                    class="evidence-link"
                    @click="emit('inspect', section.run.id, value.id)"
                  >
                    {{ value.value }}
                  </button>
                </td>
                <td>
                  <button
                    type="button"
                    class="evidence-link"
                    @click="
                      emit(
                        'inspect',
                        section.baseline!.id,
                        section.baseline!.values.find(
                          (before) => before.category === value.category
                        )!.id
                      )
                    "
                  >
                    {{
                      section.baseline!.values.find((before) => before.category === value.category)!
                        .value
                    }}
                  </button>
                </td>
                <td>
                  <button
                    type="button"
                    class="evidence-link"
                    @click="
                      emit(
                        'derived',
                        turn.id,
                        derivedFor(section.facts, value.category, 'difference').id
                      )
                    "
                  >
                    {{ derivedFor(section.facts, value.category, 'difference').value }}
                  </button>
                </td>
                <td>
                  <button
                    v-if="derivedFor(section.facts, value.category, 'percent_change').value != null"
                    type="button"
                    class="evidence-link"
                    @click="
                      emit(
                        'derived',
                        turn.id,
                        derivedFor(section.facts, value.category, 'percent_change').id
                      )
                    "
                  >
                    {{ derivedFor(section.facts, value.category, 'percent_change').value }}
                    %</button
                  ><span v-else>{{ t('analysis.natural.zeroDenominator') }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-for="warning in section.run.warnings" :key="warning" class="analysis-notice">
          {{ t(`analysis.warnings.${warning}`) }}
        </p>
        <p v-if="section.facts.length" class="analysis-muted">
          {{ t('analysis.natural.precision') }}
        </p>
        <AnalysisChart
          :key="`${turn.id}:${section.viewIndex}`"
          :run="section.run"
          :points="section.points"
          :initial-kind="section.view.chart"
          :metric-label="
            section.view.kind === 'share'
              ? t('analysis.natural.share')
              : section.view.kind === 'comparison'
                ? t('analysis.natural.difference')
                : section.run.measureLabel
          "
          :unit="section.view.kind === 'share' ? '%' : section.run.plan.unit"
          @select="selectChart(section, $event)"
        />
      </template>
    </section>
    <p class="analysis-muted">
      {{ t('analysis.natural.unitNotice') }} · {{ t('analysis.sourceTime') }}
      {{ new Date(turn.createdAt).toLocaleString() }}
    </p>
  </article>
</template>
<style scoped>
.query-drilldown {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--analysis-blue);
  font-size: 12px;
  margin-bottom: 14px;
  padding: 6px 0;
}
.query-drilldown:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.query-drilldown:focus-visible {
  outline: 2px solid var(--analysis-blue);
  outline-offset: 3px;
}
.natural-answer > h2 {
  font-size: 19px;
  line-height: 1.6;
  font-weight: 600;
  margin: 0 0 12px;
  overflow-wrap: anywhere;
}
.natural-result-section {
  padding: 22px 0;
  border-bottom: 1px solid var(--border);
}
.natural-result-section h3 {
  font-size: 15px;
  font-weight: 600;
  margin: 0 0 12px;
}
.natural-result-section p {
  line-height: 1.8;
  max-width: 80ch;
}
.natural-scope {
  margin-top: 14px;
  font-size: 12px;
  color: var(--analysis-muted);
}
.natural-scope summary {
  cursor: pointer;
}
.natural-scope p {
  overflow-wrap: anywhere;
}
</style>
