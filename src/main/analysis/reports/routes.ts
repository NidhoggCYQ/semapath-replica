import { app, BrowserWindow, dialog, shell } from 'electron'
import { writeFile, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { createRouteMap, requireRendererCaller } from '@/routes/routeRegistry'
import {
  analysisReportsListRoute,
  analysisReportsCreateRoute,
  analysisReportsRetryRoute,
  analysisReportsCancelRoute,
  analysisReportsSaveRoute,
  analysisReportsOpenRoute,
  analysisReportsRevealRoute
} from '@shared/contracts/routes/analysis.routes'
import { handle } from '../routes'
import { AnalysisError } from '../errors'
import type { AnalysisReportService } from './service'
export function createAnalysisReportRoutes(service: AnalysisReportService) {
  return createRouteMap([
    [
      analysisReportsListRoute.name,
      handle(analysisReportsListRoute.input, ({ taskId }) => service.list(taskId))
    ],
    [
      analysisReportsCreateRoute.name,
      handle(analysisReportsCreateRoute.input, (input, context) =>
        service.create(input.taskId, input, requireRendererCaller(context).webContentsId)
      )
    ],
    [
      analysisReportsRetryRoute.name,
      handle(analysisReportsRetryRoute.input, (input, context) =>
        service.retry(input.taskId, input.reportId, requireRendererCaller(context).webContentsId)
      )
    ],
    [
      analysisReportsCancelRoute.name,
      handle(analysisReportsCancelRoute.input, (input, context) =>
        service.cancel(input.taskId, input.reportId, requireRendererCaller(context).webContentsId)
      )
    ],
    [
      analysisReportsOpenRoute.name,
      handle(analysisReportsOpenRoute.input, async ({ taskId, reportId }) => {
        const file = await service.verifiedFile(taskId, reportId, 'pdf')
        if (await shell.openPath(file.path)) throw new AnalysisError('REPORT_FILE_MISSING')
        return true
      })
    ],
    [
      analysisReportsRevealRoute.name,
      handle(analysisReportsRevealRoute.input, async ({ taskId, reportId }) => {
        const file = await service.verifiedFile(taskId, reportId, 'pdf')
        shell.showItemInFolder(file.path)
        return true
      })
    ],
    [
      analysisReportsSaveRoute.name,
      handle(analysisReportsSaveRoute.input, async (input, context) => {
        const initial = await service.verifiedFile(input.taskId, input.reportId, input.kind)
        const caller = requireRendererCaller(context)
        const window = caller.windowId == null ? null : BrowserWindow.fromId(caller.windowId)
        const extension = input.kind === 'pdf' ? 'pdf' : 'json'
        const options = {
          defaultPath: path.join(app.getPath('documents'), initial.name),
          filters: [
            { name: input.kind === 'pdf' ? 'PDF' : 'Evidence JSON', extensions: [extension] }
          ]
        }
        const result = window
          ? await dialog.showSaveDialog(window, options)
          : await dialog.showSaveDialog(options)
        if (result.canceled || !result.filePath) return null
        if (!result.filePath.toLowerCase().endsWith('.' + extension))
          throw new AnalysisError('REPORT_SAVE_FAILED')
        const file = await service.verifiedFile(input.taskId, input.reportId, input.kind)
        if (path.resolve(result.filePath) === path.resolve(file.path)) return result.filePath
        const temporary = path.join(path.dirname(result.filePath), `.semapath-${randomUUID()}.tmp`)
        try {
          await writeFile(temporary, file.bytes, { flag: 'wx' })
          await rename(temporary, result.filePath)
          return result.filePath
        } catch {
          throw new AnalysisError('REPORT_SAVE_FAILED')
        } finally {
          await unlink(temporary).catch(() => {})
        }
      })
    ]
  ])
}
