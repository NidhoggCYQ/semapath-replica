<script setup lang="ts">
import { computed, reactive, ref, watch, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ANALYSIS_METHODS,
  ANALYSIS_CHARTS,
  METHOD_RULES,
  StudyPlanSchema,
  type StudyPlan,
  type AnalysisMethod,
  type ChartKind
} from '@shared/analysisStudy'
const props = defineProps<{
  columns: { key: string; label: string }[]
  busy: boolean
  measure: string
  groupBy: string
  operation: string
}>()
const model = defineModel<StudyPlan | undefined>()
const emit = defineEmits<{ valid: [value: boolean] }>()
const { t, locale } = useI18n()
const initial = model.value
const method = ref<AnalysisMethod | ''>(initial?.method ?? '')
const chart = ref<ChartKind>(initial?.chart ?? 'bar')
const state = reactive({
  secondMeasure: initial?.secondMeasure ?? '',
  secondUnit: initial?.secondUnit ?? '',
  sizeMeasure: initial?.sizeMeasure ?? '',
  sizeUnit: initial?.sizeUnit ?? '',
  observationBy: initial?.observationBy ?? '',
  seriesBy: initial?.seriesBy ?? '',
  interval: initial?.interval ?? 'month',
  boundaries: initial?.boundaries?.join(', ') ?? '',
  thresholdX: initial?.thresholds?.x ?? '',
  thresholdY: initial?.thresholds?.y ?? '',
  ruleBasis: initial?.ruleBasis ?? '',
  identity: initial?.identity ?? 'sum',
  factors: initial?.factors ?? ([] as string[]),
  stages: initial?.stages ?? ([] as string[]),
  funnelMode: initial?.funnelMode ?? 'cohort_flags',
  window: initial?.window ?? '',
  windowComplete: initial?.windowComplete ?? false,
  correlation: initial?.correlation ?? 'pearson',
  useRules: !!initial?.rules
})
const rules = ref(
  initial?.rules?.map((rule) => ({
    label: rule.label,
    column: rule.conditions[0].column,
    kind: rule.conditions[0].kind,
    operator: rule.conditions[0].operator,
    value: rule.conditions[0].value
  })) ?? [{ label: '', column: '', kind: 'text', operator: 'eq', value: '' }]
)
const text = (value: { zh: string; en: string }) =>
  locale.value.startsWith('zh') ? value.zh : value.en
