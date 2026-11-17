<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onBeforeUnmount,
  ref,
  watch,
  provide,
  defineAsyncComponent
} from 'vue'
import { useRoute } from 'vue-router'
import TaskGettingStarted from '@/components/analysis/TaskGettingStarted.vue'
import AnalysisQuoteToolbar from '@/components/analysis/AnalysisQuoteToolbar.vue'
import { ANALYSIS_FOLLOWUP, type AnalysisInsertion } from '@/components/analysis/interactionContext'
import type { AnalysisContext, TaskPanelState, QuoteOrigin } from '@shared/analysisInteraction'
import { createSessionClient } from '@api/SessionClient'
import type { AnalysisWorkspaceEntry, AnalysisToolRecord } from '@shared/analysisWorkspace'
const TaskConversation = defineAsyncComponent(
  () => import('@/components/analysis/TaskConversation.vue')
)
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { Button } from '@shadcn/components/ui/button'
import { Input } from '@shadcn/components/ui/input'
import { createAnalysisClient } from '@api/AnalysisClient'
import { createConfigClient } from '@api/ConfigClient'
import { createDeviceClient } from '@api/DeviceClient'
import {
  AnalysisErrorCodes,
  type AnalysisTask,
  type AnalysisTaskSummary,
  type AnalysisPreview,
  type AnalysisPlan
} from '@shared/analysis'
import AnalysisChart from '@/components/analysis/AnalysisChart.vue'
import MethodForm from '@/components/analysis/MethodForm.vue'
import MethodAnswer from '@/components/analysis/MethodAnswer.vue'
import type { StudyPlan } from '@shared/analysisStudy'
import AnalysisEvidence from '@/components/analysis/AnalysisEvidence.vue'
import WorkbookPreview from '@/components/analysis/WorkbookPreview.vue'
import NaturalChat from '@/components/analysis/NaturalChat.vue'
import NaturalDerivedEvidence from '@/components/analysis/NaturalDerivedEvidence.vue'
import AnalysisReports from '@/components/analysis/AnalysisReports.vue'
import SqlConnectionPanel from '@/components/analysis/SqlConnectionPanel.vue'
import PowerBiConnectionPanel from '@/components/analysis/PowerBiConnectionPanel.vue'
import JoinDatasetForm from '@/components/analysis/JoinDatasetForm.vue'
import DataOrigin from '@/components/analysis/DataOrigin.vue'

