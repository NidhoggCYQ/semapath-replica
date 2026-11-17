import { parentPort, workerData } from 'node:worker_threads'
import {
  loadWorkbook,
  previewWorkbook,
  calculateWorkbook,
  describeWorkbook
} from './analysis/workbook'
import { AnalysisError } from './analysis/errors'
import type { WorkbookJob } from './analysis/workerClient'
import { joinWorkbooks } from './analysis/joinWorkbook'
import { buildFileResultDatasets } from './analysis/fileResult'

async function run() {
  const job = workerData as WorkbookJob
  try {
    if (job.kind === 'file-results') {
      parentPort?.postMessage({ ok: true, data: buildFileResultDatasets(job.raw, job.metadata) })
      return
    }
    if (job.kind === 'join') {
      const left = await loadWorkbook(job.left.path, job.left.id)
      const right = await loadWorkbook(job.right.path, job.right.id)
      const data = joinWorkbooks(left, right, job.left, job.right, job.input)
      parentPort?.postMessage({ ok: true, data })
      return
    }
    const loaded =
      job.kind === 'inspect'
        ? await loadWorkbook(job.path, job.id)
        : await loadWorkbook(job.source.path, job.source.id)
    const data =
      job.kind === 'inspect'
        ? loaded.source
        : job.kind === 'describe'
          ? describeWorkbook(loaded, job.source)
          : job.kind === 'preview'
            ? previewWorkbook(loaded, job.source, job.sheet, job.headerRow, job.page)
            : calculateWorkbook(loaded, job.source, job.plan)
    parentPort?.postMessage({ ok: true, data })
  } catch (error) {
    parentPort?.postMessage({
      ok: false,
      error: error instanceof AnalysisError ? error.code : 'INVALID_WORKBOOK'
    })
  }
}
void run()
