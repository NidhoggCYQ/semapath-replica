import pdfParse from 'pdf-parse-new'
import { createHash } from 'node:crypto'
import { AnalysisError } from '../errors'

type PdfPage = {
  getViewport(options: { scale: number }): { width: number; height: number }
  getTextContent(): Promise<{ items: Array<{ str?: string }> }>
}
export async function verifyReportPdf(
  pdf: Buffer,
  expectedTokens: string[],
  format: 'a4' | 'slides'
) {
  if (pdf.length > 50 * 1024 * 1024) throw new AnalysisError('REPORT_LIMIT')
  if (pdf.length < 1000 || pdf.subarray(0, 5).toString() !== '%PDF-')
    throw new AnalysisError('REPORT_RENDER_FAILED')
  const expected = format === 'a4' ? [595.28, 841.89] : [960, 540]
  let geometryValid = true
  const parsed = await pdfParse(pdf, {
    verbosityLevel: 0,
    pagerender: async (page: PdfPage) => {
      const viewport = page.getViewport({ scale: 1 })
      if (Math.abs(viewport.width - expected[0]) > 2 || Math.abs(viewport.height - expected[1]) > 2)
        geometryValid = false
      return (await page.getTextContent()).items.map((item) => item.str ?? '').join(' ')
    }
  })
  if (!Number.isInteger(parsed.numpages) || parsed.numpages < 1 || parsed.numpages > 200)
    throw new AnalysisError('REPORT_LIMIT')
  const normalize = (text: string) => text.normalize('NFKC').replace(/\s/g, '')
  const body = normalize(parsed.text)
  if (!geometryValid || expectedTokens.some((token) => !body.includes(normalize(token))))
    throw new AnalysisError('REPORT_LAYOUT')
  return {
    pages: parsed.numpages,
    bytes: pdf.length,
    sha256: createHash('sha256').update(pdf).digest('hex')
  }
}
