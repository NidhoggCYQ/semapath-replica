import { z } from 'zod'
import { defineRouteContract } from '../common'
import { AnalysisTaskSchema, AnalysisErrorCodes } from '../../analysis'
import {
  SqlConnectionInputSchema,
  SqlConnectionSchema,
  SqlTableSchema,
  SqlQueryInputSchema,
  SqlProgressSchema,
  JoinInputSchema
} from '../../analysisData'
const task = z.object({ taskId: z.string().uuid() })
const request = task.extend({ requestId: z.string().uuid() })
const connection = request.extend({ connectionId: z.string().uuid() })
const result = <T extends z.ZodTypeAny>(data: T) =>
  z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), error: z.enum(AnalysisErrorCodes) })
  ])
export const dataJoinRoute = defineRouteContract({
  name: 'analysis.datasets.join',
  input: task.extend({ input: JoinInputSchema }),
  output: result(AnalysisTaskSchema)
})
export const sqlListRoute = defineRouteContract({
  name: 'analysis.sql.list',
  input: task,
  output: result(z.array(SqlConnectionSchema))
})
export const sqlSaveRoute = defineRouteContract({
  name: 'analysis.sql.save',
  input: task.extend({ config: SqlConnectionInputSchema }),
  output: result(SqlConnectionSchema)
})
export const sqlRemoveRoute = defineRouteContract({
  name: 'analysis.sql.remove',
  input: task.extend({ connectionId: z.string().uuid() }),
  output: result(z.array(SqlConnectionSchema))
})
export const sqlTestRoute = defineRouteContract({
  name: 'analysis.sql.test',
  input: request.extend({ config: SqlConnectionInputSchema }),
  output: result(z.string())
})
export const sqlSchemaRoute = defineRouteContract({
  name: 'analysis.sql.schema',
  input: connection,
  output: result(z.array(SqlTableSchema))
})
export const sqlPreviewRoute = defineRouteContract({
  name: 'analysis.sql.preview',
  input: connection.extend({ table: z.string().min(1).max(255) }),
  output: result(
    z.object({ columns: z.array(z.string()), rows: z.array(z.array(z.string().nullable())) })
  )
})
export const sqlQueryRoute = defineRouteContract({
  name: 'analysis.sql.query',
  input: SqlQueryInputSchema.extend({ taskId: z.string().uuid() }),
  output: result(AnalysisTaskSchema)
})
export const sqlCancelRoute = defineRouteContract({
  name: 'analysis.sql.cancel',
  input: request,
  output: result(z.boolean())
})
export const sqlStatusRoute = defineRouteContract({
  name: 'analysis.sql.status',
  input: task,
  output: result(SqlProgressSchema.nullable())
})
export const analysisDataRoutes = [
  dataJoinRoute,
  sqlListRoute,
  sqlSaveRoute,
  sqlRemoveRoute,
  sqlTestRoute,
  sqlSchemaRoute,
  sqlPreviewRoute,
  sqlQueryRoute,
  sqlCancelRoute,
  sqlStatusRoute
] as const
export const ANALYSIS_DATA_ROUTE_CATALOG = {
  [dataJoinRoute.name]: dataJoinRoute,
  [sqlListRoute.name]: sqlListRoute,
  [sqlSaveRoute.name]: sqlSaveRoute,
  [sqlRemoveRoute.name]: sqlRemoveRoute,
  [sqlTestRoute.name]: sqlTestRoute,
  [sqlSchemaRoute.name]: sqlSchemaRoute,
  [sqlPreviewRoute.name]: sqlPreviewRoute,
  [sqlQueryRoute.name]: sqlQueryRoute,
  [sqlCancelRoute.name]: sqlCancelRoute,
  [sqlStatusRoute.name]: sqlStatusRoute
}
