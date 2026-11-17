import { webContents } from 'electron'
import {
  createRouteMap,
  requireRendererCaller,
  type DeepchatRouteHandler
} from '@/routes/routeRegistry'
import {
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
} from '@shared/contracts/routes/analysisData.routes'
import { handle } from './routes'
import type { AnalysisService } from './service'
import type { SqlService } from './sqlService'
import { AnalysisError } from './errors'

export function createAnalysisDataRoutes(analysis: AnalysisService, sql: SqlService) {
  const owned = <T>(
    context: Parameters<DeepchatRouteHandler>[1],
    operation: (owner: number) => Promise<T>
  ) => {
    const owner = requireRendererCaller(context).webContentsId
    const contents = webContents.fromId(owner)
    if (!contents || contents.isDestroyed()) throw new AnalysisError('SQL_CANCELLED')
    const stop = () => sql.cancelOwner(owner)
    contents.once('destroyed', stop)
    return operation(owner).finally(() => contents.removeListener('destroyed', stop))
  }
  return createRouteMap([
    [
      dataJoinRoute.name,
      handle(dataJoinRoute.input, ({ taskId, input }) => analysis.join(taskId, input))
    ],
    [sqlListRoute.name, handle(sqlListRoute.input, ({ taskId }) => sql.list(taskId))],
    [
      sqlSaveRoute.name,
      handle(sqlSaveRoute.input, ({ taskId, config }) => sql.save(taskId, config))
    ],
    [
      sqlRemoveRoute.name,
      handle(sqlRemoveRoute.input, ({ taskId, connectionId }) => sql.remove(taskId, connectionId))
    ],
    [sqlStatusRoute.name, handle(sqlStatusRoute.input, ({ taskId }) => sql.status(taskId))],
    [
      sqlCancelRoute.name,
      handle(sqlCancelRoute.input, ({ taskId, requestId }, context) =>
        sql.cancel(taskId, requestId, requireRendererCaller(context).webContentsId)
      )
    ],
    [
      sqlTestRoute.name,
      handle(sqlTestRoute.input, ({ taskId, requestId, config }, context) =>
        owned(context, (owner) => sql.test(taskId, requestId, config, owner))
      )
    ],
    [
      sqlSchemaRoute.name,
      handle(sqlSchemaRoute.input, ({ taskId, requestId, connectionId }, context) =>
        owned(context, (owner) => sql.schema(taskId, requestId, connectionId, owner))
      )
    ],
    [
      sqlPreviewRoute.name,
      handle(sqlPreviewRoute.input, ({ taskId, requestId, connectionId, table }, context) =>
        owned(context, (owner) => sql.preview(taskId, requestId, connectionId, table, owner))
      )
    ],
    [
      sqlQueryRoute.name,
      handle(sqlQueryRoute.input, ({ taskId, ...input }, context) =>
        owned(context, (owner) => sql.query(taskId, input, owner))
      )
    ]
  ])
}