const { t } = useI18n()
const props = defineProps<{ showGuide?: boolean }>()
const guideOpen = ref(!!props.showGuide)
const client = createAnalysisClient()
const config = createConfigClient()
const device = createDeviceClient()
const tasks = ref<AnalysisTaskSummary[]>([])
const workspaceEntries = ref<AnalysisWorkspaceEntry[]>([])
const search = ref('')
const operations = ref<AnalysisToolRecord[]>([])
const route = useRoute()
const sessionClient = createSessionClient()
const chatLoading = ref(false)
const filteredEntries = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  return workspaceEntries.value.filter(
    (entry) =>
      !query ||
      entry.title.toLocaleLowerCase().includes(query) ||
      entry.projectDir?.toLocaleLowerCase().includes(query)
  )
})
const activeWorkspace = computed(() =>
  workspaceEntries.value.find((entry) => entry.taskId === task.value?.id)
)
const task = ref<AnalysisTask | null>(null)
const busy = ref(false)
const error = ref('')
const tab = ref<'conversation' | 'analysis' | 'evidence' | 'files' | 'reports'>('analysis')
const reportTarget = ref<{ kind: 'run' | 'turn'; id: string } | null>(null)
function goToReports(kind: 'run' | 'turn', id: string) {
  reportTarget.value = { kind, id }
  tab.value = 'reports'
}
const mode = ref<'natural' | 'manual'>('natural')
const selectedDerived = ref<{ turnId: string; factId: string } | null>(null)
const derivedFact = computed(() =>
  task.value?.turns
    .find((turn) => turn.id === selectedDerived.value?.turnId)
    ?.derived.find((fact) => fact.id === selectedDerived.value?.factId)
)
const connectionsOpen = ref(false)
const connector = ref('excel')
const pbiConnector = computed(
  () => connector.value === 'localPbi' || connector.value === 'cloudPbi'
)
const sourceId = ref('')
const sheet = ref('')
const headerRow = ref(1)
const preview = ref<AnalysisPreview | null>(null)
const previewLoading = ref(false)
let previewToken = 0
const study = ref<StudyPlan | undefined>()
const methodValid = ref(true)
const measure = ref('')
const groupBy = ref('')
const operation = ref<AnalysisPlan['operation']>('sum')
const question = ref('')
const unit = ref('')
const period = ref('')
const filterColumn = ref('')
const filterOperator = ref<AnalysisPlan['filters'][number]['operator']>('eq')
const filterValue = ref('')
const runId = ref('')
const selectedIndex = ref(0)
const calculationOpen = ref(true)
const toolsOpen = ref(false)
const selectedTurnId = ref('')
const pendingInsertion = ref<AnalysisInsertion | null>(null)
const mainPanel = ref<HTMLElement | null>(null)
const panelSidepanel = ref<TaskPanelState['sidepanel']>()
let restoringPanels = false
let panelOwner = ''
let panelTimer: ReturnType<typeof setTimeout> | undefined
let panelScroll: Record<string, number> = {}
const scrollKey = () => tab.value + ':' + mode.value
function snapshotPanels(): TaskPanelState {
  return {
    version: 1,
    tab: tab.value,
    mode: mode.value,
    connector: connector.value as TaskPanelState['connector'],
    connectionsOpen: connectionsOpen.value,
    calculationOpen: calculationOpen.value,
    toolsOpen: toolsOpen.value,
    sourceId: sourceId.value || null,
    sheet: sheet.value,
    headerRow: headerRow.value,
    runId: runId.value || null,
    valueIndex: selectedIndex.value,
    turnId: selectedTurnId.value || null,
    reportTarget: reportTarget.value,
    scroll: { ...panelScroll },
    sidepanel: panelSidepanel.value,
    selectedDerived: selectedDerived.value,
    manual: {
      question: question.value,
      unit: unit.value,
      period: period.value,
      measure: measure.value,
      groupBy: groupBy.value,
      operation: operation.value,
      filterColumn: filterColumn.value,
      filterOperator: filterOperator.value,
      filterValue: filterValue.value,
      study: study.value
    }
  }
}
async function persistPanels() {
  clearTimeout(panelTimer)
  if (!panelOwner || restoringPanels) return
  const id = panelOwner
  const state = snapshotPanels()
  try {
    await client.savePanels(id, state)
  } catch (cause) {
    if (!disposed) reportError(cause)
  }
}
function schedulePanels() {
  if (restoringPanels || !panelOwner) return
  clearTimeout(panelTimer)
  panelTimer = setTimeout(() => {
    void persistPanels()
  }, 250)
}
function onPanelScroll() {
  if (restoringPanels || !mainPanel.value) return
  panelScroll[scrollKey()] = mainPanel.value.scrollTop
  schedulePanels()
}
watch(() => snapshotPanels(), schedulePanels, { deep: true })
watch([tab, mode], async () => {
  if (restoringPanels) return
  await nextTick()
  if (mainPanel.value) mainPanel.value.scrollTop = panelScroll[scrollKey()] ?? 0
})
provide(ANALYSIS_FOLLOWUP, {
  async request(origin, text, intent) {
    const id = task.value?.id
    if (!id || busy.value) return
    try {
      const context = await client.createQuote(id, origin, text)
      if (id !== task.value?.id || disposed) return
      pendingInsertion.value = {
        key: crypto.randomUUID(),
        context,
        question: t('analysis.followup.questions.' + intent)
      }
      tab.value = 'conversation'
    } catch (cause) {
      reportError(cause)
    }
  }
})
function locateContext(context: AnalysisContext) {
  const selector = context.reference?.selector
  if (selector?.sourceId) {
    sourceId.value = selector.sourceId
    void nextTick(() => {
      sheet.value = selector.sheet ?? sheet.value
      headerRow.value = selector.headerRow ?? headerRow.value
      tab.value = 'files'
    })
  } else if (selector?.targetId) {
    connectionsOpen.value = true
    connector.value = selector.targetId.startsWith('mysql:') ? 'sql' : 'cloudPbi'
    tab.value = 'files'
  } else if (context.quote?.origin.kind === 'turn') {
    selectedTurnId.value = context.quote.origin.turnId
    mode.value = 'natural'
    tab.value = 'analysis'
  } else if (context.quote?.origin.kind === 'run') {
    runId.value = context.quote.origin.runId
    mode.value = 'manual'
    tab.value = 'analysis'
  }
}
async function guideAction(action: 'model' | 'task' | 'data' | 'file' | 'advanced') {
  if (action === 'model') {
    await config.openSettings()
    return
  }
  if (!task.value) await createTask()
  if (!task.value) return
  guideOpen.value = false
  if (action === 'task' || action === 'advanced') tab.value = 'conversation'
  else {
    tab.value = 'files'
    connector.value = action === 'file' ? 'file' : 'excel'
    connectionsOpen.value = true
  }
}
const renaming = ref(false)
const titleDraft = ref('')
const copied = ref(false)
const source = computed(() => task.value?.sources.find((item) => item.id === sourceId.value))
const run = computed(() => task.value?.runs.find((item) => item.id === runId.value))
const columns = computed(() => preview.value?.columns ?? [])
const historicalChanged = computed(
  () =>
    !!run.value &&
    task.value?.sources.find((item) => item.id === run.value?.source.id)?.sha256 !==
      run.value.source.sha256
)
const canCalculate = computed(
  () =>
    !!task.value &&
    !!source.value &&
    !!preview.value &&
    !previewLoading.value &&
    !preview.value.changed &&
    (operation.value === 'count' || !!measure.value) &&
    !busy.value &&
    methodValid.value
)
function reportError(cause: unknown) {
  const code =
    cause instanceof Error &&
    AnalysisErrorCodes.includes(cause.message as (typeof AnalysisErrorCodes)[number])
      ? cause.message
      : 'STORAGE_ERROR'
  error.value = t(`analysis.errors.${code}`)
}
async function act(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await action()
  } catch (cause) {
    reportError(cause)
  } finally {
    busy.value = false
  }
}
async function updateList() {
  const [list, entries] = await Promise.all([client.list(), client.workspaceList()])
  tasks.value = list
  workspaceEntries.value = entries
}
async function selectEntry(entry: AnalysisWorkspaceEntry) {
  if (entry.taskId) await selectTask(entry.taskId)
  else if (entry.sessionId) {
    const linked = await client.workspaceSession(entry.sessionId)
    await updateList()
    await selectTask(linked.id)
    tab.value = 'conversation'
  }
}
async function pinTask() {
  const entry = activeWorkspace.value
  if (!task.value || !entry) return
  await act(async () => {
    await client.workspacePin(task.value!.id, !entry.isPinned)
    await updateList()
  })
}
async function chooseWorkspace() {
  await act(async () => {
    if (!task.value) return
    const id = task.value.id
    const result = await device.selectDirectory()
    if (result.canceled || !result.filePaths[0]) return
    task.value = await client.workspaceProject(id, result.filePaths[0])
    await updateList()
  })
}
let disposed = false
let selectionVersion = 0
let refreshVersion = 0
async function refreshWorkspace(taskId?: string) {
  const version = ++refreshVersion
  const selected = task.value?.id
  try {
    const [entries, updated, activity] = await Promise.all([
      client.workspaceList(),
      selected && (!taskId || taskId === selected) ? client.get(selected) : Promise.resolve(null),
      selected ? client.workspaceOperations(selected) : Promise.resolve([])
    ])
    if (disposed || version !== refreshVersion) return
    workspaceEntries.value = entries
    if (task.value && task.value.id === selected) {
      if (updated) {
        const wasLatest = runId.value === task.value.runs.at(-1)?.id || !runId.value
        task.value = updated
        if (wasLatest) runId.value = updated.runs.at(-1)?.id ?? ''
      }
      operations.value = activity
    }
  } catch (cause) {
    if (!disposed && version === refreshVersion) reportError(cause)
  }
}
async function selectTask(id: string) {
  const version = ++selectionVersion
  await persistPanels()
  if (disposed || version !== selectionVersion) return
  previewToken++
  preview.value = null
  const [selected, saved] = await Promise.all([client.get(id), client.panels(id)])
  if (disposed || version !== selectionVersion) return
  restoringPanels = true
  guideOpen.value = false
  pendingInsertion.value = null
  task.value = selected
  operations.value = []
  runId.value =
    selected.runs.find((item) => item.id === saved.runId)?.id ?? selected.runs.at(-1)?.id ?? ''
  calculationOpen.value = saved.calculationOpen
  toolsOpen.value = saved.toolsOpen
  sourceId.value =
    selected.sources.find((item) => item.id === saved.sourceId)?.id ?? selected.sources[0]?.id ?? ''
  const selectedSource = selected.sources.find((item) => item.id === sourceId.value)
  const selectedSheet =
    selectedSource?.sheets.find((item) => item.name === saved.sheet) ?? selectedSource?.sheets[0]
  sheet.value = selectedSheet?.name ?? ''
  headerRow.value =
    selectedSheet?.name === saved.sheet
      ? Math.min(saved.headerRow, 100000)
      : (selectedSheet?.firstRow ?? 1)
  selectedIndex.value = Math.min(saved.valueIndex, Math.max(0, (run.value?.values.length ?? 1) - 1))
  selectedDerived.value =
    saved.selectedDerived &&
    selected.turns.some(
      (turn) =>
        turn.id === saved.selectedDerived?.turnId &&
        turn.derived.some((fact) => fact.id === saved.selectedDerived?.factId)
    )
      ? saved.selectedDerived
      : null
  mode.value = saved.mode
  selectedTurnId.value =
    selected.turns.find((item) => item.id === saved.turnId)?.id ?? selected.turns.at(-1)?.id ?? ''
  reportTarget.value =
    saved.reportTarget &&
    (saved.reportTarget.kind === 'run' ? selected.runs : selected.turns).some(
      (item) => item.id === saved.reportTarget?.id
    )
      ? saved.reportTarget
      : null
  renaming.value = false
  connectionsOpen.value = saved.connectionsOpen
  connector.value = saved.connector
  tab.value = saved.tab
  question.value = saved.manual?.question ?? ''
  unit.value = saved.manual?.unit ?? ''
  period.value = saved.manual?.period ?? ''
  measure.value = saved.manual?.measure ?? ''
  groupBy.value = saved.manual?.groupBy ?? ''
  operation.value = saved.manual?.operation ?? 'sum'
  filterColumn.value = saved.manual?.filterColumn ?? ''
  filterOperator.value = saved.manual?.filterOperator ?? 'eq'
  filterValue.value = saved.manual?.filterValue ?? ''
  study.value = saved.manual?.study
  panelScroll = { ...saved.scroll }
  panelSidepanel.value = saved.sidepanel
  panelOwner = id
  await nextTick()
  restoringPanels = false
  if (mainPanel.value) mainPanel.value.scrollTop = panelScroll[scrollKey()] ?? 0
  void loadPreview()
  try {
    localStorage.setItem('semapath.analysis.activeTask', id)
  } catch {
    /* Selection remains usable without local storage. */
  }
  void refreshWorkspace(id)
}
async function createTask() {
  await act(async () => {
    const created = await client.create(t('analysis.untitled'))
    await updateList()
    await selectTask(created.id)
    connectionsOpen.value = true
  })
}
async function loadPreview(page = 1) {
  const token = ++previewToken
  const currentTaskId = task.value?.id
  if (!currentTaskId || !source.value || !sheet.value) {
    preview.value = null
    previewLoading.value = false
    return
  }
  if (!Number.isInteger(headerRow.value) || headerRow.value < 1) {
    preview.value = null
    previewLoading.value = false
    reportError(new Error('INVALID_COLUMN'))
    return
  }
  previewLoading.value = true
  try {
    const result = await client.preview({
      taskId: currentTaskId,
      sourceId: sourceId.value,
      sheet: sheet.value,
      headerRow: headerRow.value,
      page
    })
    if (token === previewToken) {
      preview.value = result
      error.value = ''
    }
  } catch (cause) {
    if (token === previewToken) {
      preview.value = null
      reportError(cause)
    }
  } finally {
    if (token === previewToken) previewLoading.value = false
  }
}
watch(sourceId, () => {
  if (restoringPanels) return
  measure.value = ''
  groupBy.value = ''
  filterColumn.value = ''
  preview.value = null
  sheet.value = source.value?.sheets[0]?.name ?? ''
  headerRow.value = source.value?.sheets[0]?.firstRow ?? 1
  void loadPreview()
})
watch([sheet, headerRow], () => {
  if (restoringPanels) return
  measure.value = ''
  groupBy.value = ''
  filterColumn.value = ''
  preview.value = null
  void loadPreview()
})
async function pickFiles() {
  if (!task.value) return
  const id = task.value.id
  await act(async () => {
    task.value = await client.pick(id)
    sourceId.value = sourceId.value || task.value.sources[0]?.id || ''
    await updateList()
    if (task.value.sources.length) {
      connectionsOpen.value = false
      tab.value = 'files'
      await loadPreview()
    }
  })
}
async function removeSource(id: string) {
  if (!task.value) return
  const taskId = task.value.id
  await act(async () => {
    task.value = await client.remove(taskId, id)
    if (sourceId.value === id) sourceId.value = task.value.sources[0]?.id ?? ''
    await updateList()
  })
}
async function refreshSource() {
  if (!task.value || !source.value) return
  const taskId = task.value.id
  const id = sourceId.value
  await act(async () => {
    task.value = await client.refresh(taskId, id)
    if (!source.value?.sheets.some((item) => item.name === sheet.value))
      sheet.value = source.value?.sheets[0]?.name ?? ''
    headerRow.value = source.value?.sheets.find((item) => item.name === sheet.value)?.firstRow ?? 1
    await loadPreview()
    await updateList()
  })
}
async function calculate() {
  if (!task.value || !canCalculate.value) return
  const id = task.value.id
  const plan: AnalysisPlan = {
    sourceId: sourceId.value,
    sheet: sheet.value,
    headerRow: headerRow.value,
    operation: operation.value,
    measure: measure.value,
    groupBy: groupBy.value,
    question: question.value,
    unit: unit.value,
    period: period.value,
    ...(study.value ? { study: study.value } : {}),
    filters: filterColumn.value
      ? [{ column: filterColumn.value, operator: filterOperator.value, value: filterValue.value }]
      : []
  }
  await act(async () => {
    task.value = await client.run(id, plan)
    runId.value = task.value.runs.at(-1)?.id ?? ''
    calculationOpen.value = !runId.value
    selectedIndex.value = 0
    tab.value = 'analysis'
    await updateList()
  })
}
async function publish() {
  if (!task.value || !run.value) return
  const currentTask = task.value
  const currentRun = run.value
  await act(async () => {
    task.value = await client.publish(
      currentTask.id,
      currentRun.id,
      currentRun.answer.candidateHash
    )
    await updateList()
  })
}
function inspectValue(index: number) {
  selectedDerived.value = null
  selectedIndex.value = index
  tab.value = 'evidence'
}
function inspectNatural(run: string, value: string) {
  runId.value = run
  selectedIndex.value = Math.max(
    0,
    task.value?.runs
      .find((item) => item.id === run)
      ?.values.findIndex((item) => item.id === value) ?? 0
  )
  selectedDerived.value = null
  tab.value = 'evidence'
}
function inspectDerived(turnId: string, factId: string) {
  selectedDerived.value = { turnId, factId }
  tab.value = 'evidence'
}
async function updateNatural(updated: AnalysisTask) {
  const previousSources = new Set(task.value?.sources.map((source) => source.id))
  task.value = updated
  const added = updated.sources.filter((source) => !previousSources.has(source.id))
  if (added.length) {
    sourceId.value = added.at(-1)!.id
    connectionsOpen.value = false
  }
  runId.value = updated.runs.at(-1)?.id ?? ''
  selectedIndex.value = 0
  selectedDerived.value = null
  try {
    await updateList()
  } catch (cause) {
    reportError(cause)
  }
}
async function inspectSource(id: string) {
  sourceId.value = id
  tab.value = 'files'
  await nextTick()
  await loadPreview()
}
async function updateDataset(updated: AnalysisTask) {
  busy.value = false
  task.value = updated
  sourceId.value = updated.sources.at(-1)?.id ?? ''
  connectionsOpen.value = false
  tab.value = 'files'
  await nextTick()
  try {
    await updateList()
    await loadPreview()
  } catch (cause) {
    reportError(cause)
  }
}
function beginRename() {
  titleDraft.value = task.value?.title ?? ''
  renaming.value = true
}
async function saveTitle() {
  if (!task.value || !titleDraft.value.trim()) return
  const id = task.value.id
  await act(async () => {
    task.value = await client.rename(id, titleDraft.value.trim())
    renaming.value = false
    await updateList()
  })
}
function category(index: number) {
  return (
    run.value?.values[index].category ||
    t(run.value?.plan.groupBy ? 'analysis.blankGroup' : 'analysis.allRows')
  )
}
function copyAnswer() {
  if (!run.value) return
  const current = run.value
  device.copyText(
    [
      current.plan.question,
      t('analysis.answerLead', { file: current.source.name, sheet: current.plan.sheet }),
      ...current.values.map(
        (value, index) => `${category(index)}: ${value.value} ${current.plan.unit}`
      ),
      `${t('analysis.operation')}: ${t(`analysis.${current.plan.operation}`)} ${current.measureLabel}`,
      `${t('analysis.period')}: ${current.plan.period || t('analysis.periodUnset')}`,
      `${t('analysis.sourceTime')}: ${current.createdAt}`,
      `${t('analysis.evidenceId')}: ${current.evidenceId}`,
      `${t('analysis.fingerprint')}: ${current.source.sha256}`,
      current.answer.status === 'published' ? t('analysis.published') : t('analysis.draft')
    ]
      .filter(Boolean)
      .join('\n')
  )
  copied.value = true
}
watch(runId, () => {
  if (restoringPanels) return
  selectedIndex.value = 0
  copied.value = false
})
let offAnalysis: (() => void) | undefined
let offSessions: (() => void) | undefined
async function selectFromRoute() {
  if (typeof route.query.session === 'string') {
    const linked = await client.workspaceSession(route.query.session)
    await updateList()
    await selectTask(linked.id)
    return true
  }
  if (
    typeof route.query.task === 'string' &&
    tasks.value.some((item) => item.id === route.query.task)
  ) {
    await selectTask(route.query.task)
    return true
  }
  return false
}
watch(
  () => [route.query.session, route.query.task],
  () => {
    void act(async () => {
      await selectFromRoute()
    })
  }
)
onMounted(() => {
  offAnalysis = client.onChanged(({ taskId }) => {
    void refreshWorkspace(taskId)
  })
  offSessions = sessionClient.onUpdated(() => {
    void refreshWorkspace()
  })
  void act(async () => {
    await updateList()
    if (await selectFromRoute()) return
    let last: string | null = null
    try {
      last = localStorage.getItem('semapath.analysis.activeTask')
    } catch {
      /* Fall back to the latest task. */
    }
    const id = tasks.value.find((item) => item.id === last)?.id ?? tasks.value[0]?.id
    if (id) await selectTask(id)
    if (props.showGuide || !id) guideOpen.value = true
  })
})
onBeforeUnmount(() => {
  void persistPanels()
  clearTimeout(panelTimer)
  disposed = true
  selectionVersion++
  refreshVersion++
  offAnalysis?.()
  offSessions?.()
})
</script>
<template>
  <div data-testid="analysis-workbench" class="analysis-workbench">
    <aside class="analysis-task-sidebar" :aria-label="t('analysis.title')">
      <div class="analysis-brand">
        <Icon icon="lucide:route" aria-hidden="true" /><strong>{{ t('analysis.product') }}</strong>
      </div>
      <Button
        data-testid="analysis-new-task"
        class="new-task-button"
        :disabled="busy"
        @click="createTask"
        ><Icon icon="lucide:plus" aria-hidden="true" />{{ t('analysis.newTask') }}</Button
      >
      <Input
        v-model="search"
        class="workspace-search"
        data-testid="workspace-search"
        :aria-label="t('analysis.workspace.search')"
        :placeholder="t('analysis.workspace.search')"
      />
      <h2>{{ t('analysis.workspace.allTasks') }}</h2>
      <div class="task-list">
        <p v-if="!filteredEntries.length" class="analysis-muted">
          {{ t(search ? 'analysis.workspace.noResults' : 'analysis.tasksEmpty') }}
        </p>
        <button
          v-for="item in filteredEntries"
          :key="item.id"
          type="button"
          class="task-list-item"
          :class="{ selected: task?.id === item.taskId }"
          :aria-current="task?.id === item.taskId ? 'page' : undefined"
          :disabled="busy || chatLoading"
          :data-testid="'workspace-task-' + item.id"
          @click="act(() => selectEntry(item))"
        >
          <Icon
            :icon="item.isPinned ? 'lucide:pin' : 'lucide:message-square'"
            aria-hidden="true"
          /><span :title="item.title">{{ item.title }}</span
          ><small>{{ item.runCount }}</small>
        </button>
      </div>
      <p class="sidebar-description">{{ t('analysis.taskHint') }}</p>
      <button
        type="button"
        class="settings-link"
        data-testid="analysis-guide-open"
        @click="guideOpen = true"
      >
        <Icon icon="lucide:book-open" aria-hidden="true" />{{ t('analysis.guide.title') }}
      </button>
      <button type="button" class="settings-link" @click="config.openSettings()">
        <Icon icon="lucide:settings-2" aria-hidden="true" />{{ t('analysis.openSettings') }}
      </button>
    </aside>
    <main
      ref="mainPanel"
      class="analysis-main"
      :class="{ 'conversation-mode': tab === 'conversation' && !guideOpen }"
      :aria-busy="busy"
      @scroll.passive="onPanelScroll"
    >
      <div v-if="error" role="alert" class="analysis-error" data-testid="analysis-error">
        <Icon icon="lucide:circle-alert" aria-hidden="true" /><span>{{ error }}</span>
      </div>
      <TaskGettingStarted
        v-if="guideOpen"
        :task-id="task?.id"
        :has-task="!!task"
        :has-files="!!task?.sources.length"
        :has-results="!!task?.runs.length"
        @action="guideAction"
        @back="guideOpen = false"
      />
      <div v-else-if="!task" class="analysis-empty">
        <Icon icon="lucide:chart-no-axes-combined" aria-hidden="true" />
        <h1>{{ t('analysis.noTask') }}</h1>
        <p>{{ t('analysis.noTaskHint') }}</p>
        <Button :disabled="busy" @click="createTask">{{ t('analysis.newTask') }}</Button>
      </div>
      <template v-else>
        <header v-if="tab !== 'conversation'" class="task-header">
          <form v-if="renaming" class="rename-form" @submit.prevent="saveTitle">
            <Input
              v-model="titleDraft"
              :aria-label="t('analysis.rename')"
              maxlength="120"
              autofocus
            /><Button type="submit" size="sm" :disabled="busy || !titleDraft.trim()">{{
              t('analysis.save')
            }}</Button
            ><button type="button" class="analysis-button" @click="renaming = false">
              {{ t('analysis.cancel') }}
            </button>
          </form>
          <template v-else
            ><h1>{{ task.title }}</h1>
            <button
              type="button"
              class="icon-button"
              :aria-label="t('analysis.rename')"
              :title="t('analysis.rename')"
              :disabled="busy"
              @click="beginRename"
            >
              <Icon icon="lucide:pencil" aria-hidden="true" /></button
          ></template>
        </header>
        <div v-if="activeWorkspace && tab !== 'conversation'" class="workspace-metadata">
          <span v-if="activeWorkspace.projectDir" :title="activeWorkspace.projectDir"
            ><Icon icon="lucide:folder-open" aria-hidden="true" />{{
              activeWorkspace.projectDir
            }}</span
          >
          <button
            type="button"
            class="analysis-button"
            data-testid="workspace-directory"
            :disabled="busy"
            @click="chooseWorkspace"
          >
            {{ t('analysis.workspace.chooseDirectory') }}
          </button>
          <button
            type="button"
            class="analysis-button"
            data-testid="workspace-pin"
            :disabled="busy"
            :aria-pressed="activeWorkspace.isPinned"
            @click="pinTask"
          >
            {{
              t(activeWorkspace.isPinned ? 'analysis.workspace.unpin' : 'analysis.workspace.pin')
            }}
          </button>
          <span v-if="activeWorkspace.sessionMissing" role="status">{{
            t('analysis.errors.WORKSPACE_SESSION_MISSING')
          }}</span>
        </div>
        <section class="task-data-strip">
          <div>
            <div class="data-strip-title">
              <Icon icon="lucide:database" aria-hidden="true" /><strong>{{
                task.sources.length
                  ? t('analysis.sourcesCount', { count: task.sources.length })
                  : t('analysis.taskData')
              }}</strong>
            </div>
            <p class="analysis-muted">
              {{ task.sources.length ? t('analysis.taskHint') : t('analysis.connectionHint') }}
            </p>
          </div>
          <div class="data-actions">
            <button
              type="button"
              class="analysis-button"
              data-testid="analysis-manage-data"
              :disabled="busy"
              :aria-expanded="connectionsOpen"
              @click="connectionsOpen = !connectionsOpen"
            >
              {{ task.sources.length ? t('analysis.manage') : t('analysis.connect') }}</button
            ><button
              v-if="task.sources.length"
              type="button"
              class="analysis-button"
              @click="tab = 'files'"
            >
              {{ t('analysis.browse') }}
            </button>
          </div>
        </section>
        <section
          v-if="connectionsOpen"
          class="connection-panel"
          :aria-label="t('analysis.connect')"
        >
          <nav class="connection-types" :aria-label="t('analysis.source')">
            <button
              v-for="type in ['localPbi', 'cloudPbi', 'file', 'excel', 'sql']"
              :key="type"
              type="button"
              :aria-pressed="connector === type"
              :disabled="busy"
              :data-testid="'analysis-connector-' + type"
              @click="connector = type"
            >
              {{ t(`analysis.${type}`) }}
            </button>
          </nav>
          <template v-if="connector === 'excel' || connector === 'file'"
            ><Button
              data-testid="analysis-add-files"
              variant="outline"
              :disabled="busy"
              @click="pickFiles"
              ><Icon icon="lucide:file-spreadsheet" aria-hidden="true" />{{
                t('analysis.addFiles')
              }}</Button
            >
            <p class="analysis-muted">{{ t('analysis.sourceNotice') }}</p></template
          >
          <SqlConnectionPanel
            v-else-if="connector === 'sql'"
            :key="task.id"
            :task="task"
            :global-busy="busy"
            @busy="busy = $event"
            @updated="updateDataset"
          />
          <PowerBiConnectionPanel
            v-else
            :key="task.id + connector"
            :task="task"
            :mode="connector === 'localPbi' ? 'local' : 'cloud'"
            :global-busy="busy"
            @busy="busy = $event"
            @updated="updateDataset"
          />
          <JoinDatasetForm
            v-if="(connector === 'file' || connector === 'excel') && task.sources.length"
            :key="'join-' + task.id"
            :task="task"
            :global-busy="busy"
            @busy="busy = $event"
            @updated="updateDataset"
          />
          <ul v-if="task.sources.length" class="connected-files">
            <li v-for="item in task.sources" :key="item.id">
              <span :title="item.path">{{ item.name }}</span
              ><button
                type="button"
                class="analysis-button"
                :disabled="busy"
                @click="removeSource(item.id)"
              >
                {{ t('analysis.remove') }}
              </button>
            </li>
          </ul>
        </section>
        <nav class="workbench-tabs" :aria-label="t('analysis.analysis')">
          <button
            v-for="type in ['conversation', 'analysis', 'evidence', 'files', 'reports'] as const"
            :key="type"
            type="button"
            :data-testid="`analysis-tab-${type}`"
            :aria-pressed="tab === type"
            @click="tab = type"
          >
            <Icon
              :icon="
                type === 'conversation'
                  ? 'lucide:messages-square'
                  : type === 'analysis'
                    ? 'lucide:chart-no-axes-combined'
                    : type === 'evidence'
                      ? 'lucide:list-checks'
                      : type === 'reports'
                        ? 'lucide:file-down'
                        : 'lucide:folder-open'
              "
              aria-hidden="true"
            />{{
              t(
                type === 'conversation'
                  ? 'analysis.workspace.conversation'
                  : type === 'reports'
                    ? 'analysis.reports.title'
                    : `analysis.${type}`
              )
            }}
          </button>
        </nav>
        <p
          v-if="task.branch"
          class="px-5 py-2 text-xs text-foreground/75"
          data-testid="analysis-branch-notice"
        >
          {{ t('analysis.workspace.branchNotice') }}
          <span v-if="task.branch.requiresReconnection">{{
            t('analysis.workspace.branchReconnect')
          }}</span>
        </p>
        <TaskConversation
          v-if="tab === 'conversation'"
          :key="task.id"
          :task-id="task.id"
          :insertion="pendingInsertion"
          :panel-state="panelSidepanel"
          @panel-state="panelSidepanel = $event"
          @analysis-inserted="pendingInsertion = null"
          @analysis-locate="locateContext"
          @session-forked="
            act(async () => {
              const linked = await client.workspaceSession($event)
              await selectTask(linked.id)
              tab = 'conversation'
            })
          "
          @ready="refreshWorkspace(task.id)"
          @loading="chatLoading = $event"
        />
        <details
          v-if="operations.length && tab === 'analysis'"
          class="workspace-tool-history"
          data-testid="workspace-tool-history"
          :open="toolsOpen"
          @toggle="toolsOpen = ($event.target as HTMLDetailsElement).open"
        >
          <summary>{{ t('analysis.workspace.toolHistory') }}</summary>
          <ol>
            <li v-for="entry in operations" :key="entry.id">
              <span>{{ t('analysis.workspace.tools.' + entry.tool) }}</span>
              <span
                :class="{
                  'analysis-error-text': entry.state === 'failed' || entry.state === 'interrupted'
                }"
                >{{ t('analysis.workspace.states.' + entry.state) }}</span
              >
              <time :datetime="entry.createdAt">{{
                new Date(entry.createdAt).toLocaleString()
              }}</time>
              <span v-if="entry.error">{{ t('analysis.errors.' + entry.error) }}</span>
            </li>
          </ol>
        </details>
        <div v-if="tab === 'analysis'" class="analysis-modes" :aria-label="t('analysis.analysis')">
          <button
            type="button"
            data-testid="analysis-mode-natural"
            :aria-pressed="mode === 'natural'"
            @click="mode = 'natural'"
          >
            {{ t('analysis.natural.naturalTitle') }}
          </button>
          <button
            type="button"
            data-testid="analysis-mode-manual"
            :aria-pressed="mode === 'manual'"
            @click="mode = 'manual'"
          >
            {{ t('analysis.natural.manualTitle') }}
          </button>
        </div>
        <NaturalChat
          v-model:selected-turn-id="selectedTurnId"
          v-show="tab === 'analysis' && mode === 'natural'"
          :key="task.id"
          :task="task"
          :global-busy="busy"
          @busy="busy = $event"
          @updated="updateNatural"
          @inspect="inspectNatural"
          @derived="inspectDerived"
          @report="goToReports"
          @source="inspectSource"
        />
        <AnalysisReports
          v-if="tab === 'reports'"
          :key="task.id"
          :task="task"
          :initial-target="reportTarget"
        />
        <div
          v-show="
            tab !== 'conversation' && tab !== 'reports' && (tab !== 'analysis' || mode === 'manual')
          "
          class="workbench-content"
        >
          <section
            v-if="!task.sources.length && !run"
            class="analysis-empty"
            data-testid="analysis-empty"
          >
            <Icon
              :icon="pbiConnector ? 'lucide:database' : 'lucide:file-spreadsheet'"
              aria-hidden="true"
            />
            <h2>{{ t(pbiConnector ? 'analysis.pbi.emptySnapshot' : 'analysis.noSource') }}</h2>
            <p>
              {{ t(pbiConnector ? 'analysis.pbi.emptySnapshotHint' : 'analysis.noSourceHint') }}
            </p>
            <Button v-if="!pbiConnector" :disabled="busy" @click="pickFiles">{{
              t('analysis.addFiles')
            }}</Button>
          </section>
          <template v-else>
            <div v-if="task.sources.length" class="source-controls">
              <label
                >{{ t('analysis.source')
                }}<select v-model="sourceId" data-testid="analysis-source" :disabled="busy">
                  <option v-for="item in task.sources" :key="item.id" :value="item.id">
                    {{ item.name }}
                  </option>
                </select></label
              >
              <label
                >{{ t('analysis.sheet')
                }}<select v-model="sheet" data-testid="analysis-sheet" :disabled="busy">
                  <option v-for="item in source?.sheets" :key="item.name" :value="item.name">
                    {{ item.name }}
                  </option>
                </select></label
              >
              <label class="header-row-field"
                >{{ t('analysis.headerRow')
                }}<input
                  v-model.number="headerRow"
                  data-testid="analysis-header-row"
                  type="number"
                  min="1"
                  :max="source?.sheets.find((item) => item.name === sheet)?.lastRow ?? 100000"
                  :disabled="busy"
              /></label>
              <button
                type="button"
                class="analysis-button refresh-button"
                v-if="!source?.origin"
                :disabled="busy || previewLoading"
                @click="refreshSource"
              >
                <Icon icon="lucide:refresh-cw" aria-hidden="true" />{{ t('analysis.refresh') }}
              </button>
            </div>
            <p v-if="preview?.changed" role="status" class="analysis-notice">
              {{ t('analysis.changed') }}
            </p>
            <p v-if="previewLoading" role="status" class="analysis-muted">
              {{ t('analysis.working') }}
            </p>
            <template v-if="tab === 'files'"
              ><DataOrigin v-if="source?.origin" :origin="source.origin" /><WorkbookPreview
                v-if="preview"
                :preview="preview"
                :loading="previewLoading"
                @page="loadPreview"
              />
              <p v-else-if="!previewLoading" class="analysis-muted">
                {{ t('analysis.noSourceHint') }}
              </p>
              <p v-if="source" class="analysis-muted source-path">{{ source.path }}</p>
              <p class="analysis-muted">{{ t('analysis.limitations') }}</p></template
            >
            <template v-else>
              <div v-if="task.runs.length" class="history-control">
                <label
                  >{{ t('analysis.history')
                  }}<select
                    v-model="runId"
                    data-testid="analysis-history"
                    @change="selectedDerived = null"
                  >
                    <option
                      v-for="item in [...task.runs].reverse()"
                      :key="item.id"
                      :value="item.id"
                    >
                      {{ new Date(item.createdAt).toLocaleString() }} ·
                      {{
                        item.plan.question ||
                        `${t(`analysis.${item.plan.operation}`)} ${item.measureLabel}`
                      }}
                      ·
                      {{
                        t(
                          item.answer.status === 'published'
                            ? 'analysis.published'
                            : 'analysis.draft'
                        )
                      }}
                    </option>
                  </select></label
                >
              </div>
              <p v-if="historicalChanged" class="analysis-notice">
                {{ t('analysis.historicalChanged') }}
              </p>
              <template v-if="tab === 'evidence'"
                ><NaturalDerivedEvidence
                  v-if="derivedFact"
                  :fact="derivedFact"
                  :task="task"
                  @inspect="inspectNatural"
                />
                <AnalysisEvidence
                  v-else-if="run"
                  :run="run"
                  :selected-index="selectedIndex"
                  @select="selectedIndex = $event"
                />
                <p v-else class="analysis-muted empty-evidence">
                  {{ t('analysis.emptyEvidence') }}
                </p></template
              >
              <template v-else>
                <details
                  v-if="source"
                  class="calculation-scope"
                  :open="calculationOpen"
                  @toggle="calculationOpen = ($event.target as HTMLDetailsElement).open"
                >
                  <summary data-testid="analysis-edit-calculation">
                    {{ t('analysis.scope') }}
                  </summary>
                  <form class="calculation-form" @submit.prevent="calculate">
                    <label class="question-field"
                      >{{ t('analysis.question')
                      }}<Input
                        v-model="question"
                        data-testid="analysis-question"
                        :placeholder="t('analysis.questionPlaceholder')"
                        maxlength="2000"
                        :disabled="busy"
                    /></label>
                    <div class="calculation-fields">
                      <label
                        >{{ t('analysis.operation')
                        }}<select
                          v-model="operation"
                          data-testid="analysis-operation"
                          :disabled="busy"
                        >
                          <option
                            v-for="type in ['sum', 'average', 'count', 'min', 'max'] as const"
                            :key="type"
                            :value="type"
                          >
                            {{ t(`analysis.${type}`) }}
                          </option>
                        </select></label
                      >
                      <label v-if="operation !== 'count'"
                        >{{ t('analysis.measure')
                        }}<select
                          v-model="measure"
                          data-testid="analysis-measure"
                          :disabled="busy || !columns.length"
                        >
                          <option value="" disabled>{{ t('analysis.selectMeasure') }}</option>
                          <option v-for="column in columns" :key="column.key" :value="column.key">
                            {{ column.key }} · {{ column.label }}
                          </option>
                        </select></label
                      >
                      <label
                        >{{ t('analysis.groupBy')
                        }}<select
                          v-model="groupBy"
                          data-testid="analysis-group"
                          :disabled="busy || !columns.length"
                        >
                          <option value="">{{ t('analysis.ungrouped') }}</option>
                          <option v-for="column in columns" :key="column.key" :value="column.key">
                            {{ column.key }} · {{ column.label }}
                          </option>
                        </select></label
                      >
                      <label
                        >{{ t('analysis.unit')
                        }}<Input
                          v-model="unit"
                          data-testid="analysis-unit"
                          :placeholder="t('analysis.unitPlaceholder')"
                          maxlength="30"
                          :disabled="busy" /></label
                      ><label
                        >{{ t('analysis.period')
                        }}<Input
                          v-model="period"
                          data-testid="analysis-period"
                          :placeholder="t('analysis.periodPlaceholder')"
                          maxlength="100"
                          :disabled="busy"
                      /></label>
                    </div>
                    <MethodForm
                      :key="`${task.id}:${sourceId}:${sheet}`"
                      v-model="study"
                      :columns="columns"
                      :busy="busy"
                      :measure="measure"
                      :group-by="groupBy"
                      :operation="operation"
                      @valid="methodValid = $event"
                    />
                    <details class="filter-details">
                      <summary>
                        {{ t('analysis.filter') }} ·
                        {{
                          filterColumn
                            ? `${filterColumn} ${t(`analysis.${filterOperator}`)} ${filterValue}`
                            : t('analysis.noFilter')
                        }}
                      </summary>
                      <div class="filter-fields">
                        <select
                          v-model="filterColumn"
                          :aria-label="t('analysis.filter')"
                          data-testid="analysis-filter-column"
                          :disabled="busy"
                        >
                          <option value="">{{ t('analysis.noFilter') }}</option>
                          <option v-for="column in columns" :key="column.key" :value="column.key">
                            {{ column.key }} · {{ column.label }}
                          </option></select
                        ><select
                          v-model="filterOperator"
                          :aria-label="t('analysis.operation')"
                          :disabled="busy || !filterColumn"
                        >
                          <option
                            v-for="type in ['eq', 'contains', 'gt', 'gte', 'lt', 'lte']"
                            :key="type"
                            :value="type"
                          >
                            {{ t(`analysis.${type}`) }}
                          </option></select
                        ><Input
                          v-model="filterValue"
                          data-testid="analysis-filter-value"
                          :aria-label="t('analysis.filterValue')"
                          :placeholder="t('analysis.filterValue')"
                          :disabled="busy || !filterColumn"
                          maxlength="1000"
                        />
                      </div>
                    </details>
                    <div class="calculation-footer">
                      <p class="analysis-muted">{{ t('analysis.calculationNotice') }}</p>
                      <Button
                        type="submit"
                        data-testid="analysis-calculate"
                        :disabled="!canCalculate"
                        ><Icon
                          :icon="busy ? 'lucide:loader-circle' : 'lucide:play'"
                          aria-hidden="true"
                          :class="{ spinning: busy }"
                        />{{ busy ? t('analysis.calculating') : t('analysis.calculate') }}</Button
                      >
                    </div>
                  </form>
                </details>
                <template v-if="run">
                  <article
                    class="formal-answer"
                    data-testid="analysis-answer"
                    :data-analysis-quote-origin="
                      JSON.stringify({
                        kind: 'run',
                        runId: run.id,
                        candidateHash: run.answer.candidateHash
                      } satisfies QuoteOrigin)
                    "
                  >
                    <div class="analysis-section-heading">
                      <h2>
                        {{
                          t(
                            run.answer.status === 'published'
                              ? 'analysis.published'
                              : 'analysis.draft'
                          )
                        }}
                      </h2>
                      <button type="button" class="analysis-button" @click="copyAnswer">
                        {{ t(copied ? 'analysis.copied' : 'analysis.copy') }}
                      </button>
                    </div>
                    <h3 v-if="run.plan.question">{{ run.plan.question }}</h3>
                    <p>
                      {{
                        t('analysis.answerLead', { file: run.source.name, sheet: run.plan.sheet })
                      }}
                    </p>
                    <MethodAnswer
                      v-if="run.study"
                      :run="run"
                      @inspect="inspectNatural(run.id, $event)"
                    />
                    <ul v-else class="answer-facts">
                      <li v-for="(value, index) in run.values" :key="value.id">
                        <span>{{
                          t('analysis.answerFact', {
                            category: category(index),
                            operation: t(`analysis.${run.plan.operation}`),
                            measure: run.plan.operation === 'count' ? '' : run.measureLabel
                          })
                        }}</span
                        ><button
                          type="button"
                          class="evidence-link"
                          :data-testid="`analysis-answer-value-${index}`"
                          @click="inspectValue(index)"
                        >
                          {{ value.value }}<span v-if="run.plan.unit"> {{ run.plan.unit }}</span
                          ><Icon icon="lucide:arrow-up-right" aria-hidden="true" />
                        </button>
                      </li>
                    </ul>
                    <p class="analysis-muted">
                      {{
                        t('analysis.scopeHint', {
                          scanned: run.scannedRows,
                          matched: run.matchedRows,
                          empty: run.emptyRows
                        })
                      }}
                    </p>
                    <p class="analysis-muted">
                      {{ run.plan.period || t('analysis.periodUnset') }} ·
                      {{ t('analysis.sourceTime') }} {{ new Date(run.createdAt).toLocaleString() }}
                    </p>
                    <p v-for="warning in run.warnings" :key="warning" class="analysis-notice">
                      {{ t(`analysis.warnings.${warning}`) }}
                    </p>
                    <div v-if="run.answer.status === 'draft'" class="publish-row">
                      <p class="analysis-muted">{{ t('analysis.draftNotice') }}</p>
                      <Button
                        data-testid="analysis-publish"
                        :disabled="busy || historicalChanged"
                        @click="publish"
                        ><Icon icon="lucide:check" aria-hidden="true" />{{
                          t('analysis.publish')
                        }}</Button
                      >
                    </div>
                    <div v-else class="published-actions">
                      <p class="published-status" data-testid="analysis-published">
                        <Icon icon="lucide:circle-check" aria-hidden="true" />{{
                          t('analysis.publishedAt', {
                            time: new Date(run.answer.publishedAt!).toLocaleString()
                          })
                        }}
                      </p>
                      <Button
                        variant="outline"
                        data-testid="analysis-export-report"
                        @click="goToReports('run', run.id)"
                        ><Icon icon="lucide:file-down" aria-hidden="true" />{{
                          t('analysis.reports.export')
                        }}</Button
                      >
                    </div>
                  </article>
                  <AnalysisChart
                    v-if="!run.study"
                    :key="run.id"
                    :run="run"
                    @select="inspectValue"
                  />
                </template>
                <div v-else class="analysis-empty small-empty">
                  <Icon icon="lucide:chart-no-axes-combined" aria-hidden="true" />
                  <h2>{{ t('analysis.noResult') }}</h2>
                  <p>{{ t('analysis.noResultHint') }}</p>
                </div>
              </template>
            </template>
          </template>
        </div>
      </template>
    </main>
    <AnalysisQuoteToolbar v-if="tab !== 'conversation' && !guideOpen" :root="mainPanel" />
  </div>
