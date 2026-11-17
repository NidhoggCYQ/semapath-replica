import { webContents } from 'electron'
import {
  createRouteMap,
  requireRendererCaller,
  type DeepchatRouteHandler
} from '@/routes/routeRegistry'
import * as r from '@shared/contracts/routes/analysisPowerBi.routes'
import { handle } from '../routes'
import type { PbiService } from './service'
import { AnalysisError } from '../errors'
export function createPowerBiRoutes(service: PbiService) {
  const owned = <T>(
    context: Parameters<DeepchatRouteHandler>[1],
    action: (owner: number) => Promise<T>
  ) => {
    const owner = requireRendererCaller(context).webContentsId,
      contents = webContents.fromId(owner)
    if (!contents || contents.isDestroyed()) throw new AnalysisError('PBI_CANCELLED')
    const stop = () => service.cancelOwner(owner)
    contents.once('destroyed', stop)
    return action(owner).finally(() => contents.removeListener('destroyed', stop))
  }
  return createRouteMap([
    [r.pbiAuthRoute.name, handle(r.pbiAuthRoute.input, () => service.auth.status())],
    [
      r.pbiConfigureRoute.name,
      handle(r.pbiConfigureRoute.input, ({ application }) => service.configure(application))
    ],
    [r.pbiLogoutRoute.name, handle(r.pbiLogoutRoute.input, () => service.logout())],
    [
      r.pbiLoginRoute.name,
      handle(r.pbiLoginRoute.input, ({ taskId, requestId }, c) =>
        owned(c, (o) => service.login(taskId, requestId, o))
      )
    ],
    [
      r.pbiDiscoverRoute.name,
      handle(r.pbiDiscoverRoute.input, ({ taskId, requestId, port }, c) =>
        owned(c, (o) => service.discover(taskId, requestId, o, port))
      )
    ],
    [
      r.pbiWorkspacesRoute.name,
      handle(r.pbiWorkspacesRoute.input, ({ taskId, requestId, accountId }, c) =>
        owned(c, (o) => service.workspaces(taskId, requestId, accountId, o))
      )
    ],
    [
      r.pbiModelsRoute.name,
      handle(r.pbiModelsRoute.input, ({ taskId, requestId, accountId, workspaceId }, c) =>
        owned(c, (o) => service.models(taskId, requestId, accountId, workspaceId, o))
      )
    ],
    [
      r.pbiBindingRoute.name,
      handle(r.pbiBindingRoute.input, ({ taskId }) => service.binding(taskId))
    ],
    [
      r.pbiBindRoute.name,
      handle(r.pbiBindRoute.input, ({ taskId, target }) => service.bind(taskId, target))
    ],
    [
      r.pbiSchemaRoute.name,
      handle(r.pbiSchemaRoute.input, ({ taskId, requestId, bindingId }, c) =>
        owned(c, (o) => service.schema(taskId, requestId, bindingId, o))
      )
    ],
    [
      r.pbiPreviewRoute.name,
      handle(r.pbiPreviewRoute.input, ({ taskId, requestId, bindingId, table, transport }, c) =>
        owned(c, (o) => service.preview(taskId, requestId, bindingId, table, transport, o))
      )
    ],
    [
      r.pbiQueryRoute.name,
      handle(r.pbiQueryRoute.input, ({ taskId, ...input }, c) =>
        owned(c, (o) => service.query(taskId, input, o))
      )
    ],
    [r.pbiStatusRoute.name, handle(r.pbiStatusRoute.input, ({ taskId }) => service.status(taskId))],
    [
      r.pbiCancelRoute.name,
      handle(r.pbiCancelRoute.input, ({ taskId, requestId }, c) =>
        service.cancel(taskId, requestId, requireRendererCaller(c).webContentsId)
      )
    ]
  ])
}
