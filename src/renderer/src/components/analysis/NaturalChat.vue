<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { Button } from '@shadcn/components/ui/button'
import { Textarea } from '@shadcn/components/ui/textarea'
import { createAnalysisClient } from '@api/AnalysisClient'
import { createConfigClient } from '@api/ConfigClient'
import {
  AnalysisErrorCodes,
  type AnalysisTask,
  type AnalysisModel,
  type NaturalProgress,
  type NaturalAsk
} from '@shared/analysis'
import NaturalAnswer from './NaturalAnswer.vue'
import AnalysisMap from './AnalysisMap.vue'
import NaturalDataSelection from './NaturalDataSelection.vue'
import RetrievalTrace from './RetrievalTrace.vue'
import type { RetrievalSelection } from '@shared/analysisAcquisition'
const props = defineProps<{ task: AnalysisTask; globalBusy: boolean; selectedTurnId?: string }>()
const emit = defineEmits<{
  updated: [task: AnalysisTask]
  busy: [busy: boolean]
  inspect: [runId: string, valueId: string]
  derived: [turnId: string, factId: string]
  report: [kind: 'turn', id: string]
  source: [id: string]
  'update:selectedTurnId': [id: string]
}>()
const { t } = useI18n()
const client = createAnalysisClient()
const config = createConfigClient()
const models = ref<AnalysisModel[]>([])
const selectedModel = ref('')
const question = ref('')
const retrieval = ref<RetrievalSelection>()
const localBusy = ref(false)
const requestId = ref('')
const progress = ref<NaturalProgress | null>(null)
const error = ref('')
const selectedTurnId = ref(props.selectedTurnId ?? props.task.turns.at(-1)?.id ?? '')
watch(
  () => props.selectedTurnId,
  (id) => {
    if (id !== undefined && id !== selectedTurnId.value) selectedTurnId.value = id
  }
)
watch(selectedTurnId, (id) => emit('update:selectedTurnId', id))
let interval: ReturnType<typeof setInterval> | undefined
const modelKey = (model: AnalysisModel) => JSON.stringify([model.providerId, model.modelId])
const model = computed(() => models.value.find((model) => modelKey(model) === selectedModel.value))
const turn = computed(() => props.task.turns.find((turn) => turn.id === selectedTurnId.value))
const historicalChanged = computed(
  () =>
    turn.value?.queryRuns.some((reference) => {
      const run = props.task.runs.find((run) => run.id === reference.runId)
      return (
        !run ||
        props.task.sources.find((source) => source.id === run.source.id)?.sha256 !==
          run.source.sha256
      )
    }) ?? false
)
const scopeQuery = ref('')
const scopeValue = ref('')
const scopeSearch = ref('')
const focusQuestionId = ref('')
const composer = ref<HTMLElement | null>(null)
const scopedRun = computed(() =>
  props.task.runs.find(
    (run) =>
      run.id ===
      turn.value?.queryRuns.find((reference) => reference.key === scopeQuery.value)?.runId
  )
)
const matches = computed(
  () =>
    scopedRun.value?.values.filter(
      (value) =>
        value.inputs.length &&
        (value.category + ' ' + value.value + ' ' + value.id)
          .toLocaleLowerCase()
          .includes(scopeSearch.value.toLocaleLowerCase())
    ) ?? []
)
const scopeValues = computed(() => {
  const first = matches.value.slice(0, 100)
  const selected = scopedRun.value?.values.find((value) => value.id === scopeValue.value)
  return selected && !first.some((value) => value.id === selected.id) ? [selected, ...first] : first
})
const continuation = computed<NaturalAsk['continuation']>(() =>
  turn.value
    ? {
        parentTurnId: turn.value.id,
        parentCandidateHash: turn.value.answer.candidateHash,
        ...(focusQuestionId.value ? { questionId: focusQuestionId.value } : {}),
        ...(scopeQuery.value
          ? {
              scope: {
                queryKey: scopeQuery.value,
                ...(scopeValue.value ? { valueId: scopeValue.value } : {})
              }
            }
          : {})
      }
    : undefined
)
const scopeRowCount = computed(() =>
  scopeValue.value
    ? new Set(
        scopedRun.value?.values
          .find((value) => value.id === scopeValue.value)
          ?.inputs.map((input) => input.row) ?? []
      ).size
    : inheritedScope.value?.rowScope?.rows.length
)
const inheritedScope = computed(() => {
  if (scopedRun.value) return scopedRun.value.plan
  if (!turn.value?.context?.scope) return undefined
  const onlyQuery = turn.value.queryRuns.length === 1 ? turn.value.queryRuns[0] : undefined
  return (
    props.task.runs.find((run) => run.id === onlyQuery?.runId)?.plan ??
    turn.value.context.scope.plan
  )
})
watch(
  selectedTurnId,
  () => {
    scopeQuery.value = ''
    scopeValue.value = ''
    scopeSearch.value = ''
    focusQuestionId.value = ''
  },
  { flush: 'sync' }
)
watch([selectedTurnId, scopeQuery, scopeValue, focusQuestionId], () => {
  try {
    localStorage.setItem(draftKey + '.branch', JSON.stringify(continuation.value ?? null))
  } catch {
    /* The branch remains selected in memory. */
  }
})
function chooseQuery() {
  scopeValue.value = ''
  scopeSearch.value = ''
}
async function focusComposer() {
  await nextTick()
  composer.value?.scrollIntoView({ block: 'start', behavior: 'instant' })
  composer.value?.querySelector('textarea')?.focus()
}
function drillQuery(key: string) {
  scopeQuery.value = key
  chooseQuery()
  void focusComposer()
}
function continueQuestion(id: string) {
  focusQuestionId.value = id
  void focusComposer()
}
function newQuestion() {
  selectedTurnId.value = ''
  void focusComposer()
}
const canAsk = computed(
  () =>
    !localBusy.value &&
    !props.globalBusy &&
    !!model.value &&
    !!question.value.trim() &&
    (retrieval.value ? !!retrieval.value.targetIds.length : !!props.task.sources.length)
)
const draftKey = `semapath.natural.draft.${props.task.id}`
function showError(cause: unknown) {
  const code =
    cause instanceof Error &&
    AnalysisErrorCodes.includes(cause.message as (typeof AnalysisErrorCodes)[number])
      ? cause.message
      : 'STORAGE_ERROR'
  error.value = t(`analysis.errors.${code}`)
}
async function loadModels() {
  try {
    models.value = await client.models()
    if (!models.value.some((model) => modelKey(model) === selectedModel.value)) {
      const fallback = models.value.find((model) => model.isDefault) ?? models.value[0]
      selectedModel.value = fallback ? modelKey(fallback) : ''
    }
  } catch (cause) {
    showError(cause)
  }
}
watch(question, (value) => {
  try {
    localStorage.setItem(draftKey, value)
  } catch {
    /* The question remains available in memory. */
  }
})
watch(selectedModel, (value) => {
  try {
    localStorage.setItem('semapath.natural.model', value)
  } catch {
    /* Model selection remains usable. */
  }
})
watch(
  () => props.task.turns.length,
  () => {
    selectedTurnId.value = props.task.turns.at(-1)?.id ?? ''
  }
)
function setBusy(busy: boolean) {
  localBusy.value = busy
  emit('busy', busy)
}
async function ask() {
  if (!canAsk.value || !model.value) return
  const selected = model.value
  setBusy(true)
  error.value = ''
  requestId.value = crypto.randomUUID()
  progress.value = null
  interval = setInterval(() => {
    void client
      .status(props.task.id)
      .then((value) => {
        progress.value = value
      })
      .catch(() => {})
  }, 1200)
  try {
    const updated = await client.ask(props.task.id, {
      requestId: requestId.value,
      question: question.value.trim(),
      providerId: selected.providerId,
      modelId: selected.modelId,
      ...(retrieval.value ? { retrieval: retrieval.value } : {}),
      ...(continuation.value ? { continuation: continuation.value } : { newRoot: true })
    })
    emit('updated', updated)
    selectedTurnId.value = updated.turns.at(-1)?.id ?? ''
    question.value = ''
  } catch (cause) {
    showError(cause)
  } finally {
    if (interval) clearInterval(interval)
    interval = undefined
    requestId.value = ''
    progress.value = null
    setBusy(false)
  }
}
async function stop() {
  if (!requestId.value) return
  try {
    await client.cancel(props.task.id, requestId.value)
  } catch (cause) {
    showError(cause)
  }
}
async function publish() {
  if (!turn.value || localBusy.value || props.globalBusy) return
  const current = turn.value
  setBusy(true)
  error.value = ''
  try {
    emit(
      'updated',
      await client.publishTurn(props.task.id, current.id, current.answer.candidateHash)
    )
  } catch (cause) {
    showError(cause)
  } finally {
    setBusy(false)
  }
}
onMounted(() => {
  try {
    question.value = localStorage.getItem(draftKey) ?? ''
    const savedBranch = localStorage.getItem(draftKey + '.branch')
    if (savedBranch) {
      const branch = JSON.parse(savedBranch) as NaturalAsk['continuation'] | null
      if (!branch) selectedTurnId.value = ''
      else if (
        props.task.turns.some(
          (item) =>
            item.id === branch.parentTurnId &&
            item.answer.candidateHash === branch.parentCandidateHash
        )
      ) {
        selectedTurnId.value = branch.parentTurnId
        focusQuestionId.value = branch.questionId ?? ''
        scopeQuery.value = branch.scope?.queryKey ?? ''
        scopeValue.value = branch.scope?.valueId ?? ''
      }
    }
    selectedModel.value = localStorage.getItem('semapath.natural.model') ?? ''
  } catch {
    /* Use fresh defaults. */
  }
  void loadModels()
  window.addEventListener('focus', loadModels)
})
onBeforeUnmount(() => {
  window.removeEventListener('focus', loadModels)
  if (interval) clearInterval(interval)
  if (requestId.value) void client.cancel(props.task.id, requestId.value).catch(() => {})
})
</script>
<template>
  <section
    class="natural-chat"
    data-testid="natural-chat"
    :aria-label="t('analysis.natural.naturalTitle')"
  >
    <AnalysisMap
      v-if="task.turns.length"
      :task="task"
      :selected-id="selectedTurnId"
      :disabled="localBusy || globalBusy"
      @select="selectedTurnId = $event"
    />
    <div v-if="task.turns.length" class="natural-history">
      <label
        >{{ t('analysis.natural.questionHistory')
        }}<select v-model="selectedTurnId" data-testid="natural-history">
          <option v-for="item in [...task.turns].reverse()" :key="item.id" :value="item.id">
            {{ item.question }} · {{ new Date(item.createdAt).toLocaleString() }}
          </option>
        </select></label
      >
    </div>
    <div v-if="turn" class="natural-response">
      <div class="natural-response-meta">
        <span>{{ turn.model.providerName }} · {{ turn.model.modelName }}</span
        ><span>{{
          t(
            turn.answer.status === 'published'
              ? 'analysis.natural.published'
              : turn.state === 'answered'
                ? 'analysis.natural.draft'
                : `analysis.natural.${turn.state}`
          )
        }}</span>
      </div>
      <p v-if="historicalChanged" class="analysis-notice">
        {{ t('analysis.natural.versionChanged') }}
      </p>
      <RetrievalTrace
        v-if="turn.retrieval"
        :trace="turn.retrieval"
        :task="task"
        @source="emit('source', $event)"
      />
      <template v-if="turn.state === 'answered'"
        ><NaturalAnswer
          :task="task"
          :turn="turn"
          @inspect="(runId, valueId) => emit('inspect', runId, valueId)"
          @derived="(turnId, factId) => emit('derived', turnId, factId)"
          @scope="drillQuery"
          @continue="continueQuestion"
        />
        <div v-if="turn.answer.status === 'draft'" class="publish-row">
          <p class="analysis-muted">{{ t('analysis.natural.publishHint') }}</p>
          <Button
            data-testid="natural-publish"
            :disabled="localBusy || globalBusy || historicalChanged"
            @click="publish"
            ><Icon icon="lucide:check" aria-hidden="true" />{{
              t('analysis.natural.publish')
            }}</Button
          >
        </div>
        <div v-else class="published-actions">
          <p class="published-status" data-testid="natural-published">
            <Icon icon="lucide:circle-check" aria-hidden="true" />{{
              t('analysis.publishedAt', {
                time: new Date(turn.answer.publishedAt!).toLocaleString()
              })
            }}
          </p>
          <Button
            variant="outline"
            data-testid="natural-export-report"
            @click="emit('report', 'turn', turn.id)"
            ><Icon icon="lucide:file-down" aria-hidden="true" />{{
              t('analysis.reports.export')
            }}</Button
          >
        </div></template
      >
      <div v-else class="natural-clarification" data-testid="natural-clarification">
        <h2>{{ t(`analysis.natural.${turn.state}`) }}</h2>
        <p class="analysis-muted">{{ turn.question }}</p>
        <p>{{ turn.message }}</p>
      </div>
    </div>
    <div v-else class="natural-empty">
      <Icon icon="lucide:chart-no-axes-combined" aria-hidden="true" />
      <h2>{{ t('analysis.natural.emptyTitle') }}</h2>
      <p>{{ t('analysis.natural.emptyHint') }}</p>
    </div>
    <form ref="composer" class="natural-composer" @submit.prevent="ask">
      <div class="branch-heading">
        <p v-if="turn" data-testid="analysis-branch-parent">
          {{ t('analysis.framework.following') }}: {{ turn.question }}
        </p>
        <p v-else>{{ t('analysis.framework.newRoot') }}</p>
        <Button
          v-if="turn"
          type="button"
          variant="outline"
          data-testid="analysis-new-root"
          :disabled="localBusy || globalBusy"
          @click="newQuestion"
        >
          <Icon icon="lucide:plus" aria-hidden="true" />{{ t('analysis.framework.newQuestion') }}
        </Button>
      </div>
      <p v-if="focusQuestionId" class="analysis-muted">
        {{ t('analysis.framework.focusQuestion') }}:
        {{ turn?.framework?.questions.find((item) => item.id === focusQuestionId)?.text }}
      </p>
      <div v-if="turn?.state === 'answered'" class="branch-scope">
        <label
          >{{ t('analysis.framework.scope') }}
          <select
            v-model="scopeQuery"
            data-testid="analysis-scope-query"
            :disabled="localBusy || globalBusy"
            @change="chooseQuery"
          >
            <option value="">{{ t('analysis.framework.followContext') }}</option>
            <option v-for="reference in turn.queryRuns" :key="reference.key" :value="reference.key">
              {{ reference.key }} ·
              {{
                task.runs.find((run) => run.id === reference.runId)?.measureLabel ||
                t('analysis.count')
              }}
              ·
              {{
                task.runs.find((run) => run.id === reference.runId)?.groupLabel ||
                t('analysis.allRows')
              }}
            </option>
          </select>
        </label>
        <template v-if="scopedRun">
          <label
            >{{ t('analysis.framework.searchValue')
            }}<input
              v-model="scopeSearch"
              type="search"
              data-testid="analysis-scope-search"
              :disabled="localBusy || globalBusy"
          /></label>
          <label
            >{{ t('analysis.framework.valueScope') }}
            <select
              v-model="scopeValue"
              data-testid="analysis-scope-value"
              :disabled="localBusy || globalBusy"
            >
              <option value="">{{ t('analysis.framework.wholeQuery') }}</option>
              <option v-for="value in scopeValues" :key="value.id" :value="value.id">
                {{ value.category || scopedRun.measureLabel || t('analysis.allRows') }} ·
                {{ value.value }}
              </option>
            </select>
          </label>
          <p class="analysis-muted">
            {{
              t('analysis.framework.valueMatches', {
                shown: scopeValues.length,
                total: matches.length
              })
            }}
          </p>
        </template>
      </div>
      <p v-if="inheritedScope" class="analysis-notice" data-testid="analysis-scope-notice">
        {{
          t(
            scopeValue || inheritedScope.rowScope
              ? 'analysis.framework.inputRowsNotice'
              : 'analysis.framework.queryScopeNotice'
          )
        }}
        {{
          scopeRowCount != null
            ? t('analysis.framework.rowCount', { count: scopeRowCount }) + ' · '
            : ''
        }}{{ inheritedScope.sheet }} ·
        {{
          inheritedScope.filters
            .map(
              (filter) =>
                filter.column +
                ' ' +
                t('analysis.' + filter.operator) +
                ' ' +
                (filter.operator === 'in' ? (filter.values ?? []).join(', ') : filter.value)
            )
            .join('; ') || t('analysis.noFilter')
        }}
      </p>
      <NaturalDataSelection
        v-model="retrieval"
        :task="task"
        :busy="localBusy || globalBusy"
        :locked="!!inheritedScope"
      />
      <label :for="`natural-question-${task.id}`">{{ t('analysis.natural.question') }}</label>
      <Textarea
        :id="`natural-question-${task.id}`"
        v-model="question"
        data-testid="natural-question"
        :placeholder="
          t(turn ? 'analysis.natural.followupPlaceholder' : 'analysis.natural.placeholder')
        "
        maxlength="4000"
        :disabled="localBusy || globalBusy"
        rows="3"
        @keydown.ctrl.enter.prevent="ask"
        @keydown.meta.enter.prevent="ask"
      />
      <div
        v-if="error"
        class="analysis-error natural-error"
        role="alert"
        data-testid="natural-error"
      >
        <Icon icon="lucide:circle-alert" aria-hidden="true" /><span>{{ error }}</span>
      </div>
      <div v-if="requestId" role="status" class="natural-progress" data-testid="natural-progress">
        <Icon icon="lucide:loader-circle" class="spinning" aria-hidden="true" />{{
          t(`analysis.natural.stages.${progress?.stage ?? 'preparing'}`)
        }}
      </div>
      <div class="natural-composer-actions">
        <label class="model-field"
          >{{ t('analysis.natural.model')
          }}<select
            v-model="selectedModel"
            data-testid="natural-model"
            :disabled="localBusy || globalBusy || !models.length"
          >
            <option v-for="item in models" :key="modelKey(item)" :value="modelKey(item)">
              {{ item.providerName }} · {{ item.modelName }}
            </option>
          </select></label
        ><button
          type="button"
          class="icon-button"
          data-testid="natural-refresh-models"
          :title="t('analysis.natural.refreshModels')"
          :aria-label="t('analysis.natural.refreshModels')"
          :disabled="localBusy"
          @click="loadModels"
        >
          <Icon icon="lucide:refresh-cw" aria-hidden="true" /></button
        ><Button
          v-if="requestId"
          data-testid="natural-stop"
          type="button"
          variant="outline"
          @click="stop"
          ><Icon icon="lucide:square" aria-hidden="true" />{{ t('analysis.natural.stop') }}</Button
        ><Button v-else type="submit" data-testid="natural-ask" :disabled="!canAsk"
          ><Icon icon="lucide:arrow-up" aria-hidden="true" />{{
            t(turn?.state === 'clarify' ? 'analysis.natural.continue' : 'analysis.natural.ask')
          }}</Button
        >
      </div>
      <p class="analysis-muted composer-scope">
        {{
          retrieval
            ? t('analysis.retrieval.selectionSummary', {
                connections: retrieval.targetIds.length,
                files: retrieval.sourceIds.length
              })
            : task.sources.length
              ? t('analysis.natural.sources', { count: task.sources.length })
              : t('analysis.natural.needData')
        }}
        · {{ t('analysis.natural.modelScope') }}
      </p>
      <div v-if="!models.length" class="model-empty">
        <p class="analysis-muted">{{ t('analysis.natural.noModel') }}</p>
        <button
          type="button"
          class="analysis-button"
          data-testid="natural-configure-model"
          @click="config.openSettings()"
        >
          {{ t('analysis.natural.configureModel') }}
        </button>
      </div>
    </form>
  </section>
