import { app, BrowserWindow, session, webContents } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { z } from 'zod'
import { AnalysisErrorCodes } from '@shared/analysis'
import { AnalysisError } from '../errors'
import type { ReportRenderer } from './service'

const pdfInfo = z.object({
  pages: z.number().int().min(1).max(200),
  bytes: z.number().int().min(1000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/)
})
function check(signal: AbortSignal) {
  if (signal.aborted)
    throw signal.reason instanceof AnalysisError
      ? signal.reason
      : new AnalysisError('REPORT_CANCELLED')
}
async function verifyInWorker(
  pdf: Buffer,
  expectedTokens: string[],
  format: 'a4' | 'slides',
  signal: AbortSignal
) {
  check(signal)
  return new Promise<z.infer<typeof pdfInfo>>((resolve, reject) => {
    const worker = new Worker(path.join(app.getAppPath(), 'out/main/analysisReportWorker.js'), {
      workerData: { pdf, expectedTokens, format },
      resourceLimits: { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 32 }
    })
    let settled = false
    const cancel = () =>
      finish(
        signal.reason instanceof AnalysisError
          ? signal.reason
          : new AnalysisError('REPORT_CANCELLED')
      )
    const finish = (error?: unknown, data?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      void worker.terminate()
      if (error) reject(error)
      else {
        try {
          resolve(pdfInfo.parse(data))
        } catch {
          reject(new AnalysisError('REPORT_RENDER_FAILED'))
        }
      }
    }
    const timer = setTimeout(() => finish(new AnalysisError('REPORT_TIMEOUT')), 30000)
    signal.addEventListener('abort', cancel, { once: true })
    worker.once('message', (message: { ok: boolean; data?: unknown; error?: string }) =>
      message.ok
        ? finish(undefined, message.data)
        : finish(
            new AnalysisError(
              AnalysisErrorCodes.includes(message.error as (typeof AnalysisErrorCodes)[number])
                ? (message.error as (typeof AnalysisErrorCodes)[number])
                : 'REPORT_RENDER_FAILED'
            )
          )
    )
    worker.once('error', () => finish(new AnalysisError('REPORT_RENDER_FAILED')))
    worker.once('exit', () => {
      if (!settled) finish(new AnalysisError('REPORT_RENDER_FAILED'))
    })
  })
}
async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel: (() => void) | undefined
  const stopped = new Promise<never>((_resolve, reject) => {
    cancel = () =>
      reject(
        signal.reason instanceof AnalysisError
          ? signal.reason
          : new AnalysisError('REPORT_CANCELLED')
      )
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
  })
  try {
    return await Promise.race([pending, stopped])
  } finally {
    if (cancel) signal.removeEventListener('abort', cancel)
  }
}
export function createNativeReportRenderer(): ReportRenderer {
  let reportSession: ReturnType<typeof session.fromPartition> | undefined
  const documents = new Map<number, string>()
  const getSession = () => {
    if (!reportSession) {
      reportSession = session.fromPartition('analysis-reports')
      reportSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false)
      )
      reportSession.setPermissionCheckHandler(() => false)
      // One memory session, with separate document allowlists for concurrent print windows.
      reportSession.webRequest.onBeforeRequest((details, callback) =>
        callback({
          cancel:
            details.webContentsId == null || documents.get(details.webContentsId) !== details.url
        })
      )
    }
    return reportSession
  }
  return {
    async render(input) {
      // Positive owners are renderer requests; negative owners are main-process Agent jobs,
      // whose lifetime is already controlled by the caller's AbortSignal.
      const owner = input.owner > 0 ? webContents.fromId(input.owner) : undefined
      if (input.owner >= 0 && (!owner || owner.isDestroyed()))
        throw new AnalysisError('REPORT_CANCELLED')
      const ownerController = new AbortController()
      const onDestroyed = () => ownerController.abort(new AnalysisError('REPORT_CANCELLED'))
      owner?.once('destroyed', onDestroyed)
      const signal = AbortSignal.any([input.signal, ownerController.signal])
      const documentUrl = pathToFileURL(input.htmlPath).href
      let window: BrowserWindow | undefined
      let contentsId: number | undefined
      const cancel = () => {
        if (window && !window.isDestroyed()) window.destroy()
      }
      signal.addEventListener('abort', cancel, { once: true })
      try {
        check(signal)
        input.progress('rendering')
        window = new BrowserWindow({
          show: false,
          width: input.options.format === 'slides' ? 1166 : 665,
          height: 900,
          useContentSize: true,
          webPreferences: {
            session: getSession(),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            webviewTag: false,
            navigateOnDragDrop: false,
            backgroundThrottling: false,
            devTools: false,
            spellcheck: false
          }
        })
        contentsId = window.webContents.id
        documents.set(contentsId, documentUrl)
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        window.webContents.on('will-navigate', (event, url) => {
          if (url !== documentUrl && !url.startsWith(documentUrl + '#')) event.preventDefault()
        })
        window.webContents.on('will-attach-webview', (event) => event.preventDefault())
        await abortable(window.loadURL(documentUrl), signal)
        check(signal)
        const maxHeight = input.options.format === 'slides' ? 600 : 970
        const layout = await abortable(
          window.webContents.executeJavaScript(
            `(async()=>{await document.fonts.ready;const width=document.body.clientWidth;return {overflow:document.body.scrollWidth>width+2,oversize:[...document.querySelectorAll('tr,[data-keep],h2,h3')].some(element=>element.getBoundingClientRect().height>${maxHeight})}})()`
          ),
          signal
        )
        if (layout.overflow || layout.oversize) throw new AnalysisError('REPORT_LAYOUT')
        check(signal)
        const pdf = await abortable(
          window.webContents.printToPDF({
            printBackground: true,
            preferCSSPageSize: true,
            pageSize: input.options.format === 'a4' ? 'A4' : { width: 13.333333, height: 7.5 },
            displayHeaderFooter: true,
            headerTemplate: '<span></span>',
            footerTemplate: `<div style="width:100%;font-family:Arial;font-size:8px;color:#53657a;padding:0 16mm;text-align:right">SemaPath · ${input.snapshotHash.slice(0, 12)} · <span class="pageNumber"></span> / <span class="totalPages"></span></div>`,
            generateTaggedPDF: true,
            generateDocumentOutline: true
          }),
          signal
        )
        check(signal)
        input.progress('verifying')
        const info = await verifyInWorker(pdf, input.expectedTokens, input.options.format, signal)
        check(signal)
        return { pdf, ...info }
      } catch (error) {
        check(signal)
        throw error instanceof AnalysisError ? error : new AnalysisError('REPORT_RENDER_FAILED')
      } finally {
        signal.removeEventListener('abort', cancel)
        owner?.removeListener('destroyed', onDestroyed)
        if (contentsId != null) documents.delete(contentsId)
        cancel()
      }
    }
  }
}
