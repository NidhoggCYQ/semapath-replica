<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import type { AnalysisFrame } from '@shared/analysisFramework'
import type { AnalysisTask } from '@shared/analysis'
defineProps<{ frame: AnalysisFrame; task: AnalysisTask }>()
const emit = defineEmits<{
  inspect: [runId: string, valueId: string]
  continue: [questionId: string]
}>()
const { t } = useI18n()
const valueLabel = (task: AnalysisTask, runId: string, valueId: string) => {
  const run = task.runs.find((run) => run.id === runId)
  const value = run?.values.find((value) => value.id === valueId)
  return value ? (value.category || run?.measureLabel || '') + ' · ' + value.value : valueId
}
</script>
<template>
  <section
    class="analysis-frame"
    data-testid="analysis-frame"
    :aria-label="t('analysis.framework.title')"
  >
    <h3>{{ t('analysis.framework.title') }}</h3>
    <p class="frame-objective">{{ frame.objective }}</p>
    <p class="analysis-muted frame-caution">{{ t('analysis.framework.judgmentNotice') }}</p>
    <ol>
      <li
        v-for="question in frame.questions"
        :key="question.id"
        :data-testid="'analysis-frame-question-' + question.key"
      >
        <h4>
          <span class="question-kind">{{ t('analysis.framework.' + question.kind) }}</span
          >{{ question.text }}
        </h4>
        <p class="frame-state">
          <strong>{{ t('analysis.framework.' + question.judgment) }}</strong
          ><span>{{ t('analysis.framework.' + question.next) }}</span>
        </p>
        <p class="frame-reason">{{ question.reason || t('analysis.framework.noJudgment') }}</p>
        <div v-if="question.evidence.length" class="frame-evidence">
          <span>{{ t('analysis.evidence') }}</span>
          <button
            v-for="reference in question.evidence"
            :key="reference.runId + ':' + reference.valueId"
            type="button"
            class="evidence-link"
            @click="emit('inspect', reference.runId, reference.valueId)"
          >
            {{ valueLabel(task, reference.runId, reference.valueId)
            }}<Icon icon="lucide:arrow-up-right" aria-hidden="true" />
          </button>
        </div>
        <button
          type="button"
          class="continue-question"
          :data-testid="'analysis-frame-continue-' + question.key"
          @click="emit('continue', question.id)"
        >
          <Icon icon="lucide:corner-down-right" aria-hidden="true" />{{
            t('analysis.framework.continueQuestion')
          }}
        </button>
      </li>
    </ol>
  </section>
</template>
<style scoped>
.analysis-frame {
  padding: 22px 0 8px;
  border-bottom: 1px solid var(--border);
}
h3 {
  font-size: 15px;
  font-weight: 600;
  margin: 0 0 12px;
}
.frame-objective,
.frame-reason {
  max-width: 75ch;
  line-height: 1.8;
  overflow-wrap: anywhere;
}
.frame-caution {
  font-size: 12px;
  margin: 10px 0 18px;
  max-width: 80ch;
  line-height: 1.7;
}
ol {
  list-style: none;
  padding: 0;
  margin: 0;
}
li {
  padding: 16px 0;
  border-top: 1px solid var(--border);
}
h4 {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.8;
  overflow-wrap: anywhere;
  margin: 0;
}
.question-kind {
  font-weight: 400;
  color: var(--analysis-muted);
  margin-right: 12px;
}
.frame-state {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin: 8px 0;
  font-size: 12px;
}
.frame-state strong {
  font-weight: 600;
}
.frame-state span {
  color: var(--analysis-muted);
}
.frame-evidence {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin: 12px 0;
}
.frame-evidence > span {
  color: var(--analysis-muted);
  font-size: 12px;
}
.continue-question {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 0;
  color: var(--analysis-blue);
  font-size: 12px;
}
.continue-question:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.continue-question:focus-visible {
  outline: 2px solid var(--analysis-blue);
  outline-offset: 3px;
}
</style>
