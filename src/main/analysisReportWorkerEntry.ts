import { parentPort, workerData } from 'node:worker_threads'
import { verifyReportPdf } from './analysis/reports/verify'
import { AnalysisError } from './analysis/errors'
async function main() {
  try {
    parentPort?.postMessage({
      ok: true,
      data: await verifyReportPdf(
        Buffer.from(workerData.pdf),
        workerData.expectedTokens,
        workerData.format
      )
    })
  } catch (error) {
    parentPort?.postMessage({
      ok: false,
      error: error instanceof AnalysisError ? error.code : 'REPORT_RENDER_FAILED'
    })
  }
}
void main()
