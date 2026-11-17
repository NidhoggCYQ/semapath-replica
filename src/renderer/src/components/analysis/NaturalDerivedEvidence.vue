<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { NaturalDerived, AnalysisTask } from '@shared/analysis'
defineProps<{ fact: NaturalDerived; task: AnalysisTask }>()
const emit = defineEmits<{ inspect: [runId: string, valueId: string] }>()
const { t } = useI18n()
</script>
<template>
  <section data-testid="natural-derived-evidence" class="derived-evidence">
    <h2>{{ t('analysis.natural.derivedEvidence') }} · {{ t(`analysis.natural.${fact.kind}`) }}</h2>
    <dl>
      <div>
        <dt>{{ t('analysis.category') }}</dt>
        <dd>{{ fact.category || t('analysis.allRows') }}</dd>
      </div>
      <div>
        <dt>{{ t('analysis.value') }}</dt>
        <dd data-testid="natural-derived-value">
          {{
            fact.value == null
              ? t('analysis.natural.zeroDenominator')
              : `${fact.value} ${fact.unit}`
          }}
        </dd>
      </div>
      <div>
        <dt>{{ t('analysis.exact') }}</dt>
        <dd>{{ fact.exact || t('analysis.natural.zeroDenominator') }}</dd>
      </div>
      <div>
        <dt>{{ t('analysis.natural.formula') }}</dt>
        <dd data-testid="natural-derived-formula">{{ fact.formula }}</dd>
      </div>
      <div>
        <dt>{{ t('analysis.numerator') }}</dt>
        <dd>{{ fact.numerator }}</dd>
      </div>
      <div>
        <dt>{{ t('analysis.denominator') }}</dt>
        <dd>{{ fact.denominator }}</dd>
      </div>
      <div>
        <dt>{{ t('analysis.evidenceId') }}</dt>
        <dd>{{ fact.id }}</dd>
      </div>
    </dl>
    <p class="analysis-muted">{{ t('analysis.natural.precision') }}</p>
    <h3>{{ t('analysis.natural.derivedInputs') }}</h3>
    <div class="analysis-table-wrap">
      <table>
        <thead>
          <tr>
            <th>{{ t('analysis.source') }}</th>
            <th>{{ t('analysis.category') }}</th>
            <th>{{ t('analysis.value') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(input, index) in fact.inputs" :key="`${input.runId}:${input.valueId}`">
            <td>
              {{ task.runs.find((run) => run.id === input.runId)?.source.name }} ·
              {{ task.runs.find((run) => run.id === input.runId)?.plan.sheet }}
            </td>
            <td>{{ input.category || t('analysis.allRows') }}</td>
            <td>
              <button
                type="button"
                class="evidence-link"
                :data-testid="`natural-derived-input-${index}`"
                @click="emit('inspect', input.runId, input.valueId)"
              >
                {{ input.value }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
<style scoped>
h2 {
  font-size: 17px;
  font-weight: 600;
  margin-bottom: 20px;
}
h3 {
  font-size: 14px;
  font-weight: 600;
  margin-top: 24px;
}
dl > div {
  display: grid;
  grid-template-columns: minmax(130px, 190px) minmax(0, 1fr);
  gap: 16px;
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
}
dt {
  color: var(--analysis-muted);
}
dd {
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
  margin: 0;
}
</style>
