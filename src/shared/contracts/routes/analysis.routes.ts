import { ReportCreateSchema, ReportRecordSchema } from '../../analysisReport'
import { z } from 'zod'
import { AnalysisWorkspaceEntrySchema, AnalysisToolRecordSchema } from '../../analysisWorkspace'
import { RetrievalTargetsSchema } from '../../analysisAcquisition'
import { analysisDataRoutes, ANALYSIS_DATA_ROUTE_CATALOG } from './analysisData.routes'
import { analysisPowerBiRoutes, ANALYSIS_POWERBI_ROUTE_CATALOG } from './analysisPowerBi.routes'
import {
  analysisInteractionRoutes,
  ANALYSIS_INTERACTION_ROUTE_CATALOG
} from './analysisInteraction.routes'
import { defineRouteContract } from '../common'
import {
  AnalysisErrorCodes,
  AnalysisModelSchema,
  NaturalAskSchema,
  NaturalProgressSchema,
  AnalysisPlanSchema,
  AnalysisPreviewSchema,
  AnalysisTaskSchema,
  AnalysisTaskSummarySchema
} from '../../analysis'

const id = z.string().uuid()
const taskInput = z.object({ taskId: id })
const result = <T extends z.ZodTypeAny>(data: T) =>
  z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), error: z.enum(AnalysisErrorCodes) })
  ])
