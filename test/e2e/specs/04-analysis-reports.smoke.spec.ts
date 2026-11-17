import { createServer } from 'node:http'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import * as XLSX from 'xlsx'
import pdfParse from 'pdf-parse-new'
import { test, expect } from '../fixtures/electronApp'
import { waitForAppReady } from '../helpers/wait'
import type { ReportRecord } from '../../../src/shared/analysisReport'

test('Published answer -> frozen A4/16:9 PDF -> complete evidence, retry, cancellation and restart @smoke', async ({
  launchApp
}, testInfo) => {
  let externalRequests = 0
  const server = createServer((_request, response) => {
    externalRequests++
    response.end('unexpected external report request')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server failed')
  const workbook = XLSX.utils.book_new()
  const rows: unknown[][] = [
    ['区域', '销售额'],
    ['合成区域01-长中文标签', 0.1],
    ['合成区域01-长中文标签', 0.2],
    ['合成区域01-长中文标签', null],
    ...Array.from({ length: 64 }, (_, index) => [
      `合成区域${String(index + 2).padStart(2, '0')}-长中文标签`,
      index === 63 ? -2.05 : index === 0 ? 0 : index + 2
    ])
  ]
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), '销售明细')
  const originalBytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer
  const filePath = testInfo.outputPath('synthetic-report.xlsx')
  await writeFile(filePath, originalBytes)
  let app = await launchApp()
  try {
    await waitForAppReady(app.page)
    await app.page.getByTestId('sidebar-analysis-button').click()
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL().includes('/renderer/'))
        ?.setSize(1440, 1000)
    })
    await app.page.evaluate(() => window.deepchat.invoke('config.setTheme', { theme: 'light' }))
    await app.page.getByTestId('analysis-new-task').click()
    await app.page.getByTestId('analysis-tab-reports').click()
    await expect(app.page.getByTestId('report-no-answer')).toBeVisible()
    await expect(app.page.getByTestId('report-create')).toHaveCount(0)
    await app.electronApp.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] })
    }, filePath)
    await app.page.getByTestId('analysis-add-files').click()
    await expect(app.page.getByTestId('analysis-preview-table')).toContainText('销售额')
    await app.page.getByTestId('analysis-tab-analysis').click()
    await app.page.getByTestId('analysis-mode-manual').click()
    await app.page.getByTestId('analysis-measure').selectOption('B')
    await app.page.getByTestId('analysis-group').selectOption('A')
    await app.page.getByTestId('analysis-unit').fill('元')
    await app.page
      .getByTestId('analysis-question')
      .fill(
        `核对各区域销售额 <img src="http://127.0.0.1:${address.port}/report-leak"> <script>window.reportInjected=true</script>`
      )
    await app.page.getByTestId('analysis-calculate').click()
    await expect(app.page.getByTestId('analysis-answer-value-0')).toHaveText(/0\.3/)
    const task = await app.page.evaluate(async () => {
      const list = await window.deepchat.invoke('analysis.tasks.list', {})
      if (!list.ok) throw new Error(list.error)
      const task = await window.deepchat.invoke('analysis.tasks.get', { taskId: list.data[0].id })
      if (!task.ok) throw new Error(task.error)
      return task.data
    })
    const run = task.runs[0]
    const blocked = await app.page.evaluate(
      async ({ taskId, runId, candidateHash }) =>
        window.deepchat.invoke('analysis.reports.create', {
          taskId,
          requestId: crypto.randomUUID(),
          answer: { kind: 'run', id: runId, candidateHash },
          options: { format: 'a4', locale: 'zh-CN', title: 'Draft must not export' }
        }),
      { taskId: task.id, runId: run.id, candidateHash: run.answer.candidateHash }
    )
    expect(blocked).toEqual({ ok: false, error: 'REPORT_NOT_PUBLISHED' })
    await app.page.getByTestId('analysis-publish').click()
    await expect(app.page.getByTestId('analysis-published')).toBeVisible()
    await unlink(filePath)
    await app.page.getByTestId('analysis-export-report').click()
    await expect(app.page.getByTestId('analysis-reports')).toBeVisible()
    await app.page.getByTestId('report-title').fill('区域销售核对-合成报告')
    const reports = () =>
      app.page.evaluate(async (taskId) => {
        const result = await window.deepchat.invoke('analysis.reports.list', { taskId })
        if (!result.ok) throw new Error(result.error)
        return result.data
      }, task.id)
    const finish = async (id: string, status: ReportRecord['status'] = 'ready') => {
      await expect
        .poll(
          async () => {
            const report = (await reports()).find((report) => report.id === id)
            return report?.status
          },
          { timeout: 90000 }
        )
        .not.toBe('rendering')
      const report = (await reports()).find((report) => report.id === id)!
      expect(report.status, JSON.stringify(report.attempts.at(-1))).toBe(status)
      await expect(app.page.getByTestId(`report-${id}`)).toHaveAttribute(
        'data-report-status',
        status
      )
      return report
    }
    const create = async (count: number) => {
      await app.page.getByTestId('report-create').click()
      await expect.poll(async () => (await reports()).length).toBe(count)
      return (await reports())[0]
    }
    const save = async (record: ReportRecord, kind: 'pdf' | 'evidence', output: string) => {
      await app.electronApp.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath })
      }, output)
      await app.page
        .getByTestId(`${kind === 'pdf' ? 'report-save' : 'report-evidence'}-${record.id}`)
        .click()
      await expect(app.page.getByTestId('report-notice')).toContainText(output)
      return readFile(output)
    }
    let a4 = await finish((await create(1)).id)
    const a4Buffer = await save(a4, 'pdf', testInfo.outputPath('frozen-report-a4.pdf'))
    const parsed = await pdfParse(a4Buffer, { verbosityLevel: 0 })
    const normalized = parsed.text.replace(/\s/g, '')
    expect(parsed.numpages).toBeGreaterThan(1)
    expect(normalized).toContain('合成区域65-长中文标签')
    expect(normalized).toContain('E1.65')
    expect(normalized).toContain('0.3')
    expect(normalized).toContain('-2.05')
    expect(normalized).toContain(run.source.sha256)
    const evidence = await save(a4, 'evidence', testInfo.outputPath('frozen-report-evidence.json'))
    expect(createHash('sha256').update(evidence).digest('hex')).toBe(a4.snapshotHash)
    const frozen = JSON.parse(evidence.toString('utf8'))
    expect(frozen.runs[0].values).toHaveLength(65)
    expect(frozen.runs[0].values[0].inputs).toEqual([
      { row: 2, cell: 'B2', value: '0.1' },
      { row: 3, cell: 'B3', value: '0.2' }
    ])
    expect(frozen.runs[0].source.path).toBeUndefined()
    expect(externalRequests).toBe(0)
    await app.page.getByTestId('report-create').click()
    await expect(app.page.getByTestId('report-create')).toBeEnabled()
    expect(await reports()).toHaveLength(1)
    expect((await reports())[0].attempts).toHaveLength(1)
    await app.electronApp.evaluate(({ shell }) => {
      shell.openPath = async (filePath) => {
        ;(globalThis as unknown as { reportOpenedPath: string }).reportOpenedPath = filePath
        return ''
      }
    })
    await app.page.getByTestId(`report-open-${a4.id}`).click()
    const internalPdf = await app.electronApp.evaluate(
      () => (globalThis as unknown as { reportOpenedPath: string }).reportOpenedPath
    )
    expect(internalPdf).toContain('attempt-1.pdf')
    await writeFile(internalPdf, 'synthetic corruption')
    await app.page.getByTestId(`report-open-${a4.id}`).click()
    await expect(app.page.getByTestId('report-error')).toContainText('已被改动')
    await app.page.getByTestId(`report-retry-${a4.id}`).click()
    a4 = await finish(a4.id)
    expect(a4.attempts).toHaveLength(2)
    expect(a4.snapshotHash).toBe(frozen && createHash('sha256').update(evidence).digest('hex'))
    await save(a4, 'pdf', testInfo.outputPath('frozen-report-a4-repaired.pdf'))
    await app.page.getByTestId('report-format').selectOption('slides')
    await app.electronApp.evaluate(({ app }) => {
      app.once('browser-window-created', (_event, window) => {
        window.webContents.printToPDF = async () => {
          throw new Error('Synthetic first-print failure')
        }
      })
    })
    let slides = await finish((await create(2)).id, 'failed')
    expect(slides.attempts[0].error).toBe('REPORT_RENDER_FAILED')
    await app.page.getByTestId(`report-retry-${slides.id}`).click()
    slides = await finish(slides.id)
    expect(slides.attempts).toHaveLength(2)
    expect(slides.attempts[0].status).toBe('failed')
    const slidesPdf = await save(slides, 'pdf', testInfo.outputPath('frozen-report-16x9.pdf'))
    expect((await pdfParse(slidesPdf, { verbosityLevel: 0 })).text.replace(/\s/g, '')).toContain(
      'E1.65'
    )
    await app.page.getByTestId('report-title').fill('取消生成-合成验收')
    await app.electronApp.evaluate(({ app }) => {
      app.once('browser-window-created', (_event, window) => {
        window.webContents.printToPDF = async () => {
          ;(globalThis as unknown as { reportPrintHeld: boolean }).reportPrintHeld = true
          return new Promise<Buffer>((_resolve, reject) =>
            window.webContents.once('destroyed', () => reject(new Error('Synthetic print stopped')))
          )
        }
      })
    })
    let stopped = await create(3)
    await expect
      .poll(() =>
        app.electronApp.evaluate(() =>
          Boolean((globalThis as unknown as { reportPrintHeld?: boolean }).reportPrintHeld)
        )
      )
      .toBe(true)
    await app.page.getByTestId(`report-cancel-${stopped.id}`).click()
    stopped = await finish(stopped.id, 'cancelled')
    await expect(app.page.getByTestId(`report-open-${stopped.id}`)).toHaveCount(0)
    await app.page.getByTestId(`report-retry-${stopped.id}`).click()
    stopped = await finish(stopped.id)
    expect(stopped.attempts[0].status).toBe('cancelled')
    const other = await app.page.evaluate(async () =>
      window.deepchat.invoke('analysis.tasks.create', { title: '另一个合成任务' })
    )
    if (!other.ok) throw new Error(other.error)
    const foreign = await app.page.evaluate(
      async ({ taskId, reportId }) =>
        window.deepchat.invoke('analysis.reports.open', { taskId, reportId }),
      { taskId: other.data.id, reportId: a4.id }
    )
    expect(foreign).toEqual({ ok: false, error: 'NOT_FOUND' })
    await app.page.locator('.analysis-main').evaluate((element) => {
      element.scrollTop = 0
    })
    await app.page.screenshot({
      path: testInfo.outputPath('report-center-light.png'),
      fullPage: true
    })
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL().includes('/renderer/'))
        ?.setSize(1280, 800)
    })
    await app.page.evaluate(() => window.deepchat.invoke('config.setTheme', { theme: 'dark' }))
    expect(
      await app.page
        .getByTestId('analysis-workbench')
        .evaluate((element) => element.scrollWidth > element.clientWidth)
    ).toBe(false)
    await app.page.screenshot({
      path: testInfo.outputPath('report-center-dark-1280.png'),
      fullPage: true
    })
    await writeFile(filePath, originalBytes)
    expect(await app.close()).toBe('graceful')
    app = await launchApp()
    await waitForAppReady(app.page)
    await app.page.getByTestId('sidebar-analysis-button').click()
    await app.page.getByTestId('analysis-tab-reports').click()
    await expect(app.page.getByTestId(`report-open-${a4.id}`)).toBeVisible()
    const restored = await reports()
    expect(restored).toHaveLength(3)
    expect(restored.find((report) => report.id === a4.id)?.snapshotHash).toBe(a4.snapshotHash)
    expect(restored.find((report) => report.id === slides.id)?.attempts).toHaveLength(2)
    expect(externalRequests).toBe(0)
    expect(app.pageErrors).toEqual([])
    expect(await app.close()).toBe('graceful')
  } finally {
    await app.close().catch(() => {})
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
