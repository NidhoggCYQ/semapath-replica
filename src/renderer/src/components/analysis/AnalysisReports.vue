<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { Button } from '@shadcn/components/ui/button'
import { Input } from '@shadcn/components/ui/input'
import { createAnalysisClient } from '@api/AnalysisClient'
import { AnalysisErrorCodes, type AnalysisTask } from '@shared/analysis'
import type { ReportAnswer, ReportOptions, ReportRecord } from '@shared/analysisReport'
const props = defineProps<{
  task: AnalysisTask
  initialTarget?: { kind: 'run' | 'turn'; id: string } | null
}>()
const { t, locale } = useI18n()
const client = createAnalysisClient()
const records = ref<ReportRecord[]>([])
const title = ref(props.task.title)
const selected = ref('')
const format = ref<ReportOptions['format']>('a4')
const reportLocale = ref<ReportOptions['locale']>(locale.value.startsWith('zh') ? 'zh-CN' : 'en-US')
const working = ref(false)
const loading = ref(true)
const error = ref('')
const notice = ref('')
const activeId = ref('')
let interval: ReturnType<typeof setInterval> | undefined
let disposed = false
const answers = computed(() =>
  [
    ...props.task.turns
      .filter(
        (turn) =>
          turn.state === 'answered' && turn.review.confirmed && turn.answer.status === 'published'
      )
      .map((turn) => ({
        kind: 'turn' as const,
        id: turn.id,
        candidateHash: turn.answer.candidateHash,
        label: `${t('analysis.reports.turnKind')} · ${turn.question}`,
        publishedAt: turn.answer.publishedAt!
      })),
    ...props.task.runs
      .filter((run) => run.answer.status === 'published')
      .map((run) => ({
        kind: 'run' as const,
        id: run.id,
        candidateHash: run.answer.candidateHash,
        label: `${t('analysis.reports.runKind')} · ${run.plan.question || run.measureLabel}`,
        publishedAt: run.answer.publishedAt!
      }))
  ].sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))
)
const key = (answer: { kind: string; id: string }) => `${answer.kind}:${answer.id}`
const answer = computed(() => answers.value.find((answer) => key(answer) === selected.value))
watch(
  [answers, () => props.initialTarget],
  () => {
    const initial =
      props.initialTarget &&
      answers.value.find(
        (answer) =>
          answer.kind === props.initialTarget?.kind && answer.id === props.initialTarget.id
      )
    if (initial) selected.value = key(initial)
    else if (!answers.value.some((answer) => key(answer) === selected.value))
      selected.value = answers.value[0] ? key(answers.value[0]) : ''
  },
  { immediate: true }
)
function showError(cause: unknown) {
  const code =
    cause instanceof Error &&
    AnalysisErrorCodes.includes(cause.message as (typeof AnalysisErrorCodes)[number])
      ? cause.message
      : 'STORAGE_ERROR'
  error.value = t(`analysis.errors.${code}`)
}
function poll() {
  if (interval) clearInterval(interval)
  interval = undefined
  if (records.value.some((record) => record.status === 'rendering'))
    interval = setInterval(() => {
      void load(false)
    }, 1000)
}
async function load(initial = true) {
  try {
    const result = await client.reports(props.task.id)
    if (disposed) return
    records.value = result
    poll()
  } catch (cause) {
    if (!disposed) showError(cause)
  } finally {
    if (initial) loading.value = false
  }
}
async function act(action: () => Promise<void>) {
  if (working.value) return
  working.value = true
  error.value = ''
  notice.value = ''
  try {
    await action()
  } catch (cause) {
    showError(cause)
  } finally {
    working.value = false
  }
}
function upsert(record: ReportRecord) {
  activeId.value = record.id
  records.value = [record, ...records.value.filter((item) => item.id !== record.id)]
  poll()
}
async function generate() {
  if (!answer.value || !title.value.trim()) return
  const reference: ReportAnswer = {
    kind: answer.value.kind,
    id: answer.value.id,
    candidateHash: answer.value.candidateHash
  }
  await act(async () => {
    upsert(
      await client.createReport(props.task.id, {
        requestId: crypto.randomUUID(),
        answer: reference,
        options: { format: format.value, locale: reportLocale.value, title: title.value.trim() }
      })
    )
  })
}
async function retry(record: ReportRecord) {
  await act(async () => {
    upsert(await client.retryReport(props.task.id, record.id))
  })
}
async function cancel(record: ReportRecord) {
  await act(async () => {
    await client.cancelReport(props.task.id, record.id)
    await load(false)
  })
}
async function save(record: ReportRecord, kind: 'pdf' | 'evidence') {
  await act(async () => {
    const path = await client.saveReport(props.task.id, record.id, kind)
    if (path) notice.value = t('analysis.reports.saved', { path })
  })
}
async function open(record: ReportRecord) {
  await act(async () => {
    await client.openReport(props.task.id, record.id)
  })
}
async function reveal(record: ReportRecord) {
  await act(async () => {
    await client.revealReport(props.task.id, record.id)
  })
}
const last = (record: ReportRecord) => record.attempts.at(-1)!
const date = (value: string) => new Date(value).toLocaleString()
const size = (bytes: number) =>
  `${(bytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB`