export const analysisWorkspaceListRoute = defineRouteContract({
  name: 'analysis.workspace.list',
  input: z.object({}),
  output: result(z.array(AnalysisWorkspaceEntrySchema))
})
export const analysisWorkspaceSessionRoute = defineRouteContract({
  name: 'analysis.workspace.session',
  input: z.object({ sessionId: z.string().min(1).max(200) }),
  output: result(AnalysisTaskSchema)
})
export const analysisWorkspaceChatRoute = defineRouteContract({
  name: 'analysis.workspace.chat',
  input: taskInput,
  output: result(z.string())
})
export const analysisWorkspacePinRoute = defineRouteContract({
  name: 'analysis.workspace.pin',
  input: taskInput.extend({ pinned: z.boolean() }),
  output: result(z.boolean())
})
export const analysisWorkspaceProjectRoute = defineRouteContract({
  name: 'analysis.workspace.project',
  input: taskInput.extend({ projectDir: z.string().min(1).max(32000).nullable() }),
  output: result(AnalysisTaskSchema)
})
export const analysisWorkspaceOperationsRoute = defineRouteContract({
  name: 'analysis.workspace.operations',
  input: taskInput,
  output: result(z.array(AnalysisToolRecordSchema))
})
export const analysisListRoute = defineRouteContract({
  name: 'analysis.tasks.list',
  input: z.object({}),
  output: result(z.array(AnalysisTaskSummarySchema))
})
export const analysisCreateRoute = defineRouteContract({
  name: 'analysis.tasks.create',
  input: z.object({ title: z.string().trim().min(1).max(120) }),
  output: result(AnalysisTaskSchema)
})
export const analysisGetRoute = defineRouteContract({
  name: 'analysis.tasks.get',
  input: taskInput,
  output: result(AnalysisTaskSchema)
})
export const analysisRenameRoute = defineRouteContract({
  name: 'analysis.tasks.rename',
  input: taskInput.extend({ title: z.string().trim().min(1).max(120) }),
  output: result(AnalysisTaskSchema)
})
export const analysisPickRoute = defineRouteContract({
  name: 'analysis.sources.pick',
  input: taskInput,
  output: result(AnalysisTaskSchema)
})
export const analysisRemoveRoute = defineRouteContract({
  name: 'analysis.sources.remove',
  input: taskInput.extend({ sourceId: id }),
  output: result(AnalysisTaskSchema)
})
export const analysisRefreshRoute = defineRouteContract({
  name: 'analysis.sources.refresh',
  input: taskInput.extend({ sourceId: id }),
  output: result(AnalysisTaskSchema)
})
export const analysisPreviewRoute = defineRouteContract({
  name: 'analysis.sources.preview',
  input: taskInput.extend({
    sourceId: id,
    sheet: z.string().min(1),
    headerRow: z.number().int().min(1).max(100000),
    page: z.number().int().min(1).max(2000)
  }),
  output: result(AnalysisPreviewSchema)
})
export const analysisRunRoute = defineRouteContract({
  name: 'analysis.calculate',
  input: taskInput.extend({ plan: AnalysisPlanSchema }),
  output: result(AnalysisTaskSchema)
})
export const analysisPublishRoute = defineRouteContract({
  name: 'analysis.answers.publish',
  input: taskInput.extend({ runId: id, candidateHash: z.string().length(64) }),
  output: result(AnalysisTaskSchema)
})
export const analysisModelsRoute = defineRouteContract({
  name: 'analysis.models',
  input: z.object({}),
  output: result(z.array(AnalysisModelSchema))
})
export const analysisDataTargetsRoute = defineRouteContract({
  name: 'analysis.data.targets',
  input: taskInput,
  output: result(RetrievalTargetsSchema)
})
export const analysisAskRoute = defineRouteContract({
  name: 'analysis.ask',
  input: NaturalAskSchema.extend({ taskId: id }),
  output: result(AnalysisTaskSchema)
})
export const analysisCancelRoute = defineRouteContract({
  name: 'analysis.cancel',
  input: taskInput.extend({ requestId: id }),
  output: result(z.boolean())
})
export const analysisStatusRoute = defineRouteContract({
  name: 'analysis.status',
  input: taskInput,
  output: result(NaturalProgressSchema.nullable())
})
export const analysisPublishTurnRoute = defineRouteContract({
  name: 'analysis.turns.publish',
  input: taskInput.extend({ turnId: id, candidateHash: z.string().length(64) }),
  output: result(AnalysisTaskSchema)
})
export const analysisReportsListRoute = defineRouteContract({
  name: 'analysis.reports.list',
  input: taskInput,
  output: result(z.array(ReportRecordSchema))
})
export const analysisReportsCreateRoute = defineRouteContract({
  name: 'analysis.reports.create',
  input: ReportCreateSchema.extend({ taskId: id }),
  output: result(ReportRecordSchema)
})
export const analysisReportsRetryRoute = defineRouteContract({
  name: 'analysis.reports.retry',
  input: taskInput.extend({ reportId: id }),
  output: result(ReportRecordSchema)
})
export const analysisReportsCancelRoute = defineRouteContract({
  name: 'analysis.reports.cancel',
  input: taskInput.extend({ reportId: id }),
  output: result(z.boolean())
})
export const analysisReportsSaveRoute = defineRouteContract({
  name: 'analysis.reports.save',
  input: taskInput.extend({ reportId: id, kind: z.enum(['pdf', 'evidence']) }),
  output: result(z.string().nullable())
})
export const analysisReportsOpenRoute = defineRouteContract({
  name: 'analysis.reports.open',
  input: taskInput.extend({ reportId: id }),
  output: result(z.boolean())
})
export const analysisReportsRevealRoute = defineRouteContract({
  name: 'analysis.reports.reveal',
  input: taskInput.extend({ reportId: id }),
  output: result(z.boolean())
})
export const analysisRoutes = [
  ...analysisInteractionRoutes,
  analysisWorkspaceProjectRoute,
  analysisWorkspaceListRoute,
  analysisWorkspaceSessionRoute,
  analysisWorkspaceChatRoute,
  analysisWorkspacePinRoute,
  analysisWorkspaceOperationsRoute,
  analysisDataTargetsRoute,
  ...analysisPowerBiRoutes,
  ...analysisDataRoutes,
  analysisReportsListRoute,
  analysisReportsCreateRoute,
  analysisReportsRetryRoute,
  analysisReportsCancelRoute,
  analysisReportsSaveRoute,
  analysisReportsOpenRoute,
  analysisReportsRevealRoute,
  analysisModelsRoute,
  analysisAskRoute,
  analysisCancelRoute,
  analysisStatusRoute,
  analysisPublishTurnRoute,
  analysisListRoute,
  analysisCreateRoute,
  analysisGetRoute,
  analysisRenameRoute,
  analysisPickRoute,
  analysisRemoveRoute,
  analysisRefreshRoute,
  analysisPreviewRoute,
  analysisRunRoute,
  analysisPublishRoute
] as const
export const ANALYSIS_ROUTE_CATALOG = {
  ...ANALYSIS_INTERACTION_ROUTE_CATALOG,
  [analysisWorkspaceProjectRoute.name]: analysisWorkspaceProjectRoute,
  [analysisWorkspaceListRoute.name]: analysisWorkspaceListRoute,
  [analysisWorkspaceSessionRoute.name]: analysisWorkspaceSessionRoute,
  [analysisWorkspaceChatRoute.name]: analysisWorkspaceChatRoute,
  [analysisWorkspacePinRoute.name]: analysisWorkspacePinRoute,
  [analysisWorkspaceOperationsRoute.name]: analysisWorkspaceOperationsRoute,
  [analysisDataTargetsRoute.name]: analysisDataTargetsRoute,
  ...ANALYSIS_POWERBI_ROUTE_CATALOG,
  ...ANALYSIS_DATA_ROUTE_CATALOG,
  [analysisReportsListRoute.name]: analysisReportsListRoute,
  [analysisReportsCreateRoute.name]: analysisReportsCreateRoute,
  [analysisReportsRetryRoute.name]: analysisReportsRetryRoute,
  [analysisReportsCancelRoute.name]: analysisReportsCancelRoute,
  [analysisReportsSaveRoute.name]: analysisReportsSaveRoute,
  [analysisReportsOpenRoute.name]: analysisReportsOpenRoute,
  [analysisReportsRevealRoute.name]: analysisReportsRevealRoute,
  [analysisModelsRoute.name]: analysisModelsRoute,
  [analysisAskRoute.name]: analysisAskRoute,
  [analysisCancelRoute.name]: analysisCancelRoute,
  [analysisStatusRoute.name]: analysisStatusRoute,
  [analysisPublishTurnRoute.name]: analysisPublishTurnRoute,
  [analysisListRoute.name]: analysisListRoute,
  [analysisCreateRoute.name]: analysisCreateRoute,
  [analysisGetRoute.name]: analysisGetRoute,
  [analysisRenameRoute.name]: analysisRenameRoute,
  [analysisPickRoute.name]: analysisPickRoute,
  [analysisRemoveRoute.name]: analysisRemoveRoute,
  [analysisRefreshRoute.name]: analysisRefreshRoute,
  [analysisPreviewRoute.name]: analysisPreviewRoute,
  [analysisRunRoute.name]: analysisRunRoute,
  [analysisPublishRoute.name]: analysisPublishRoute
}