</template>
<style scoped>
.branch-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}
.branch-heading p {
  flex: 1;
  min-width: 180px;
  overflow-wrap: anywhere;
  line-height: 1.7;
  margin: 0;
}
.branch-scope {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 18px;
}
.branch-scope label {
  display: grid;
  gap: 6px;
  font-size: 12px;
  min-width: 0;
}
.branch-scope select,
.branch-scope input {
  width: 100%;
  min-width: 0;
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 8px;
  font-size: 13px;
  color: var(--foreground);
}
.branch-scope input:focus-visible,
.branch-scope select:focus-visible {
  outline: 2px solid var(--analysis-blue);
  outline-offset: 2px;
}
.branch-scope p {
  align-self: end;
  font-size: 12px;
  line-height: 1.7;
  margin: 0;
}
@media (max-width: 1050px) {
  .branch-scope {
    grid-template-columns: minmax(0, 1fr);
  }
}
.natural-chat {
  padding: 22px 28px 34px;
  max-width: 1340px;
  margin-inline: auto;
  width: 100%;
}
.natural-history {
  max-width: 760px;
  margin-bottom: 22px;
}
.natural-history select {
  text-overflow: ellipsis;
}
.natural-response-meta {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  color: var(--analysis-muted);
  font-size: 12px;
  margin-bottom: 18px;
}
.natural-empty {
  min-height: 180px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 12px;
  max-width: 64ch;
}
.natural-empty > svg {
  color: var(--analysis-blue);
  width: 27px;
  height: 27px;
}
.natural-empty h2,
.natural-clarification h2 {
  font-size: 20px;
  font-weight: 600;
  margin: 0;
}
.natural-empty p {
  color: var(--analysis-muted);
  line-height: 1.8;
  margin: 0 0 18px;
}
.natural-composer {
  position: static;
  margin-top: 24px;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px;
  background: var(--background);
}
.natural-composer > label {
  margin-bottom: 10px;
  color: var(--foreground);
  font-size: 13px;
}
.natural-composer textarea {
  resize: vertical;
  min-height: 90px;
  max-height: 320px;
  font-size: 13px;
  border: 0;
  padding: 0;
  box-shadow: none;
  border-radius: 0;
}
.natural-composer-actions {
  display: flex;
  align-items: end;
  gap: 10px;
  margin-top: 14px;
}
.model-field {
  max-width: 420px;
  flex: 1;
}
.natural-composer-actions > button:last-child {
  margin-left: auto;
  flex-shrink: 0;
}
.composer-scope {
  margin: 14px 0 0;
  font-size: 11px;
}
.model-empty {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  margin-top: 15px;
  border-top: 1px solid var(--border);
  padding-top: 12px;
}
.model-empty p {
  margin: 0;
  flex: 1;
}
.natural-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--analysis-blue);
  margin-top: 20px;
}
.natural-progress svg {
  width: 16px;
  height: 16px;
}
.natural-error {
  padding-inline: 0;
  border-bottom: 0;
  color: color-mix(in srgb, var(--destructive) 72%, var(--foreground));
}
:global(.dark .natural-chat .natural-error) {
  color: color-mix(in srgb, var(--destructive) 50%, var(--foreground));
}
.natural-clarification {
  padding: 18px 0;
}
.natural-clarification p {
  line-height: 1.8;
}
@media (max-width: 1100px) {
  .natural-chat {
    padding-inline: 20px;
  }
}
@media (max-width: 760px) {
  .natural-chat {
    padding-inline: 16px;
  }
  .natural-composer-actions {
    flex-wrap: wrap;
  }
  .model-empty {
    flex-direction: column;
  }
}
</style>
