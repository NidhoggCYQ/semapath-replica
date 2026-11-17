import { Worker } from 'node:worker_threads'
import path from 'node:path'
import { app } from 'electron'
import type { z } from 'zod'
import {
  AnalysisErrorCodes,
  WorkbookCatalogSchema,
  AnalysisPreviewSchema,
  AnalysisRunSchema,
  AnalysisSourceSchema,
  type AnalysisPlan,
  type AnalysisSource
} from '@shared/analysis'
import { AnalysisError } from './errors'
import { DatasetBuildSchema, type JoinInput } from '@shared/analysisData'
import { FileResultsBuildSchema, type FileExecutionMetadata } from './fileResult'

export type WorkbookJob =
  | { kind: 'file-results'; raw: string; metadata: FileExecutionMetadata }
  | { kind: 'join'; left: AnalysisSource; right: AnalysisSource; input: JoinInput }
  | { kind: 'inspect'; path: string; id?: string }
  | { kind: 'describe'; source: AnalysisSource }
  | { kind: 'preview'; source: AnalysisSource; sheet: string; headerRow: number; page: number }
  | { kind: 'calculate'; source: AnalysisSource; plan: AnalysisPlan }
let active = 0
type WaitingJob = { grant: () => void }
const waiting: WaitingJob[] = []
function abortReason(signal: AbortSignal): AnalysisError {
  return signal.reason instanceof AnalysisError
    ? signal.reason
    : new AnalysisError('ANALYSIS_CANCELLED')
}
async function acquire(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortReason(signal)
  if (active < 2) {
    active++
    return
  }
  if (waiting.length >= 12) throw new AnalysisError('BUSY')
  await new Promise<void>((resolve, reject) => {
    const entry: WaitingJob = {
      grant: () => {
        signal?.removeEventListener('abort', cancel)
        resolve()
      }
    }
    const cancel = () => {
      const index = waiting.indexOf(entry)
      if (index !== -1) waiting.splice(index, 1)
      signal?.removeEventListener('abort', cancel)
      reject(abortReason(signal!))
    }
    waiting.push(entry)
    signal?.addEventListener('abort', cancel, { once: true })
  })
}
async function runJob<T extends z.ZodTypeAny>(
  job: WorkbookJob,
  schema: T,
  signal?: AbortSignal
): Promise<z.output<T>> {
  await acquire(signal)
  try {
    if (signal?.aborted) throw abortReason(signal)
    return await new Promise<z.output<T>>((resolve, reject) => {
      const worker = new Worker(path.join(app.getAppPath(), 'out/main/analysisWorker.js'), {
        workerData: job,
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 }
      })
      let settled = false
      const cancel = () => finish(abortReason(signal!))
      const finish = (error?: unknown, data?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancel)
        void worker.terminate()
        if (error) reject(error)
        else {
          try {
            resolve(schema.parse(data))
          } catch {
            reject(new AnalysisError('INVALID_WORKBOOK'))
          }
        }
      }
      const timer = setTimeout(() => finish(new AnalysisError('FILE_LIMIT')), 30000)
      signal?.addEventListener('abort', cancel, { once: true })
      worker.once('message', (message: { ok: boolean; data?: unknown; error?: string }) => {
        if (message.ok) finish(undefined, message.data)
        else
          finish(
            new AnalysisError(
              AnalysisErrorCodes.includes(message.error as (typeof AnalysisErrorCodes)[number])
                ? (message.error as (typeof AnalysisErrorCodes)[number])
                : 'INVALID_WORKBOOK'
            )
          )
      })
      worker.once('error', () => finish(new AnalysisError('INVALID_WORKBOOK')))
      worker.once('exit', () => {
        if (!settled) finish(new AnalysisError('INVALID_WORKBOOK'))
      })
    })
  } finally {
    const next = waiting.shift()
    if (next) next.grant()
    else active--
  }
}
export const inspectWorkbook = (filePath: string, id?: string, signal?: AbortSignal) =>
  runJob({ kind: 'inspect', path: filePath, id }, AnalysisSourceSchema, signal)
export const previewSource = (
  source: AnalysisSource,
  sheet: string,
  headerRow: number,
  page: number
) => runJob({ kind: 'preview', source, sheet, headerRow, page }, AnalysisPreviewSchema)
export const calculateSource = (source: AnalysisSource, plan: AnalysisPlan, signal?: AbortSignal) =>
  runJob({ kind: 'calculate', source, plan }, AnalysisRunSchema, signal)
export const describeSource = (source: AnalysisSource, signal?: AbortSignal) =>
  runJob({ kind: 'describe', source }, WorkbookCatalogSchema, signal)
export const buildFileResultSnapshots = (
  raw: string,
  metadata: FileExecutionMetadata,
  signal?: AbortSignal
) => runJob({ kind: 'file-results', raw, metadata }, FileResultsBuildSchema, signal)
export const buildJoinedSource = (
  left: AnalysisSource,
  right: AnalysisSource,
  input: JoinInput,
  signal?: AbortSignal
) => runJob({ kind: 'join', left, right, input }, DatasetBuildSchema, signal)
