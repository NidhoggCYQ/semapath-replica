import { z } from 'zod'
import { defineRouteContract } from '../common'
import { AnalysisErrorCodes } from '../../analysis'
import {
  AnalysisContextSchema,
  AnalysisContextViewSchema,
  DataReferenceSchema,
  ReferenceCatalogSchema,
  QuoteOriginSchema,
  TaskPanelStateSchema,
  GuideStateSchema,
  TaskPanelStatePatchSchema,
  GuideStatePatchSchema
} from '../../analysisInteraction'

const result = <T extends z.ZodTypeAny>(data: T) =>
  z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), error: z.enum(AnalysisErrorCodes) })
  ])
const task = z.object({ taskId: z.string().uuid() })
export const analysisReferenceCatalogRoute = defineRouteContract({
  name: 'analysis.references.catalog',
  input: task.extend({ query: z.string().max(200).default('') }),
  output: result(ReferenceCatalogSchema)
})
export const analysisReferenceCreateRoute = defineRouteContract({
  name: 'analysis.references.create',
  input: task.extend({ reference: DataReferenceSchema }),
  output: result(AnalysisContextSchema)
})
export const analysisQuoteCreateRoute = defineRouteContract({
  name: 'analysis.quotes.create',
  input: task.extend({ origin: QuoteOriginSchema, text: z.string().trim().min(1).max(2000) }),
  output: result(AnalysisContextSchema)
})
export const analysisContextGetRoute = defineRouteContract({
  name: 'analysis.context.get',
  input: task.extend({ contextId: z.string().uuid() }),
  output: result(AnalysisContextViewSchema)
})
export const analysisPanelsGetRoute = defineRouteContract({
  name: 'analysis.panels.get',
  input: task,
  output: result(TaskPanelStateSchema)
})
export const analysisPanelsSaveRoute = defineRouteContract({
  name: 'analysis.panels.save',
  input: task.extend({ patch: TaskPanelStatePatchSchema }),
  output: result(TaskPanelStateSchema)
})
export const analysisGuideGetRoute = defineRouteContract({
  name: 'analysis.guide.get',
  input: z.object({}),
  output: result(GuideStateSchema)
})
export const analysisGuideSaveRoute = defineRouteContract({
  name: 'analysis.guide.save',
  input: z.object({ patch: GuideStatePatchSchema }),
  output: result(GuideStateSchema)
})
export const analysisWorkspaceLookupRoute = defineRouteContract({
  name: 'analysis.workspace.lookup',
  input: z.object({ sessionId: z.string().min(1).max(200) }),
  output: result(z.string().uuid().nullable())
})
export const analysisInteractionRoutes = [
  analysisReferenceCatalogRoute,
  analysisReferenceCreateRoute,
  analysisQuoteCreateRoute,
  analysisContextGetRoute,
  analysisPanelsGetRoute,
  analysisPanelsSaveRoute,
  analysisGuideGetRoute,
  analysisGuideSaveRoute,
  analysisWorkspaceLookupRoute
] as const
export const ANALYSIS_INTERACTION_ROUTE_CATALOG = {
  [analysisReferenceCatalogRoute.name]: analysisReferenceCatalogRoute,
  [analysisReferenceCreateRoute.name]: analysisReferenceCreateRoute,
  [analysisQuoteCreateRoute.name]: analysisQuoteCreateRoute,
  [analysisContextGetRoute.name]: analysisContextGetRoute,
  [analysisPanelsGetRoute.name]: analysisPanelsGetRoute,
  [analysisPanelsSaveRoute.name]: analysisPanelsSaveRoute,
  [analysisGuideGetRoute.name]: analysisGuideGetRoute,
  [analysisGuideSaveRoute.name]: analysisGuideSaveRoute,
  [analysisWorkspaceLookupRoute.name]: analysisWorkspaceLookupRoute
}