onMounted(() => {
  void load()
})
onBeforeUnmount(() => {
  disposed = true
  if (interval) clearInterval(interval)
})
</script>
<template>
  <section
    class="analysis-reports"
    data-testid="analysis-reports"
    :aria-label="t('analysis.reports.title')"
  >
    <div class="reports-heading">
      <div>
        <h2>{{ t('analysis.reports.title') }}</h2>
        <p class="analysis-muted">{{ t('analysis.reports.intro') }}</p>
      </div>
      <button type="button" class="analysis-button" :disabled="working" @click="load(false)">
        <Icon icon="lucide:refresh-cw" aria-hidden="true" />{{ t('analysis.reports.refresh') }}
      </button>
    </div>
    <p v-if="error" class="analysis-error reports-error" role="alert" data-testid="report-error">
      {{ error }}
    </p>
    <p v-if="notice" class="analysis-notice" role="status" data-testid="report-notice">
      {{ notice }}
    </p>
    <form v-if="answers.length" class="report-form" @submit.prevent="generate">
      <label class="report-wide"
        >{{ t('analysis.reports.answer')
        }}<select v-model="selected" data-testid="report-answer" :disabled="working">
          <option v-for="item in answers" :key="key(item)" :value="key(item)">
            {{ item.label }} · {{ date(item.publishedAt) }}
          </option>
        </select></label
      >
      <label class="report-wide"
        >{{ t('analysis.reports.reportTitle')
        }}<Input v-model="title" data-testid="report-title" maxlength="160" :disabled="working"
      /></label>
      <label
        >{{ t('analysis.reports.format')
        }}<select v-model="format" data-testid="report-format" :disabled="working">
          <option value="a4">{{ t('analysis.reports.a4') }}</option>
          <option value="slides">{{ t('analysis.reports.slides') }}</option>
        </select></label
      >
      <label
        >{{ t('analysis.reports.language')
        }}<select v-model="reportLocale" data-testid="report-language" :disabled="working">
          <option value="zh-CN">简体中文</option>
          <option value="en-US">English</option>
        </select></label
      >
      <div class="report-form-actions report-wide">
        <p class="analysis-muted">{{ t('analysis.reports.freezeHint') }}</p>
        <Button
          type="submit"
          data-testid="report-create"
          :disabled="working || !answer || !title.trim()"
          ><Icon
            :icon="working ? 'lucide:loader-circle' : 'lucide:file-down'"
            :class="{ spinning: working }"
            aria-hidden="true"
          />{{ t('analysis.reports.generate') }}</Button
        >
      </div>
    </form>
    <div v-else class="reports-empty" data-testid="report-no-answer">
      <Icon icon="lucide:file-check-2" aria-hidden="true" />
      <h3>{{ t('analysis.reports.needPublished') }}</h3>
      <p class="analysis-muted">{{ t('analysis.reports.needPublishedHint') }}</p>
    </div>
    <div class="reports-history-heading">
      <h3>{{ t('analysis.reports.history') }}</h3>
      <span class="analysis-muted">{{ records.length }}</span>
    </div>
    <p v-if="loading" class="analysis-muted" role="status">{{ t('analysis.working') }}</p>
    <p v-else-if="!records.length" class="analysis-muted">{{ t('analysis.reports.noReports') }}</p>
    <ol v-else class="report-list">
      <li
        v-for="record in records"
        :key="record.id"
        class="report-entry"
        :class="{ 'report-active': activeId === record.id }"
        :data-testid="`report-${record.id}`"
        :data-report-status="record.status"
      >
        <div class="report-entry-title">
          <h4>{{ record.options.title }}</h4>
          <span
            :class="['report-status', `status-${record.status}`]"
            :data-testid="`report-status-${record.id}`"
            role="status"
            ><Icon
              v-if="record.status === 'rendering'"
              icon="lucide:loader-circle"
              class="spinning"
              aria-hidden="true"
            />{{
              record.status === 'rendering'
                ? t(`analysis.reports.stages.${record.stage}`)
                : t(`analysis.reports.status.${record.status}`)
            }}</span
          >
        </div>
        <p class="analysis-muted report-meta">
          {{
            t(record.options.format === 'a4' ? 'analysis.reports.a4' : 'analysis.reports.slides')
          }}
          · {{ date(record.createdAt)
          }}<template v-if="last(record).pages">
            · {{ t('analysis.reports.pages', { count: last(record).pages }) }} ·
            {{ size(last(record).bytes!) }}</template
          >
          · {{ t('analysis.reports.attempts', { count: record.attempts.length }) }}
        </p>
        <p
          v-if="last(record).error"
          class="analysis-notice"
          :data-testid="`report-attempt-error-${record.id}`"
        >
          {{ t(`analysis.errors.${last(record).error}`) }}
        </p>
        <p class="report-fingerprint">
          {{ t('analysis.reports.fingerprint') }} <span>{{ record.snapshotHash }}</span>
        </p>
        <div class="report-actions">
          <template v-if="record.status === 'ready'"
            ><Button
              type="button"
              variant="outline"
              :data-testid="`report-open-${record.id}`"
              :disabled="working"
              @click="open(record)"
              >{{ t('analysis.reports.preview') }}</Button
            ><Button
              type="button"
              :data-testid="`report-save-${record.id}`"
              :disabled="working"
              @click="save(record, 'pdf')"
              >{{ t('analysis.reports.savePdf') }}</Button
            ><button
              type="button"
              class="analysis-button"
              :disabled="working"
              @click="reveal(record)"
            >
              {{ t('analysis.reports.reveal') }}
            </button></template
          >
          <button
            type="button"
            class="analysis-button"
            :data-testid="`report-evidence-${record.id}`"
            :disabled="working || record.status === 'rendering'"
            @click="save(record, 'evidence')"
          >
            {{ t('analysis.reports.saveEvidence') }}
          </button>
          <button
            v-if="record.status === 'rendering'"
            type="button"
            class="analysis-button"
            :data-testid="`report-cancel-${record.id}`"
            :disabled="working"
            @click="cancel(record)"
          >
            {{ t('analysis.reports.cancel') }}
          </button>
          <button
            v-else
            type="button"
            class="analysis-button"
            :data-testid="`report-retry-${record.id}`"
            :disabled="working"
            @click="retry(record)"
          >
            {{
              t(
                record.status === 'ready' ? 'analysis.reports.regenerate' : 'analysis.reports.retry'
              )
            }}
          </button>
        </div>
        <details class="report-attempts">
          <summary>{{ t('analysis.reports.attemptHistory') }}</summary>
          <ul>
            <li v-for="attempt in record.attempts" :key="attempt.number">
              <span
                >{{ t('analysis.reports.attempt', { number: attempt.number }) }} ·
                {{ date(attempt.startedAt) }} ·
                {{ t(`analysis.reports.status.${attempt.status}`) }}</span
              >
              <p v-if="attempt.error">{{ t(`analysis.errors.${attempt.error}`) }}</p>
            </li>
          </ul>
        </details>
      </li>
    </ol>
    <p class="analysis-muted reports-footer">{{ t('analysis.reports.outputHint') }}</p>
  </section>
