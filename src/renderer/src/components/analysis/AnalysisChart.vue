<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AnalysisRun } from '@shared/analysis'
import type { ChartKind } from '@shared/analysisStudy'
type ChartPoint = { id: string; category: string; value: string; exact: string; included?: number }
const props = defineProps<{
  run: AnalysisRun
  points?: ChartPoint[]
  initialKind?: ChartKind
  metricLabel?: string
  unit?: string
}>()
const metric = computed(() => props.metricLabel ?? props.run.measureLabel)
const chartUnit = computed(() => props.unit ?? props.run.plan.unit)
const values = computed(() => props.points ?? props.run.values)
const emit = defineEmits<{ select: [index: number] }>()
const { t } = useI18n()
const kind = ref<'bar' | 'line' | 'table'>(
  props.initialKind === 'line' || props.initialKind === 'table' ? props.initialKind : 'bar'
)
const numbers = computed(() => values.value.map((value) => Number(value.value)))
const plottable = computed(() =>
  values.value.every(
    (value) =>
      Number.isFinite(Number(value.value)) &&
      !(Number(value.value) === 0 && /[1-9]/.test(value.value))
  )
)
const magnitude = computed(() => Math.max(...numbers.value.map(Math.abs), 1e-300))
const position = (value: number) =>
  (value / magnitude.value - extent.value.minimum / magnitude.value) /
  (extent.value.maximum / magnitude.value - extent.value.minimum / magnitude.value)
const extent = computed(() => {
  const minimum = Math.min(0, ...numbers.value)
  const maximum = Math.max(0, ...numbers.value)
  return { minimum, maximum: maximum === minimum ? minimum + 1 : maximum }
})
const scaleX = (value: number) => 180 + position(value) * 440
const scaleY = (value: number) => 220 - position(value) * 185
const lineX = (index: number) => 80 + (index / Math.max(1, values.value.length - 1)) * 540
const linePoints = computed(() =>
  numbers.value.map((value, index) => `${lineX(index)},${scaleY(value)}`).join(' ')
)
const ticks = computed(() =>
  Array.from(
    { length: 5 },
    (_, index) => extent.value.minimum * (1 - index / 4) + extent.value.maximum * (index / 4)
  )
)
const label = (index: number) =>
  values.value[index].category ||
  t(props.run.plan.groupBy ? 'analysis.blankGroup' : 'analysis.allRows')
const tickText = (value: number) =>
  Number(value.toPrecision(3)).toLocaleString(undefined, { maximumSignificantDigits: 3 })
</script>