const choices = computed<ChartKind[]>(() => {
  switch (method.value) {
    case 'cycle-analysis':
      return ['line', 'bar', 'table']
    case 'structure-analysis':
    case 'mece-decomposition':
      return state.seriesBy
        ? ['bar', 'stacked', 'percent_stacked', 'heatmap', 'table']
        : ['bar', 'waterfall', 'pie', 'donut', 'table']
    case 'label-analysis':
      return state.seriesBy
        ? ['sum', 'count'].includes(props.operation)
          ? ['bar', 'stacked', 'percent_stacked', 'heatmap', 'table']
          : ['bar', 'heatmap', 'table']
        : ['bar', 'pie', 'donut', 'table']
    case 'stratification-analysis':
      return ['bar', 'histogram', 'boxplot', 'table']
    case 'matrix-analysis':
      return state.sizeMeasure
        ? ['scatter', 'bubble', 'heatmap', 'table']
        : ['scatter', 'heatmap', 'table']
    case 'correlation-analysis':
      return state.sizeMeasure ? ['scatter', 'bubble', 'table'] : ['scatter', 'table']
    case 'metric-decomposition':
      return state.identity === 'sum'
        ? ['bar', 'waterfall', 'stacked', 'percent_stacked', 'table']
        : ['bar', 'table']
    case 'funnel-analysis':
      return state.funnelMode === 'duration' ? ['bar', 'line', 'table'] : ['funnel', 'bar', 'table']
    default:
      return ['bar', 'line', 'table']
  }
})
watch(choices, (types) => {
  if (!types.includes(chart.value)) chart.value = types[0]
})
watch(method, () => {
  chart.value = choices.value[0]
})
const paired = computed(
  () => method.value === 'matrix-analysis' || method.value === 'correlation-analysis'
)
const classification = computed(() =>
  ['structure-analysis', 'label-analysis', 'mece-decomposition'].includes(method.value)
)
watchEffect(() => {
  if (!method.value) {
    model.value = undefined
    emit('valid', true)
    return
  }
  const input: Record<string, unknown> = { method: method.value, chart: chart.value }
  if (state.observationBy) input.observationBy = state.observationBy
  if (classification.value) {
    if (state.seriesBy) input.seriesBy = state.seriesBy
    if (state.useRules) {
      input.rules = rules.value.map((rule) => ({
        label: rule.label,
        conditions: [
          { column: rule.column, kind: rule.kind, operator: rule.operator, value: rule.value }
        ]
      }))
      input.ruleBasis = state.ruleBasis
    }
  }
  if (method.value === 'cycle-analysis') {
    input.interval = state.interval
    input.windowComplete = state.windowComplete
  }
  if (method.value === 'stratification-analysis' && state.boundaries.trim()) {
    input.boundaries = state.boundaries.split(/[,，;；]/).map((v) => v.trim())
    input.ruleBasis = state.ruleBasis
  }
  if (paired.value) {
    input.secondMeasure = state.secondMeasure
    if (state.secondUnit) input.secondUnit = state.secondUnit
    if (state.sizeMeasure) {
      input.sizeMeasure = state.sizeMeasure
      input.sizeUnit = state.sizeUnit
    }
    if (method.value === 'matrix-analysis' && (state.thresholdX || state.thresholdY)) {
      input.thresholds = { x: state.thresholdX, y: state.thresholdY }
      input.ruleBasis = state.ruleBasis
    }
    if (method.value === 'correlation-analysis') input.correlation = state.correlation
  }
  if (method.value === 'metric-decomposition') {
    input.factors = state.factors
    input.identity = state.identity
    input.ruleBasis = state.ruleBasis
  }
  if (method.value === 'funnel-analysis') {
    input.stages = state.stages
    input.funnelMode = state.funnelMode
    input.window = state.window
    input.ruleBasis = state.ruleBasis
    input.windowComplete = state.windowComplete
  }
  const parsed = StudyPlanSchema.safeParse(input)
  const needsGroup = (classification.value && !state.useRules) || method.value === 'cycle-analysis'
  const needsBasis =
    !!input.thresholds ||
    !!input.boundaries ||
    !!input.rules ||
    ['metric-decomposition', 'funnel-analysis'].includes(method.value)
  const valid =
    parsed.success &&
    (!needsGroup || !!props.groupBy) &&
    (!needsBasis || !!state.ruleBasis.trim()) &&
    (!['structure-analysis', 'mece-decomposition'].includes(method.value) ||
      ['sum', 'count'].includes(props.operation)) &&
    (!(method.value === 'funnel-analysis' && state.funnelMode === 'cohort_flags') ||
      !!state.observationBy) &&
    (!paired.value || (!!props.measure && state.secondMeasure !== props.measure)) &&
    (![
      'stratification-analysis',
      'matrix-analysis',
      'metric-decomposition',
      'correlation-analysis'
    ].includes(method.value) ||
      props.operation !== 'count')
  model.value = parsed.success ? parsed.data : { method: method.value, chart: chart.value }
  emit('valid', valid)
})
</script>
<template>
  <section class="method-form" data-testid="method-form">
    <label
      >{{ t('analysis.methods.choose')
      }}<select v-model="method" data-testid="method-select" :disabled="busy">
        <option value="">{{ t('analysis.methods.basic') }}</option>
        <option v-for="id in ANALYSIS_METHODS" :key="id" :value="id">
          {{ text(METHOD_RULES[id].title) }}
        </option>
      </select></label
    >
    <template v-if="method">
      <p class="analysis-muted">{{ text(METHOD_RULES[method].requirements) }}</p>
      <div class="method-fields">
        <label
          >{{ t('analysis.chart')
          }}<select v-model="chart" data-testid="method-plan-chart" :disabled="busy">
            <option
              v-for="type in ANALYSIS_CHARTS"
              :key="type"
              :value="type"
              :disabled="!choices.includes(type)"
            >
              {{ t(`analysis.methods.charts.${type}`) }}
            </option>
          </select></label
        >
        <label
          >{{ t('analysis.methods.observation')
          }}<select v-model="state.observationBy" data-testid="method-observation" :disabled="busy">
            <option value="">{{ t('analysis.methods.rowObservation') }}</option>
            <option v-for="c in columns" :key="c.key" :value="c.key">
              {{ c.key }} · {{ c.label }}
            </option>
          </select></label
        >
        <template v-if="paired"
          ><label
            >{{ t('analysis.methods.secondMeasure')
            }}<select
              v-model="state.secondMeasure"
              data-testid="method-second-measure"
              :disabled="busy"
            >
              <option value="" disabled>{{ t('analysis.selectMeasure') }}</option>
              <option v-for="c in columns" :key="c.key" :value="c.key">
                {{ c.key }} · {{ c.label }}
              </option>
            </select></label
          ><label
            >{{ t('analysis.methods.secondUnit')
            }}<input v-model="state.secondUnit" maxlength="30" :disabled="busy" /></label
          ><label
            >{{ t('analysis.methods.sizeMeasure')
            }}<select
              v-model="state.sizeMeasure"
              data-testid="method-size-measure"
              :disabled="busy"
            >
              <option value="">{{ t('analysis.methods.none') }}</option>
              <option v-for="c in columns" :key="c.key" :value="c.key">
                {{ c.key }} · {{ c.label }}
              </option>
            </select></label
          ><label v-if="state.sizeMeasure"
            >{{ t('analysis.methods.sizeUnit')
            }}<input v-model="state.sizeUnit" maxlength="30" :disabled="busy" /></label
        ></template>
        <label v-if="classification"
          >{{ t('analysis.methods.series')
          }}<select v-model="state.seriesBy" data-testid="method-series" :disabled="busy">
            <option value="">{{ t('analysis.methods.none') }}</option>
            <option v-for="c in columns" :key="c.key" :value="c.key">
              {{ c.key }} · {{ c.label }}
            </option>
          </select></label
        >
        <label v-if="method === 'cycle-analysis'"
          >{{ t('analysis.methods.interval')
          }}<select v-model="state.interval" data-testid="method-interval" :disabled="busy">
            <option
              v-for="interval in ['day', 'week', 'month', 'quarter', 'year']"
              :key="interval"
              :value="interval"
            >
              {{ t(`analysis.methods.intervals.${interval}`) }}
            </option>
          </select></label
        >
        <label v-if="method === 'stratification-analysis'"
          >{{ t('analysis.methods.boundaries')
          }}<input
            v-model="state.boundaries"
            data-testid="method-boundaries"
            :placeholder="t('analysis.methods.boundaryHint')"
            maxlength="1500"
            :disabled="busy"
        /></label>
        <template v-if="method === 'matrix-analysis'"
          ><label
            >{{ t('analysis.methods.thresholdX')
            }}<input
              v-model="state.thresholdX"
              data-testid="method-threshold-x"
              :placeholder="t('analysis.methods.medianDefault')"
              maxlength="500"
              :disabled="busy" /></label
          ><label
            >{{ t('analysis.methods.thresholdY')
            }}<input
              v-model="state.thresholdY"
              data-testid="method-threshold-y"
              :placeholder="t('analysis.methods.medianDefault')"
              maxlength="500"
              :disabled="busy" /></label
        ></template>
        <label v-if="method === 'correlation-analysis'"
          >{{ t('analysis.methods.coefficient')
          }}<select v-model="state.correlation" data-testid="method-correlation" :disabled="busy">
            <option value="pearson">Pearson r</option>
            <option value="spearman">Spearman ρ</option>
          </select></label
        >
        <template v-if="method === 'metric-decomposition'"
          ><label
            >{{ t('analysis.methods.identity')
            }}<select v-model="state.identity" data-testid="method-identity" :disabled="busy">
              <option v-for="type in ['sum', 'product', 'ratio']" :key="type" :value="type">
                {{ t(`analysis.methods.identities.${type}`) }}
              </option>
            </select></label
          ><label
            >{{ t('analysis.methods.factors')
            }}<select
              v-model="state.factors"
              multiple
              data-testid="method-factors"
              :disabled="busy"
            >
              <option v-for="c in columns" :key="c.key" :value="c.key">
                {{ c.key }} · {{ c.label }}
              </option>
            </select></label
          ></template
        >
        <template v-if="method === 'funnel-analysis'"
          ><label
            >{{ t('analysis.methods.flowType')
            }}<select v-model="state.funnelMode" data-testid="method-flow-type" :disabled="busy">
              <option value="cohort_flags">{{ t('analysis.methods.cohortFlags') }}</option>
              <option value="duration">{{ t('analysis.methods.duration') }}</option>
            </select></label
          ><label
            >{{ t('analysis.methods.stages')
            }}<select v-model="state.stages" multiple data-testid="method-stages" :disabled="busy">
              <option v-for="c in columns" :key="c.key" :value="c.key">
                {{ c.key }} · {{ c.label }}
              </option></select
            ><small>{{ t('analysis.methods.stageOrder') }}</small></label
          ><label
            >{{ t('analysis.methods.window')
            }}<input
              v-model="state.window"
              data-testid="method-window"
              maxlength="300"
              :disabled="busy" /></label
        ></template>
      </div>
      <label
        v-if="method === 'cycle-analysis' || method === 'funnel-analysis'"
        class="method-checkbox"
        ><input
          v-model="state.windowComplete"
          type="checkbox"
          data-testid="method-window-complete"
          :disabled="busy"
        />{{ t('analysis.methods.windowComplete') }}</label
      >
      <template v-if="classification"
        ><label class="method-checkbox"
          ><input
            v-model="state.useRules"
            type="checkbox"
            data-testid="method-use-rules"
            :disabled="busy"
          />{{ t('analysis.methods.useRules') }}</label
        >
        <div v-if="state.useRules" class="classification-rules">
          <div v-for="(rule, index) in rules" :key="index" class="classification-rule">
            <label
              >{{ t('analysis.methods.ruleName')
              }}<input v-model="rule.label" maxlength="80" :disabled="busy" /></label
            ><label
              >{{ t('analysis.methods.ruleField')
              }}<select v-model="rule.column" :disabled="busy">
                <option value="" disabled>{{ t('analysis.selectMeasure') }}</option>
                <option v-for="c in columns" :key="c.key" :value="c.key">
                  {{ c.key }} · {{ c.label }}
                </option>
              </select></label
            ><label
              >{{ t('analysis.methods.ruleType')
              }}<select v-model="rule.kind" :disabled="busy">
                <option value="text">{{ t('analysis.methods.text') }}</option>
                <option value="number">{{ t('analysis.methods.number') }}</option>
              </select></label
            ><label
              >{{ t('analysis.operation')
              }}<select v-model="rule.operator" :disabled="busy">
                <option
                  v-for="op in rule.kind === 'number'
                    ? ['eq', 'neq', 'gt', 'gte', 'lt', 'lte']
                    : ['eq', 'neq', 'contains']"
                  :key="op"
                  :value="op"
                >
                  {{ t(`analysis.${op}`) }}
                </option>
              </select></label
            ><label
              >{{ t('analysis.filterValue')
              }}<input v-model="rule.value" maxlength="500" :disabled="busy" /></label
            ><button
              type="button"
              class="analysis-button"
              :disabled="busy || rules.length < 2"
              @click="rules.splice(index, 1)"
            >
              {{ t('analysis.remove') }}
            </button>
          </div>
          <button
            type="button"
            class="analysis-button"
            :disabled="busy || rules.length >= 12"
            @click="rules.push({ label: '', column: '', kind: 'text', operator: 'eq', value: '' })"
          >
            {{ t('analysis.methods.addRule') }}
          </button>
        </div></template
      >
      <label
        v-if="
          state.boundaries ||
          state.thresholdX ||
          state.thresholdY ||
          (classification && state.useRules) ||
          method === 'metric-decomposition' ||
          method === 'funnel-analysis'
        "
        >{{ t('analysis.methods.basis')
        }}<input
          v-model="state.ruleBasis"
          data-testid="method-basis"
          maxlength="500"
          :disabled="busy"
          :placeholder="t('analysis.methods.basisHint')"
      /></label>
      <p class="analysis-muted">{{ t('analysis.methods.requirementHint') }}</p>
    </template>
  </section>