</template>
<style scoped>
.analysis-reports {
  padding: 24px 28px 40px;
  width: 100%;
  max-width: 1340px;
  margin-inline: auto;
}
.reports-heading,
.reports-history-heading,
.report-entry-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.reports-heading {
  align-items: flex-start;
}
.reports-heading h2 {
  font-size: 18px;
  font-weight: 600;
  margin: 0 0 8px;
}
.reports-heading > button {
  flex-shrink: 0;
}
.report-form {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
  margin-top: 25px;
  padding-bottom: 25px;
  border-bottom: 1px solid var(--border);
}
.report-wide {
  grid-column: 1/-1;
}
.report-form-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 18px;
}
.report-form-actions p {
  margin: 0;
  max-width: 72ch;
}
.report-form-actions button {
  flex-shrink: 0;
}
.reports-history-heading {
  margin: 28px 0 6px;
  justify-content: flex-start;
}
.reports-history-heading h3 {
  font-size: 14px;
  font-weight: 600;
}
.report-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.report-entry {
  padding: 22px 0;
  border-bottom: 1px solid var(--border);
}
.report-entry-title h4 {
  font-size: 15px;
  font-weight: 600;
  overflow-wrap: anywhere;
  margin: 0;
}
.report-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  font-size: 12px;
  color: var(--analysis-muted);
}
.report-status svg {
  width: 14px;
  height: 14px;
}
.status-ready,
.status-rendering {
  color: var(--analysis-blue);
}
.report-meta {
  margin: 8px 0;
}
.report-fingerprint {
  font-size: 11px;
  color: var(--analysis-muted);
  overflow-wrap: anywhere;
  line-height: 1.7;
  margin: 10px 0 14px;
}
.report-fingerprint span {
  font-variant-numeric: tabular-nums;
}
.report-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 9px;
}
.report-attempts {
  font-size: 12px;
  color: var(--analysis-muted);
  margin-top: 15px;
}
.report-attempts summary {
  cursor: pointer;
}
.report-attempts li {
  padding-top: 10px;
}
.reports-footer {
  margin: 28px 0 0;
  max-width: 85ch;
}
.reports-empty {
  padding: 28px 0 12px;
  max-width: 70ch;
}
.reports-empty > svg {
  color: var(--analysis-blue);
  width: 25px;
  height: 25px;
  margin-bottom: 14px;
}
.reports-empty h3 {
  font-size: 16px;
  font-weight: 600;
}
.reports-error {
  padding-inline: 0;
}
.report-active {
  scroll-margin-top: 16px;
}
@media (max-width: 900px) {
  .analysis-reports {
    padding-inline: 20px;
  }
  .report-form {
    grid-template-columns: 1fr;
  }
  .report-form-actions {
    align-items: flex-start;
    flex-direction: column;
  }
  .report-entry-title {
    align-items: flex-start;
  }
  .report-status {
    white-space: normal;
  }
  .reports-heading {
    flex-wrap: wrap;
  }
}
</style>