</template>
<style>
.published-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-top: 20px;
}
.analysis-modes {
  display: flex;
  gap: 4px;
  margin: 0 28px;
  padding-top: 16px;
  flex-shrink: 0;
}
.analysis-modes button {
  min-height: 36px;
  padding: 8px 14px;
  color: var(--analysis-muted);
  border-radius: 6px;
  font-size: 12px;
}
.analysis-modes button[aria-pressed='true'] {
  color: var(--foreground);
  background: var(--secondary);
}
.analysis-workbench {
  --analysis-blue: #2364ca;
  --analysis-muted: color-mix(in srgb, var(--foreground) 68%, var(--background));
  display: flex;
  width: 100%;
  height: 100%;
  min-height: 0;
  color: var(--foreground);
  background: var(--background);
  font-size: 13px;
}
.dark .analysis-workbench {
  --analysis-blue: #85b4ff;
}
.analysis-workbench ::selection {
  background: color-mix(in srgb, var(--analysis-blue) 22%, transparent);
}
.analysis-workbench * {
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}
.analysis-workbench button,
.analysis-workbench input,
.analysis-workbench select {
  caret-color: var(--analysis-blue);
}
.analysis-workbench :focus-visible {
  outline: 2px solid var(--analysis-blue);
  outline-offset: 3px;
}
.analysis-workbench button {
  cursor: pointer;
}
.analysis-workbench button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.analysis-task-sidebar {
  width: 218px;
  flex-shrink: 0;
  padding: 20px 12px 12px;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: color-mix(in srgb, var(--muted) 40%, var(--background));
}
.analysis-brand {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 3px 8px 8px;
  font-size: 19px;
  letter-spacing: -0.02em;
}
.analysis-brand svg {
  color: var(--analysis-blue);
  width: 22px;
  height: 22px;
}
.analysis-task-sidebar h2 {
  margin: 13px 8px 0;
  font-size: 12px;
  color: var(--analysis-muted);
  font-weight: 500;
}
.workspace-search::placeholder {
  color: var(--analysis-muted);
  opacity: 1;
}
.new-task-button {
  justify-content: flex-start;
  gap: 9px;
}
.task-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.task-list-item {
  display: flex;
  width: 100%;
  gap: 9px;
  align-items: center;
  border-radius: 7px;
  padding: 10px 9px;
  text-align: left;
  margin-bottom: 3px;
}
.task-list-item svg {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  color: var(--analysis-muted);
}
.task-list-item span {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-list-item small {
  color: var(--analysis-muted);
  font-variant-numeric: tabular-nums;
}
.task-list-item:hover,
.task-list-item.selected {
  background: var(--accent);
}
.task-list-item.selected {
  color: var(--analysis-blue);
}
.sidebar-description {
  color: var(--analysis-muted);
  line-height: 1.7;
  font-size: 12px;
  margin: 0 8px;
}
.settings-link {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 10px 8px;
  border-top: 1px solid var(--border);
  text-align: left;
  font-size: 12px;
}
.settings-link svg {
  width: 15px;
  height: 15px;
}
.analysis-main {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}
.analysis-main.conversation-mode {
  overflow: hidden;
}
.conversation-mode .task-data-strip,
.conversation-mode .workbench-tabs {
  flex-shrink: 0;
}
.conversation-mode .connection-panel {
  max-height: 36vh;
  overflow-y: auto;
  flex-shrink: 0;
}
.workspace-metadata {
  display: flex;
  gap: 14px;
  align-items: center;
  padding: 0 28px 12px;
  min-width: 0;
}
.workspace-metadata > span {
  display: flex;
  gap: 7px;
  align-items: center;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--analysis-muted);
}
.workspace-metadata svg {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}
.workspace-tool-history {
  margin: 16px 28px 0;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.workspace-tool-history summary {
  cursor: pointer;
  font-weight: 500;
}
.workspace-tool-history ol {
  margin-top: 12px;
  max-height: 200px;
  overflow: auto;
}
.workspace-tool-history li {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
  margin: 8px 0;
}
.workspace-tool-history time {
  color: var(--analysis-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.analysis-error-text {
  color: color-mix(in srgb, var(--destructive) 72%, var(--foreground));
}
.dark .analysis-error-text {
  color: color-mix(in srgb, var(--destructive) 50%, var(--foreground));
}
.task-header {
  min-height: 66px;
  display: flex;
  gap: 9px;
  align-items: center;
  padding: 14px 28px;
}
.task-header h1 {
  font-size: 16px;
  line-height: 1.5;
  font-weight: 600;
  margin: 0;
  overflow-wrap: anywhere;
}
.icon-button {
  padding: 7px;
  border-radius: 5px;
  color: var(--analysis-muted);
}
.icon-button:hover {
  background: var(--accent);
}
.rename-form {
  display: flex;
  gap: 8px;
  width: 100%;
  align-items: center;
}
.rename-form input {
  max-width: 500px;
}
.task-data-strip {
  margin: 0 28px 12px;
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: color-mix(in srgb, var(--muted) 25%, var(--background));
}
.data-strip-title,
.data-actions {
  display: flex;
  align-items: center;
  gap: 9px;
}
.data-strip-title svg {
  width: 16px;
  height: 16px;
  color: var(--analysis-blue);
}
.task-data-strip p {
  margin: 5px 0 0;
  font-size: 12px;
}
.data-actions {
  flex-shrink: 0;
}
.analysis-muted {
  color: var(--analysis-muted);
  line-height: 1.65;
  font-size: 12px;
}
.analysis-button {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: var(--background);
  font-size: 12px;
  white-space: nowrap;
}
.analysis-button:hover {
  background: var(--accent);
}
.analysis-button svg {
  width: 14px;
  height: 14px;
}
.connection-panel {
  margin: 0 28px 15px;
  padding: 0 16px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.connection-types {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 15px;
}
.connection-types button {
  padding: 11px 0;
  color: var(--analysis-muted);
  font-size: 12px;
  border-bottom: 2px solid transparent;
}
.connection-types button[aria-pressed='true'] {
  color: var(--analysis-blue);
  border-color: var(--analysis-blue);
}
.connected-files {
  margin-top: 12px;
}
.connected-files li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 0;
}
.connected-files span {
  overflow-wrap: anywhere;
}
.workbench-tabs {
  display: flex;
  gap: 24px;
  padding: 0 28px;
  border-bottom: 1px solid var(--border);
}
.workbench-tabs button {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 12px 0;
  color: var(--analysis-muted);
  border-bottom: 2px solid transparent;
  white-space: nowrap;
}
.workbench-tabs svg {
  width: 15px;
  height: 15px;
}
.workbench-tabs button[aria-pressed='true'] {
  color: var(--foreground);
  border-bottom-color: var(--analysis-blue);
  font-weight: 600;
}
.workbench-content {
  padding: 20px 28px 40px;
  max-width: 1340px;
  width: 100%;
  margin-inline: auto;
}
.analysis-workbench label {
  display: flex;
  flex-direction: column;
  gap: 7px;
  font-size: 12px;
  color: var(--analysis-muted);
  min-width: 0;
}
.analysis-workbench select,
.analysis-workbench input[type='number'] {
  height: 34px;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--foreground);
  background: var(--background);
  padding: 0 10px;
  width: 100%;
  min-width: 0;
  font-size: 12px;
}
.source-controls {
  display: grid;
  grid-template-columns: minmax(150px, 1.2fr) minmax(120px, 1fr) 96px auto;
  gap: 12px;
  align-items: end;
  margin-bottom: 20px;
}
.refresh-button {
  height: 34px;
}
.history-control {
  margin: 20px 0;
  max-width: 600px;
}
.history-control select {
  text-overflow: ellipsis;
}
.calculation-scope {
  margin: 18px 0 24px;
}
.calculation-scope > summary {
  cursor: pointer;
  font-weight: 500;
  color: var(--analysis-muted);
}
.calculation-form {
  margin: 20px 0 26px;
  padding-bottom: 22px;
  border-bottom: 1px solid var(--border);
}
.question-field {
  margin-bottom: 15px;
}
.calculation-fields {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}
.calculation-fields input {
  height: 34px;
  font-size: 12px;
}
.filter-details {
  margin-top: 17px;
}
.filter-details summary {
  cursor: pointer;
  color: var(--analysis-muted);
  font-size: 12px;
}
.filter-fields {
  display: grid;
  grid-template-columns: 1fr 1fr 2fr;
  gap: 10px;
  margin-top: 12px;
}
.calculation-footer,
.publish-row {
  display: flex;
  gap: 20px;
  justify-content: space-between;
  align-items: center;
  margin-top: 16px;
}
.calculation-footer p,
.publish-row p {
  margin: 0;
  max-width: 65ch;
}
.calculation-footer button,
.publish-row button {
  flex-shrink: 0;
}
.analysis-section-heading {
  display: flex;
  gap: 15px;
  align-items: center;
  justify-content: space-between;
  margin: 0 0 12px;
}
.analysis-section-heading h2 {
  font-size: 16px;
  margin: 0;
  font-weight: 600;
}
.analysis-section-heading h3 {
  font-size: 14px;
  margin: 0;
  font-weight: 600;
}
.analysis-section-heading select {
  max-width: 240px;
}
.formal-answer {
  padding-bottom: 24px;
}
.formal-answer > h3 {
  font-weight: 600;
  font-size: 15px;
  margin-block: 20px 12px;
}
.formal-answer p {
  line-height: 1.8;
}
.answer-facts {
  margin: 20px 0;
  padding: 0;
  list-style: none;
}
.answer-facts li {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 20px;
  border-bottom: 1px solid var(--border);
  padding: 12px 0;
}
.evidence-link {
  color: var(--analysis-blue);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  border-bottom: 1px dotted currentColor;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  overflow-wrap: anywhere;
  text-align: left;
}
.evidence-link:hover {
  border-bottom-style: solid;
}
.evidence-link svg {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
}
.published-status {
  display: flex;
  gap: 7px;
  align-items: center;
  color: var(--analysis-blue);
}
.published-status svg {
  width: 16px;
  height: 16px;
}
.result-chart {
  border-top: 1px solid var(--border);
  padding-top: 22px;
}
.segmented {
  display: flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 2px;
}
.segmented button {
  padding: 4px 9px;
  font-size: 12px;
  border-radius: 4px;
  color: var(--analysis-muted);
}
.segmented button[aria-pressed='true'] {
  color: var(--foreground);
  background: var(--accent);
}
.analysis-table-wrap {
  overflow: auto;
  max-height: 480px;
  border: 1px solid var(--border);
  border-radius: 7px;
  margin-top: 12px;
}
.analysis-table-wrap table {
  border-collapse: separate;
  border-spacing: 0;
  width: 100%;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.analysis-table-wrap th,
.analysis-table-wrap td {
  padding: 10px 12px;
  text-align: left;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
.analysis-table-wrap thead th {
  position: sticky;
  top: 0;
  background: var(--muted);
  font-weight: 500;
  z-index: 1;
}
.analysis-table-wrap tbody th {
  color: var(--analysis-muted);
  font-weight: 400;
  background: color-mix(in srgb, var(--muted) 50%, var(--background));
}
.analysis-table-wrap tr:last-child td,
.analysis-table-wrap tr:last-child th {
  border-bottom: 0;
}
.pagination {
  display: flex;
  gap: 14px;
  justify-content: flex-end;
  align-items: center;
  margin-top: 12px;
  color: var(--analysis-muted);
  font-size: 12px;
}
.analysis-notice {
  padding: 11px 12px;
  border: 1px solid color-mix(in srgb, var(--analysis-blue) 35%, var(--border));
  border-radius: 7px;
  color: var(--foreground);
  background: color-mix(in srgb, var(--analysis-blue) 5%, var(--background));
  line-height: 1.7;
  font-size: 12px;
  margin: 12px 0;
}
.analysis-error {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 20px;
  color: var(--destructive);
  border-bottom: 1px solid var(--border);
  line-height: 1.65;
}
.analysis-error svg {
  margin-top: 2px;
  flex-shrink: 0;
  width: 16px;
  height: 16px;
}
.analysis-empty {
  min-height: 340px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 40px 24px;
  text-align: center;
  flex: 1;
}
.analysis-empty > svg {
  width: 32px;
  height: 32px;
  color: var(--analysis-muted);
}
.analysis-empty h1,
.analysis-empty h2 {
  font-size: 20px;
  font-weight: 600;
  margin: 0;
}
.analysis-empty p {
  color: var(--analysis-muted);
  max-width: 48ch;
  line-height: 1.8;
  margin: 0 0 8px;
}
.small-empty {
  min-height: 220px;
}
.small-empty h2 {
  font-size: 17px;
}
.empty-evidence {
  padding-block: 30px;
}
.source-path {
  overflow-wrap: anywhere;
  margin-top: 15px;
}
@keyframes analysis-spin {
  to {
    transform: rotate(360deg);
  }
}
.spinning {
  animation: analysis-spin 1s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .spinning {
    animation: none;
  }
}
@media (max-width: 1100px) {
  .analysis-task-sidebar {
    width: 185px;
  }
  .task-header {
    padding-inline: 20px;
  }
  .task-data-strip,
  .connection-panel {
    margin-inline: 20px;
  }
  .workbench-tabs {
    padding-inline: 20px;
  }
  .workbench-content {
    padding-inline: 20px;
  }
  .source-controls {
    grid-template-columns: minmax(120px, 1fr) minmax(100px, 1fr) 80px;
  }
  .refresh-button {
    grid-column: 1 / -1;
    justify-self: start;
  }
  .calculation-footer,
  .publish-row {
    align-items: flex-start;
    flex-direction: column;
    gap: 12px;
  }
}
@media (max-width: 760px) {
  .analysis-task-sidebar {
    width: 160px;
    padding-inline: 8px;
  }
  .analysis-brand {
    font-size: 16px;
  }
  .source-controls,
  .calculation-fields {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .task-data-strip {
    flex-direction: column;
    gap: 12px;
  }
  .workbench-tabs {
    gap: 14px;
  }
  .task-header,
  .workbench-content {
    padding-inline: 16px;
  }
  .filter-fields {
    grid-template-columns: 1fr;
  }
  .answer-facts li {
    align-items: flex-start;
    flex-direction: column;
    gap: 8px;
  }
}
</style>
