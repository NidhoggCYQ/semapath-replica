import type { DeepchatBridge } from '@shared/contracts/bridge'
import { AnalysisPlanSchema, NaturalAskSchema, type AnalysisPlan } from '@shared/analysis'
import { JoinInputSchema, SqlConnectionInputSchema } from '@shared/analysisData'
import type { JoinInput, SqlConnectionInput, SqlQueryInput } from '@shared/analysisData'
import { getDeepchatBridge } from './core'
import type { DeepchatRouteInput, DeepchatRouteOutput } from '@shared/contracts/routes'
import type { ANALYSIS_ROUTE_CATALOG } from '@shared/contracts/routes/analysis.routes'
import type {
  DataReference,
  QuoteOrigin,
  TaskPanelState,
  GuideState
} from '@shared/analysisInteraction'
import {
  DataReferenceSchema,
  QuoteOriginSchema,
  TaskPanelStatePatchSchema,
  GuideStatePatchSchema
} from '@shared/analysisInteraction'
import {
  PbiApplicationSchema,
  PbiTargetSchema,
  PbiQuerySchema,
  type PbiApplication,
  type PbiTarget,
  type PbiQuery
} from '@shared/analysisPowerBi'

type Name = keyof typeof ANALYSIS_ROUTE_CATALOG
type ResultData<T extends Name> = Extract<DeepchatRouteOutput<T>, { ok: true }>['data']
export function createAnalysisClient(bridge: DeepchatBridge = getDeepchatBridge()) {
  async function invoke<T extends Name>(
    name: T,
    input: DeepchatRouteInput<T>
  ): Promise<ResultData<T>> {
    const result: DeepchatRouteOutput<T> = await bridge.invoke(name, input)
    if (!result.ok) throw new Error(result.error)
    return result.data as ResultData<T>
  }
  return {
    referenceCatalog: (taskId: string, query = '') =>
      invoke('analysis.references.catalog', { taskId, query }),
    createReference: (taskId: string, reference: DataReference) =>
      invoke('analysis.references.create', {
        taskId,
        reference: DataReferenceSchema.parse(reference)
      }),
    createQuote: (taskId: string, origin: QuoteOrigin, text: string) =>
      invoke('analysis.quotes.create', { taskId, origin: QuoteOriginSchema.parse(origin), text }),
    context: (taskId: string, contextId: string) =>
      invoke('analysis.context.get', { taskId, contextId }),
    panels: (taskId: string) => invoke('analysis.panels.get', { taskId }),
    savePanels: (taskId: string, patch: Partial<TaskPanelState>) =>
      invoke('analysis.panels.save', {
        taskId,
        patch: TaskPanelStatePatchSchema.parse(patch)
      }),
    guide: () => invoke('analysis.guide.get', {}),
    saveGuide: (patch: Partial<GuideState>) =>
      invoke('analysis.guide.save', { patch: GuideStatePatchSchema.parse(patch) }),
    workspaceLookup: (sessionId: string) => invoke('analysis.workspace.lookup', { sessionId }),
    workspaceList: () => invoke('analysis.workspace.list', {}),
    workspaceSession: (sessionId: string) => invoke('analysis.workspace.session', { sessionId }),
    workspaceChat: (taskId: string) => invoke('analysis.workspace.chat', { taskId }),
    workspacePin: (taskId: string, pinned: boolean) =>
      invoke('analysis.workspace.pin', { taskId, pinned }),
    workspaceProject: (taskId: string, projectDir: string | null) =>
      invoke('analysis.workspace.project', { taskId, projectDir }),
    workspaceOperations: (taskId: string) => invoke('analysis.workspace.operations', { taskId }),
    onChanged: (listener: (payload: { taskId: string }) => void) =>
      bridge.on('analysis.task.changed', listener),
    pbiAuth: () => invoke('analysis.pbi.auth', {}),
    pbiConfigure: (application: PbiApplication) =>
      invoke('analysis.pbi.configure', { application: PbiApplicationSchema.parse(application) }),
    pbiLogout: () => invoke('analysis.pbi.logout', {}),
    pbiLogin: (taskId: string, requestId: string) =>
      invoke('analysis.pbi.login', { taskId, requestId }),
    pbiDiscover: (taskId: string, requestId: string, port?: number) =>
      invoke('analysis.pbi.discover', { taskId, requestId, ...(port ? { port } : {}) }),
    pbiWorkspaces: (taskId: string, requestId: string, accountId: string) =>
      invoke('analysis.pbi.workspaces', { taskId, requestId, accountId }),
    pbiModels: (taskId: string, requestId: string, accountId: string, workspaceId: string | null) =>
      invoke('analysis.pbi.models', { taskId, requestId, accountId, workspaceId }),
    pbiBinding: (taskId: string) => invoke('analysis.pbi.binding', { taskId }),
    pbiBind: (taskId: string, target: PbiTarget) =>
      invoke('analysis.pbi.bind', { taskId, target: PbiTargetSchema.parse(target) }),
    pbiSchema: (taskId: string, requestId: string, bindingId: string) =>
      invoke('analysis.pbi.schema', { taskId, requestId, bindingId }),
    pbiPreview: (
      taskId: string,
      requestId: string,
      bindingId: string,
      table: string,
      transport: 'rest' | 'xmla'
    ) => invoke('analysis.pbi.preview', { taskId, requestId, bindingId, table, transport }),
    pbiQuery: (taskId: string, input: PbiQuery) =>
      invoke('analysis.pbi.query', { taskId, ...PbiQuerySchema.parse(input) }),
    pbiStatus: (taskId: string) => invoke('analysis.pbi.status', { taskId }),
    pbiCancel: (taskId: string, requestId: string) =>
      invoke('analysis.pbi.cancel', { taskId, requestId }),
    join: (taskId: string, input: JoinInput) =>
      invoke('analysis.datasets.join', { taskId, input: JoinInputSchema.parse(input) }),
    sqlList: (taskId: string) => invoke('analysis.sql.list', { taskId }),
    sqlSave: (taskId: string, config: SqlConnectionInput) =>
      invoke('analysis.sql.save', { taskId, config: SqlConnectionInputSchema.parse(config) }),
    sqlRemove: (taskId: string, connectionId: string) =>
      invoke('analysis.sql.remove', { taskId, connectionId }),
    sqlTest: (taskId: string, requestId: string, config: SqlConnectionInput) =>
      invoke('analysis.sql.test', {
        taskId,
        requestId,
        config: SqlConnectionInputSchema.parse(config)
      }),
    sqlSchema: (taskId: string, requestId: string, connectionId: string) =>
      invoke('analysis.sql.schema', { taskId, requestId, connectionId }),
    sqlPreview: (taskId: string, requestId: string, connectionId: string, table: string) =>
      invoke('analysis.sql.preview', { taskId, requestId, connectionId, table }),
    sqlQuery: (taskId: string, input: SqlQueryInput) =>
      invoke('analysis.sql.query', { taskId, ...input }),
    sqlCancel: (taskId: string, requestId: string) =>
      invoke('analysis.sql.cancel', { taskId, requestId }),
    sqlStatus: (taskId: string) => invoke('analysis.sql.status', { taskId }),
    reports: (taskId: string) => invoke('analysis.reports.list', { taskId }),
    createReport: (
      taskId: string,
      input: Omit<DeepchatRouteInput<'analysis.reports.create'>, 'taskId'>
    ) => invoke('analysis.reports.create', { ...input, taskId }),
    retryReport: (taskId: string, reportId: string) =>
      invoke('analysis.reports.retry', { taskId, reportId }),
    cancelReport: (taskId: string, reportId: string) =>
      invoke('analysis.reports.cancel', { taskId, reportId }),
    saveReport: (taskId: string, reportId: string, kind: 'pdf' | 'evidence') =>
      invoke('analysis.reports.save', { taskId, reportId, kind }),
    openReport: (taskId: string, reportId: string) =>
      invoke('analysis.reports.open', { taskId, reportId }),
    revealReport: (taskId: string, reportId: string) =>
      invoke('analysis.reports.reveal', { taskId, reportId }),
    models: () => invoke('analysis.models', {}),
    dataTargets: (taskId: string) => invoke('analysis.data.targets', { taskId }),
    ask: (taskId: string, input: Omit<DeepchatRouteInput<'analysis.ask'>, 'taskId'>) =>
      invoke('analysis.ask', { ...NaturalAskSchema.parse(input), taskId }),
    cancel: (taskId: string, requestId: string) => invoke('analysis.cancel', { taskId, requestId }),
    status: (taskId: string) => invoke('analysis.status', { taskId }),
    publishTurn: (taskId: string, turnId: string, candidateHash: string) =>
      invoke('analysis.turns.publish', { taskId, turnId, candidateHash }),
    list: () => invoke('analysis.tasks.list', {}),
    create: (title: string) => invoke('analysis.tasks.create', { title }),
    get: (taskId: string) => invoke('analysis.tasks.get', { taskId }),
    rename: (taskId: string, title: string) => invoke('analysis.tasks.rename', { taskId, title }),
    pick: (taskId: string) => invoke('analysis.sources.pick', { taskId }),
    remove: (taskId: string, sourceId: string) =>
      invoke('analysis.sources.remove', { taskId, sourceId }),
    refresh: (taskId: string, sourceId: string) =>
      invoke('analysis.sources.refresh', { taskId, sourceId }),
    preview: (input: DeepchatRouteInput<'analysis.sources.preview'>) =>
      invoke('analysis.sources.preview', input),
    run: (taskId: string, plan: AnalysisPlan) =>
      invoke('analysis.calculate', { taskId, plan: AnalysisPlanSchema.parse(plan) }),
    publish: (taskId: string, runId: string, candidateHash: string) =>
      invoke('analysis.answers.publish', { taskId, runId, candidateHash })
  }
}
