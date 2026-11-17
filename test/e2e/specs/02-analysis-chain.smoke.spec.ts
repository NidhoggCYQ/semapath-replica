import { writeFile, readFile } from 'node:fs/promises'
import * as XLSX from 'xlsx'
import { test, expect } from '../fixtures/electronApp'
import { waitForAppReady } from '../helpers/wait'
import { createAnalysisWorkbook } from '../../fixtures/analysisWorkbook'
import type { AnalysisTask } from '../../../src/shared/analysis'

test('Excel task -> calculation -> evidence -> chart -> published answer persists and rejects stale sources @smoke', async ({
  launchApp
}, testInfo) => {
  const filePath = testInfo.outputPath('synthetic-sales.xlsx')
  await writeFile(filePath, createAnalysisWorkbook())
  let app = await launchApp()
  await waitForAppReady(app.page)
  await app.page.getByTestId('sidebar-analysis-button').click()
  await expect(app.page.getByTestId('analysis-workbench')).toBeVisible()
  await app.electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((item) =>
      item.webContents.getURL().includes('/renderer/')
    )
    window?.setSize(1440, 1000)
  })
  await app.page.evaluate(() => window.deepchat.invoke('config.setTheme', { theme: 'light' }))
  await app.page.getByTestId('analysis-new-task').click()
  await app.electronApp.evaluate(({ dialog }, selectedPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] })
  }, filePath)
  await app.page.getByTestId('analysis-add-files').click()
  await expect(app.page.getByTestId('analysis-preview-table')).toContainText('华东')
  await app.page.getByTestId('analysis-sheet').selectOption('分页检查')
  await expect(app.page.getByTestId('analysis-preview-table').locator('tbody tr')).toHaveCount(50)
  await app.page.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(app.page.getByTestId('analysis-preview-table').locator('tbody tr')).toHaveCount(15)
  await expect(
    app.page.getByTestId('analysis-preview-table').locator('tbody tr').first()
  ).toContainText('52')
  await app.page.getByTestId('analysis-sheet').selectOption('销售明细')
  await app.page.getByTestId('analysis-tab-analysis').click()
  await app.page.getByTestId('analysis-mode-manual').click()
  if (await app.page.getByTestId('analysis-measure').isHidden())
    await app.page.getByTestId('analysis-edit-calculation').click()
  await app.page.getByTestId('analysis-measure').selectOption('C')
  await app.page.getByTestId('analysis-group').selectOption('B')
  await app.page.getByTestId('analysis-question').fill('核对各区域销售额（合成验收数据）')
  await app.page.getByTestId('analysis-unit').fill('元')
  await app.page.getByTestId('analysis-period').fill('2026-10')
  if (await app.page.getByTestId('analysis-calculate').isHidden())
    await app.page.getByTestId('analysis-edit-calculation').click()
  await app.page.getByTestId('analysis-calculate').click()
  await expect(app.page.getByTestId('analysis-answer-value-0')).toHaveText(/0\.3\s*元/)
  await expect(app.page.getByTestId('analysis-answer-value-1')).toHaveText(/8\s*元/)
  await app.page.getByTestId('analysis-answer-value-0').click()
  await expect(app.page.getByTestId('evidence-value')).toContainText('0.3')
  await expect(app.page.getByTestId('evidence-inputs').locator('tbody tr')).toHaveCount(2)
  await expect(app.page.getByTestId('evidence-inputs')).toContainText('C2')
  await expect(app.page.getByTestId('evidence-inputs')).toContainText('C3')
  await app.page.screenshot({ path: testInfo.outputPath('analysis-evidence.png'), fullPage: true })
  await app.page.getByTestId('analysis-tab-analysis').click()
  await app.page.getByTestId('analysis-mode-manual').click()
  await app.page
    .locator('.result-chart')
    .getByRole('button', { name: '数据表', exact: true })
    .click()
  await expect(app.page.locator('.result-chart table')).toContainText('0.3')
  await app.page
    .locator('.result-chart')
    .getByRole('button', { name: '折线图', exact: true })
    .click()
  await expect(app.page.locator('.result-chart polyline')).toBeVisible()
  await app.page.getByTestId('analysis-publish').click()
  await expect(app.page.getByTestId('analysis-published')).toBeVisible()
  await expect(app.page.getByTestId('analysis-unit')).toHaveValue('元')
  await app.page.screenshot({ path: testInfo.outputPath('analysis-published.png'), fullPage: true })
  await app.electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((item) =>
      item.webContents.getURL().includes('/renderer/')
    )
    window?.setSize(1280, 800)
  })
  await app.page.evaluate(() => window.deepchat.invoke('config.setTheme', { theme: 'dark' }))
  await app.page.locator('.result-chart').scrollIntoViewIfNeeded()
  await expect(app.page.locator('.result-chart polyline')).toBeVisible()
  const horizontalOverflow = await app.page
    .getByTestId('analysis-workbench')
    .evaluate((element) => element.scrollWidth > element.clientWidth)
  expect(horizontalOverflow).toBe(false)
  await app.page.screenshot({
    path: testInfo.outputPath('analysis-chart-dark-1280.png'),
    fullPage: true
  })
  await app.page.evaluate(() => window.deepchat.invoke('config.setTheme', { theme: 'light' }))
  const taskId = await app.page.evaluate(async () => {
    const result = await window.deepchat.invoke('analysis.tasks.list', {})
    if (!result.ok) throw new Error(result.error)
    return result.data[0].id
  })
  expect(await app.close()).toBe('graceful')
  app = await launchApp()
  await waitForAppReady(app.page)
  await app.page.getByTestId('sidebar-analysis-button').click()
  await app.page.getByTestId('analysis-mode-manual').click()
  await expect(app.page.getByTestId('analysis-published')).toBeVisible()
  await expect(app.page.getByTestId('analysis-answer-value-0')).toHaveText(/0\.3\s*元/)
  if (await app.page.getByTestId('analysis-measure').isHidden())
    await app.page.getByTestId('analysis-edit-calculation').click()
  await app.page.getByTestId('analysis-measure').selectOption('C')
  await app.page.getByTestId('analysis-group').selectOption('B')
  if (await app.page.getByTestId('analysis-calculate').isHidden())
    await app.page.getByTestId('analysis-edit-calculation').click()
  await app.page.getByTestId('analysis-calculate').click()
  await expect(app.page.getByTestId('analysis-publish')).toBeVisible()
  const original: AnalysisTask = await app.page.evaluate(async (id) => {
    const result = await window.deepchat.invoke('analysis.tasks.get', { taskId: id })
    if (!result.ok) throw new Error(result.error)
    return result.data
  }, taskId)
  const book = XLSX.read(await readFile(filePath), { type: 'buffer' })
  book.Sheets['销售明细'].C2.v = 1.1
  await writeFile(filePath, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }))
  await app.page.getByTestId('analysis-publish').click()
  await expect(app.page.getByTestId('analysis-error')).toContainText('文件版本已变化')
  const protectedTask = await app.page.evaluate(async (id) => {
    const result = await window.deepchat.invoke('analysis.tasks.get', { taskId: id })
    if (!result.ok) throw new Error(result.error)
    return result.data
  }, taskId)
  expect(protectedTask.runs[1].answer.status).toBe('draft')
  expect(protectedTask.runs[0].answer.status).toBe('published')
  expect(protectedTask.runs[0].source.sha256).toBe(original.runs[0].source.sha256)
  await app.page.getByRole('button', { name: '更新文件版本', exact: true }).click()
  await expect(app.page.getByTestId('analysis-publish')).toBeDisabled()
  if (await app.page.getByTestId('analysis-calculate').isHidden())
    await app.page.getByTestId('analysis-edit-calculation').click()
  await app.page.getByTestId('analysis-calculate').click()
  await expect(app.page.getByTestId('analysis-answer-value-0')).toHaveText(/1\.3\s*元/)
  await app.page.evaluate(() => window.deepchat.invoke('config.setTheme', { theme: 'light' }))
  await app.page.getByTestId('analysis-new-task').click()
  const crossTask = await app.page.evaluate(
    async ({ oldSourceId }) => {
      const tasks = await window.deepchat.invoke('analysis.tasks.list', {})
      if (!tasks.ok) throw new Error(tasks.error)
      return window.deepchat.invoke('analysis.sources.preview', {
        taskId: tasks.data[0].id,
        sourceId: oldSourceId,
        sheet: '销售明细',
        headerRow: 1,
        page: 1
      })
    },
    { oldSourceId: original.sources[0].id }
  )
  expect(crossTask).toEqual({ ok: false, error: 'NOT_FOUND' })
  expect(await app.close()).toBe('graceful')
})
