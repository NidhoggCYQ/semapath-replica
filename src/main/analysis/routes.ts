import { BrowserWindow, dialog, webContents } from 'electron'
import type { z } from 'zod'
import {
  analysisCreateRoute,
  analysisDataTargetsRoute,
  analysisModelsRoute,
  analysisAskRoute,
  analysisCancelRoute,
  analysisStatusRoute,
  analysisPublishTurnRoute,
  analysisGetRoute,
  analysisListRoute,
  analysisPickRoute,
  analysisPreviewRoute,
  analysisPublishRoute,
  analysisRefreshRoute,
  analysisRemoveRoute,
  analysisRenameRoute,
  analysisRunRoute
} from '@shared/contracts/routes/analysis.routes'
import {
  createRouteMap,
  requireRendererCaller,
  type DeepchatRouteHandler
} from '@/routes/routeRegistry'
import type { AnalysisService } from './service'
import { AnalysisError } from './errors'
import logger from '@shared/logger'

export function handle<T extends z.ZodTypeAny>(
  input: T,
  action: (input: z.output<T>, context: Parameters<DeepchatRouteHandler>[1]) => unknown
): DeepchatRouteHandler {
  return async (raw, context) => {
    requireRendererCaller(context)
    const parsed = input.parse(raw)
    try {
      return { ok: true, data: await action(parsed, context) }
    } catch (error) {
      if (!(error instanceof AnalysisError)) logger.error('[Analysis] Operation failed', error)
      return { ok: false, error: error instanceof AnalysisError ? error.code : 'STORAGE_ERROR' }
    }
  }
}
export function createAnalysisRoutes(service: AnalysisService) {
  return createRouteMap([
    [
      analysisDataTargetsRoute.name,
      handle(analysisDataTargetsRoute.input, ({ taskId }) => service.dataTargets(taskId))
    ],
    [analysisModelsRoute.name, handle(analysisModelsRoute.input, () => service.models())],
    [
      analysisAskRoute.name,
      handle(analysisAskRoute.input, async (input, context) => {
        const owner = requireRendererCaller(context).webContentsId
        const contents = webContents.fromId(owner)
        if (!contents || contents.isDestroyed()) throw new AnalysisError('ANALYSIS_CANCELLED')
        const onDestroyed = () => service.cancelOwner(owner)
        contents.once('destroyed', onDestroyed)
        try {
          return await service.ask(input.taskId, input, owner)
        } finally {
          contents.removeListener('destroyed', onDestroyed)
        }
      })
    ],
    [
      analysisCancelRoute.name,
      handle(analysisCancelRoute.input, (input, context) =>
        service.cancel(input.taskId, input.requestId, requireRendererCaller(context).webContentsId)
      )
    ],
    [
      analysisStatusRoute.name,
      handle(analysisStatusRoute.input, ({ taskId }) => service.status(taskId))
    ],
    [
      analysisPublishTurnRoute.name,
      handle(analysisPublishTurnRoute.input, ({ taskId, turnId, candidateHash }) =>
        service.publishTurn(taskId, turnId, candidateHash)
      )
    ],
    [analysisListRoute.name, handle(analysisListRoute.input, () => service.list())],
    [
      analysisCreateRoute.name,
      handle(analysisCreateRoute.input, ({ title }) => service.create(title))
    ],
    [analysisGetRoute.name, handle(analysisGetRoute.input, ({ taskId }) => service.get(taskId))],
    [
      analysisRenameRoute.name,
      handle(analysisRenameRoute.input, ({ taskId, title }) => service.rename(taskId, title))
    ],
    [
      analysisPickRoute.name,
      handle(analysisPickRoute.input, async ({ taskId }, context) => {
        service.get(taskId)
        const caller = requireRendererCaller(context)
        const window = caller.windowId == null ? null : BrowserWindow.fromId(caller.windowId)
        const options = {
          properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
          filters: [{ name: 'Excel / CSV', extensions: ['xlsx', 'xls', 'csv'] }]
        }
        const result = window
          ? await dialog.showOpenDialog(window, options)
          : await dialog.showOpenDialog(options)
        return result.canceled
          ? service.get(taskId)
          : await service.addSources(taskId, result.filePaths)
      })
    ],
    [
      analysisRemoveRoute.name,
      handle(analysisRemoveRoute.input, ({ taskId, sourceId }) => service.remove(taskId, sourceId))
    ],
    [
      analysisRefreshRoute.name,
      handle(analysisRefreshRoute.input, ({ taskId, sourceId }) =>
        service.refresh(taskId, sourceId)
      )
    ],
    [
      analysisPreviewRoute.name,
      handle(analysisPreviewRoute.input, (input) => service.preview(input))
    ],
    [
      analysisRunRoute.name,
      handle(analysisRunRoute.input, ({ taskId, plan }) => service.run(taskId, plan))
    ],
    [
      analysisPublishRoute.name,
      handle(analysisPublishRoute.input, ({ taskId, runId, candidateHash }) =>
        service.publish(taskId, runId, candidateHash)
      )
    ]
  ])
}
