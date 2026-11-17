import { z } from 'zod'
import { defineRouteContract } from '../common'
import { AnalysisTaskSchema, AnalysisErrorCodes } from '../../analysis'
import {
  PbiApplicationSchema,
  PbiAuthStatusSchema,
  PbiBindingSchema,
  PbiTargetSchema,
  PbiLocalModelSchema,
  PbiWorkspaceSchema,
  PbiCloudModelSchema,
  PbiSchemaSchema,
  PbiTableSchema,
  PbiQuerySchema,
  PbiProgressSchema
} from '../../analysisPowerBi'
const task = z.object({ taskId: z.string().uuid() }),
  request = task.extend({ requestId: z.string().uuid() }),
  binding = request.extend({ bindingId: z.string().uuid() })
const result = <T extends z.ZodTypeAny>(data: T) =>
  z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), error: z.enum(AnalysisErrorCodes) })
  ])
export const pbiAuthRoute = defineRouteContract({
  name: 'analysis.pbi.auth',
  input: z.object({}),
  output: result(PbiAuthStatusSchema)
})
export const pbiConfigureRoute = defineRouteContract({
  name: 'analysis.pbi.configure',
  input: z.object({ application: PbiApplicationSchema }),
  output: result(PbiAuthStatusSchema)
})
export const pbiLogoutRoute = defineRouteContract({
  name: 'analysis.pbi.logout',
  input: z.object({}),
  output: result(PbiAuthStatusSchema)
})
export const pbiLoginRoute = defineRouteContract({
  name: 'analysis.pbi.login',
  input: request,
  output: result(PbiAuthStatusSchema)
})
export const pbiDiscoverRoute = defineRouteContract({
  name: 'analysis.pbi.discover',
  input: request.extend({ port: z.number().int().min(1).max(65535).optional() }),
  output: result(z.array(PbiLocalModelSchema))
})
export const pbiWorkspacesRoute = defineRouteContract({
  name: 'analysis.pbi.workspaces',
  input: request.extend({ accountId: z.string() }),
  output: result(z.array(PbiWorkspaceSchema))
})
export const pbiModelsRoute = defineRouteContract({
  name: 'analysis.pbi.models',
  input: request.extend({ accountId: z.string(), workspaceId: z.string().uuid().nullable() }),
  output: result(z.array(PbiCloudModelSchema))
})
export const pbiBindingRoute = defineRouteContract({
  name: 'analysis.pbi.binding',
  input: task,
  output: result(PbiBindingSchema.nullable())
})
export const pbiBindRoute = defineRouteContract({
  name: 'analysis.pbi.bind',
  input: task.extend({ target: PbiTargetSchema }),
  output: result(PbiBindingSchema)
})
export const pbiSchemaRoute = defineRouteContract({
  name: 'analysis.pbi.schema',
  input: binding,
  output: result(PbiSchemaSchema)
})
export const pbiPreviewRoute = defineRouteContract({
  name: 'analysis.pbi.preview',
  input: binding.extend({ table: z.string().min(1).max(512), transport: z.enum(['rest', 'xmla']) }),
  output: result(PbiTableSchema)
})
export const pbiQueryRoute = defineRouteContract({
  name: 'analysis.pbi.query',
  input: PbiQuerySchema.extend({ taskId: z.string().uuid() }),
  output: result(AnalysisTaskSchema)
})
export const pbiStatusRoute = defineRouteContract({
  name: 'analysis.pbi.status',
  input: task,
  output: result(PbiProgressSchema.nullable())
})
export const pbiCancelRoute = defineRouteContract({
  name: 'analysis.pbi.cancel',
  input: request,
  output: result(z.boolean())
})
export const analysisPowerBiRoutes = [
  pbiAuthRoute,
  pbiConfigureRoute,
  pbiLogoutRoute,
  pbiLoginRoute,
  pbiDiscoverRoute,
  pbiWorkspacesRoute,
  pbiModelsRoute,
  pbiBindingRoute,
  pbiBindRoute,
  pbiSchemaRoute,
  pbiPreviewRoute,
  pbiQueryRoute,
  pbiStatusRoute,
  pbiCancelRoute
] as const
export const ANALYSIS_POWERBI_ROUTE_CATALOG = {
  [pbiAuthRoute.name]: pbiAuthRoute,
  [pbiConfigureRoute.name]: pbiConfigureRoute,
  [pbiLogoutRoute.name]: pbiLogoutRoute,
  [pbiLoginRoute.name]: pbiLoginRoute,
  [pbiDiscoverRoute.name]: pbiDiscoverRoute,
  [pbiWorkspacesRoute.name]: pbiWorkspacesRoute,
  [pbiModelsRoute.name]: pbiModelsRoute,
  [pbiBindingRoute.name]: pbiBindingRoute,
  [pbiBindRoute.name]: pbiBindRoute,
  [pbiSchemaRoute.name]: pbiSchemaRoute,
  [pbiPreviewRoute.name]: pbiPreviewRoute,
  [pbiQueryRoute.name]: pbiQueryRoute,
  [pbiStatusRoute.name]: pbiStatusRoute,
  [pbiCancelRoute.name]: pbiCancelRoute
}