</template>
<style scoped>
.method-form {
  border-top: 1px solid var(--border);
  padding-top: 18px;
  display: grid;
  gap: 14px;
  min-width: 0;
}
.method-form label {
  display: flex;
  flex-direction: column;
  gap: 7px;
  font-size: 12px;
  min-width: 0;
}
.method-form label:first-child {
  max-width: 420px;
}
.method-fields {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}
.method-form input,
.method-form select {
  box-sizing: border-box;
  background: var(--background);
  color: var(--foreground);
  border: 1px solid var(--border);
  border-radius: 6px;
  font: inherit;
  padding: 9px 10px;
  width: 100%;
  min-width: 0;
  min-height: 36px;
}
.method-form input:focus-visible,
.method-form select:focus-visible {
  outline: 2px solid var(--analysis-blue);
  outline-offset: 2px;
}
.method-form select[multiple] {
  min-height: 130px;
}
.method-form .method-checkbox {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 9px;
  max-width: none;
}
.method-checkbox input {
  width: 16px;
  min-height: 16px;
  margin: 0;
}
.method-form small {
  color: var(--analysis-muted);
  line-height: 1.6;
}
.classification-rules {
  display: grid;
  gap: 12px;
}
.classification-rule {
  display: grid;
  grid-template-columns: 1.1fr 1fr 0.7fr 0.8fr 1fr auto;
  align-items: end;
  gap: 10px;
}
.classification-rules > button {
  justify-self: start;
}
.method-form p {
  margin: 0;
  line-height: 1.8;
}
@media (max-width: 1100px) {
  .method-fields {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .classification-rule {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (max-width: 750px) {
  .method-fields,
  .classification-rule {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