<template>
  <section class="result-chart" :aria-label="t('analysis.chart')">
    <div class="analysis-section-heading">
      <h3>
        {{ metric || t('analysis.chart') }}<span v-if="chartUnit"> · {{ chartUnit }}</span>
      </h3>
      <div class="segmented" :aria-label="t('analysis.chart')">
        <button
          v-for="type in ['bar', 'line', 'table'] as const"
          :key="type"
          type="button"
          :aria-pressed="kind === type"
          @click="kind = type"
        >
          {{ t(`analysis.${type}`) }}
        </button>
      </div>
    </div>
    <p class="analysis-muted">
      {{ t(plottable ? 'analysis.chartNotice' : 'analysis.natural.dataOnlyChart') }}
    </p>
    <div v-if="kind === 'bar' && plottable" class="chart-scroll">
      <svg
        :viewBox="`0 0 800 ${Math.max(160, values.length * 40 + 45)}`"
        role="img"
        :aria-label="`${metric} ${chartUnit}`"
        class="bar-svg"
      >
        <g v-for="tick in ticks" :key="tick">
          <line
            :x1="scaleX(tick)"
            :x2="scaleX(tick)"
            y1="15"
            :y2="values.length * 40 + 15"
            class="chart-grid"
          />
          <text
            :x="scaleX(tick)"
            :y="values.length * 40 + 35"
            text-anchor="middle"
            class="chart-tick"
          >
            {{ tickText(tick) }}
          </text>
        </g>
        <line
          :x1="scaleX(0)"
          :x2="scaleX(0)"
          y1="15"
          :y2="values.length * 40 + 15"
          class="chart-zero"
        />
        <g
          v-for="(value, index) in values"
          :key="value.id"
          tabindex="0"
          role="button"
          :aria-label="`${label(index)}: ${value.value}`"
          @click="emit('select', index)"
          @keydown.enter="emit('select', index)"
          @keydown.space.prevent="emit('select', index)"
        >
          <title>{{ label(index) }}: {{ value.exact }}</title>
          <text x="165" :y="index * 40 + 34" text-anchor="end" class="chart-label">
            {{ label(index).length > 16 ? label(index).slice(0, 15) + '…' : label(index) }}
          </text>
          <rect
            :x="Math.min(scaleX(0), scaleX(numbers[index]))"
            :y="index * 40 + 18"
            :width="Math.max(1, Math.abs(scaleX(numbers[index]) - scaleX(0)))"
            height="23"
            rx="3"
            class="chart-bar"
          />
          <text x="640" :y="index * 40 + 34" class="chart-label">{{ value.value }}</text>
        </g>
      </svg>
    </div>
    <div v-else-if="kind === 'line' && plottable" class="chart-scroll">
      <svg viewBox="0 0 800 265" role="img" :aria-label="t('analysis.line')" class="line-svg">
        <g v-for="tick in ticks" :key="tick">
          <line x1="80" x2="620" :y1="scaleY(tick)" :y2="scaleY(tick)" class="chart-grid" />
          <text x="65" :y="scaleY(tick) + 4" text-anchor="end" class="chart-tick">
            {{ tickText(tick) }}
          </text>
        </g>
        <polyline :points="linePoints" fill="none" class="chart-line" />
        <g
          v-for="(value, index) in values"
          :key="value.id"
          tabindex="0"
          role="button"
          :aria-label="`${label(index)}: ${value.value}`"
          @click="emit('select', index)"
          @keydown.enter="emit('select', index)"
          @keydown.space.prevent="emit('select', index)"
        >
          <title>{{ label(index) }}: {{ value.exact }}</title>
          <circle :cx="lineX(index)" :cy="scaleY(numbers[index])" r="5" class="chart-point" />
          <text
            v-if="values.length <= 8 || index === 0 || index === values.length - 1"
            :x="lineX(index)"
            y="245"
            text-anchor="middle"
            class="chart-tick"
          >
            {{ label(index).slice(0, 14) }}
          </text>
        </g>
      </svg>
    </div>
    <div v-else class="analysis-table-wrap">
      <table>
        <thead>
          <tr>
            <th>{{ t('analysis.category') }}</th>
            <th>
              {{ t('analysis.value') }}<span v-if="chartUnit"> ({{ chartUnit }})</span>
            </th>
            <th>{{ t('analysis.included') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(value, index) in values" :key="value.id">
            <td>{{ label(index) }}</td>
            <td>
              <button type="button" class="evidence-link" @click="emit('select', index)">
                {{ value.value }}
              </button>
            </td>
            <td>{{ value.included ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.chart-scroll {
  max-height: 430px;
  overflow: auto;
}
.bar-svg,
.line-svg {
  width: 100%;
  min-width: 620px;
}
.chart-grid {
  stroke: var(--border);
  stroke-width: 1;
}
.chart-zero {
  stroke: var(--analysis-muted);
  stroke-opacity: 0.5;
}
.chart-bar,
.chart-point {
  fill: var(--analysis-blue);
}
.chart-line {
  stroke: var(--analysis-blue);
  stroke-width: 2.5;
}
.chart-label {
  font-size: 13px;
  fill: var(--foreground);
  font-variant-numeric: tabular-nums;
}
.chart-tick {
  font-size: 11px;
  fill: var(--analysis-muted);
}
svg g[role='button'] {
  cursor: pointer;
  outline-offset: -2px;
}
svg g[role='button']:hover .chart-bar,
svg g[role='button']:focus-visible .chart-bar {
  opacity: 0.75;
}
</style>
