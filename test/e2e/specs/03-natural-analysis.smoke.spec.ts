import { createServer } from 'node:http'
import { writeFile, readFile } from 'node:fs/promises'
import * as XLSX from 'xlsx'
import pdfParse from 'pdf-parse-new'
import type { ModelType } from '../../../src/shared/model'
import { test, expect } from '../fixtures/electronApp'
import { waitForAppReady } from '../helpers/wait'
import { createAnalysisWorkbook } from '../../fixtures/analysisWorkbook'
import type { AnalysisTask, NaturalReadyPlan, WorkbookCatalog } from '../../../src/shared/analysis'

// A synthetic HTTP provider exercises the real provider runtime/IPC/worker/UI chain.
// This is protocol and provenance verification, not a claim about live model reasoning quality.
test('Natural Excel questions -> actual provider HTTP -> local evidence -> follow-up, cancellation and persistence @smoke', async ({
  launchApp
}, testInfo) => {
  const prompts: string[] = []
  let slowStarted = false
  let slowAborted = false
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'fixture-chat', object: 'model', owned_by: 'synthetic' }]
        })
      )
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const prompt = body.messages
        .map((message: { content: string | Array<{ text?: string }> }) =>
          typeof message.content === 'string'
            ? message.content
            : message.content.map((part) => part.text ?? '').join('')
        )
        .join('\n')
      prompts.push(prompt)
      const question = JSON.parse(prompt.split('HUMAN_QUESTION\n')[1].split('\n')[0]) as string
      if (question.includes('等待取消')) {
        slowStarted = true
        response.once('close', () => {
          slowAborted = true
        })
        return
      }
      let answer: unknown
      if (prompt.includes('EXECUTED_EVIDENCE_DATA\n')) answer = { decision: 'confirm' }
      else if (question.includes('利润'))
        answer = {
          status: 'clarify',
          message: '当前表中有销售额与数量，请说明利润的来源字段或计算口径。'
        }
      else {
        const catalogs = JSON.parse(prompt.split('WORKBOOK_CATALOG_DATA\n')[1]) as WorkbookCatalog[]
        const query: NaturalReadyPlan['queries'][number] = {
          key: 'q1',
          sourceId: catalogs[0].sourceId,
          sheet: '销售明细',
          headerRow: 1,
          operation: 'sum',
          measure: question.includes('错误字段') ? 'ZZ' : 'C',
          groupBy: 'B',
          filters: question.includes('只看华东')
            ? [{ column: 'B', operator: 'eq', kind: 'text', value: '华东' }]
            : []
        }
        if (question.includes('期间比较')) {
          query.groupBy = ''
          query.filters = [{ column: 'A', operator: 'gte', kind: 'date', value: '2026-10-03' }]
          const baseline = {
            ...query,
            key: 'q2',
            filters: [{ column: 'A', operator: 'lt', kind: 'date', value: '2026-10-03' }]
          }
          answer = {
            status: 'ready',
            queries: [query, baseline],
            views: [{ kind: 'comparison', queryKey: 'q1', baselineQueryKey: 'q2', chart: 'bar' }]
          }
        } else
          answer = {
            status: 'ready',
            queries: [query],
            views: question.includes('只看华东')
              ? [{ kind: 'summary', queryKey: 'q1', chart: 'bar' }]
              : [
                  { kind: 'summary', queryKey: 'q1', chart: 'bar' },
                  {
                    kind: 'ranking',
                    queryKey: 'q1',
                    chart: 'bar',
                    limit: 1,
                    direction: 'descending'
                  },
                  { kind: 'share', queryKey: 'q1', chart: 'bar' }
                ]
          }
      }
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          id: 'synthetic-completion',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'fixture-chat',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: JSON.stringify(answer) },
              finish_reason: 'stop'
            }
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
        })
      )
    } catch (error) {
      response.statusCode = 500
      response.end(String(error))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Synthetic provider failed to start')
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
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
    const filePath = testInfo.outputPath('synthetic-natural-sales.xlsx')
    await writeFile(filePath, createAnalysisWorkbook())
    await app.electronApp.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] })
    }, filePath)
    await app.page.getByTestId('analysis-add-files').click()
    await expect(app.page.getByTestId('analysis-preview-table')).toContainText('销售额')
    await app.page.getByTestId('analysis-tab-analysis').click()
    await expect(app.page.getByTestId('natural-configure-model')).toBeVisible()
    await expect(app.page.getByTestId('natural-ask')).toBeDisabled()
    await app.page.evaluate(async (url) => {
      await window.deepchat.invoke('providers.add', {
        provider: {
          id: 'natural-http-fixture',
          name: '合成验收模型接口',
          apiType: 'openai-completions',
          apiKey: 'synthetic-not-a-real-key',
          baseUrl: url,
          enable: true,
          custom: true
        }
      })
      await window.deepchat.invoke('models.addCustom', {
        providerId: 'natural-http-fixture',
        model: {
          id: 'fixture-chat',
          name: 'Fixture Chat',
          type: 'chat' as ModelType,
          contextLength: 65536,
          maxTokens: 8192
        }
      })
      await window.deepchat.invoke('models.setStatus', {
        providerId: 'natural-http-fixture',
        modelId: 'fixture-chat',
        enabled: true
      })
    }, baseUrl)
    await app.page.getByTestId('natural-refresh-models').click()
    await expect(app.page.getByTestId('natural-model')).toContainText('Fixture Chat')
    const firstQuestion = '按区域汇总销售额，找出最高区域并计算占比'
    await app.page.getByTestId('natural-question').fill(firstQuestion)
    await app.page.getByTestId('natural-ask').click()
    await expect(app.page.getByTestId('natural-value-0-0')).toHaveText(/0\.3/)
    await expect(app.page.getByTestId('natural-value-0-1')).toHaveText(/8/)
    await expect(app.page.getByTestId('natural-view-1')).toContainText('华南')
    await expect(
      app.page.getByTestId('natural-view-1').getByTestId('natural-value-1-0')
    ).toHaveText(/8/)
    await expect(app.page.getByTestId('natural-share-2-0')).toContainText('3.614457831325')
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).not.toContain(filePath)
    await app.page.getByTestId('natural-value-0-0').click()
    await expect(app.page.getByTestId('evidence-inputs')).toContainText('C2')
    await expect(app.page.getByTestId('evidence-inputs')).toContainText('C3')
    await expect(app.page.getByTestId('evidence-value')).toContainText('0.3')
    await app.page.getByTestId('analysis-tab-analysis').click()
    await app.page.getByTestId('natural-share-2-0').click()
    await expect(app.page.getByTestId('natural-derived-value')).toContainText('3.614457831325')
    await expect(app.page.getByTestId('natural-derived-formula')).toContainText('0.3 / (0.3 + 8)')
    await app.page.screenshot({
      path: testInfo.outputPath('natural-derived-evidence.png'),
      fullPage: true
    })
    await app.page.getByTestId('natural-derived-input-0').click()
    await expect(app.page.getByTestId('evidence-inputs').locator('tbody tr')).toHaveCount(2)
    await app.page.getByTestId('analysis-tab-analysis').click()
    await app.page.getByTestId('natural-view-1').locator('svg g[role="button"]').first().click()
    await expect(app.page.getByTestId('evidence-value')).toContainText('8')
    await expect(app.page.getByTestId('evidence-inputs')).toContainText('C4')
    await app.page.getByTestId('analysis-tab-analysis').click()
    await app.page.getByTestId('natural-publish').click()
    await expect(app.page.getByTestId('natural-published')).toBeVisible()
    await app.page.locator('.analysis-main').evaluate((element) => {
      element.scrollTop = 0
    })
    // The expanded branch composer follows the answer instead of covering it.
    await app.page.getByTestId('analysis-frame-continue-h1').click()
    await expect(app.page.getByTestId('natural-question')).toBeInViewport()
    await app.page.screenshot({
      path: testInfo.outputPath('natural-answer-light.png'),
      fullPage: true
    })
    const getTask = () =>
      app.page.evaluate(async () => {
        const list = await window.deepchat.invoke('analysis.tasks.list', {})
        if (!list.ok) throw new Error(list.error)
        const result = await window.deepchat.invoke('analysis.tasks.get', {
          taskId: list.data[0].id
        })
        if (!result.ok) throw new Error(result.error)
        return result.data
      })
    const original: AnalysisTask = await getTask()
    expect(original.turns[0].answer.status).toBe('published')
    const callsBeforeExport = prompts.length
    await app.page.getByTestId('natural-export-report').click()
    await expect(app.page.getByTestId('report-answer')).toHaveValue(`turn:${original.turns[0].id}`)
    await app.page.getByTestId('report-title').fill('自然语言分析-合成报告')
    await app.page.getByTestId('report-create').click()
    const reportList = () =>
      app.page.evaluate(async (taskId) => {
        const result = await window.deepchat.invoke('analysis.reports.list', { taskId })
        if (!result.ok) throw new Error(result.error)
        return result.data
      }, original.id)
    await expect.poll(async () => (await reportList()).length).toBe(1)
    await expect
      .poll(async () => (await reportList())[0]?.status, { timeout: 90000 })
      .not.toBe('rendering')
    const report = (await reportList())[0]
    expect(report.status, JSON.stringify(report.attempts.at(-1))).toBe('ready')
    const outputPdf = testInfo.outputPath('natural-answer-report.pdf')
    await app.electronApp.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath })
    }, outputPdf)
    await app.page.getByTestId(`report-save-${report.id}`).click()
    await expect(app.page.getByTestId('report-notice')).toContainText(outputPdf)
    const reportText = (
      await pdfParse(await readFile(outputPdf), { verbosityLevel: 0 })
    ).text.replace(/\s/g, '')
    expect(reportText).toContain('3.614457831325')
    expect(reportText).toContain('E1.1')
    expect(reportText).toContain('D1')
    expect(prompts.length).toBe(callsBeforeExport)
    await app.page.getByTestId('analysis-tab-analysis').click()
    expect(await app.close()).toBe('graceful')
    app = await launchApp()
    await waitForAppReady(app.page)
    await app.page.getByTestId('sidebar-analysis-button').click()
    await expect(app.page.getByTestId('natural-published')).toBeVisible()
    await expect(app.page.getByTestId('natural-value-0-0')).toHaveText(/0\.3/)
    await app.page.getByTestId('natural-question').fill('只看华东呢？')
    await app.page.getByTestId('natural-ask').click()
    await expect(app.page.getByTestId('natural-view-0')).toContainText('华东')
    await expect(app.page.getByTestId('natural-value-0-1')).toHaveCount(0)
    await expect(app.page.getByTestId('natural-value-0-0')).toHaveText(/0\.3/)
    expect(prompts.at(-2)).toContain(firstQuestion)
    const book = XLSX.read(await readFile(filePath), { type: 'buffer' })
    book.Sheets['销售明细'].C2.v = 1.1
    await writeFile(filePath, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }))
    await app.page.getByTestId('natural-publish').click()
    await expect(app.page.getByTestId('natural-error')).toContainText('文件版本已变化')
    expect((await getTask()).turns[1].answer.status).toBe('draft')
    await app.page.getByTestId('analysis-tab-files').click()
    await app.page.getByRole('button', { name: '更新文件版本', exact: true }).click()
    await app.page.getByTestId('analysis-tab-analysis').click()
    await app.page.getByTestId('natural-question').fill('只看华东呢？')
    await app.page.getByTestId('natural-ask').click()
    await expect(app.page.getByTestId('natural-value-0-0')).toHaveText(/1\.3/)
    await app.page
      .getByTestId('natural-question')
      .fill('期间比较：对比2026年10月3日起与之前的销售额，给出差额和增幅')
    await app.page.getByTestId('natural-ask').click()
    await expect(app.page.getByTestId('natural-view-0')).toContainText('515.384615384615')
    await app.page
      .getByTestId('natural-view-0')
      .getByRole('button', { name: '6.7', exact: true })
      .click()
    await expect(app.page.getByTestId('natural-derived-value')).toHaveText('6.7')
    await app.page.getByTestId('natural-derived-input-1').click()
    await expect(app.page.getByTestId('evidence-value')).toHaveText('1.3')
    await expect(app.page.getByTestId('evidence-inputs')).toContainText('C2')
    await app.page.getByTestId('analysis-tab-analysis').click()
    await app.page.getByTestId('natural-publish').click()
    await expect(app.page.getByTestId('natural-published')).toBeVisible()
    const compared = await getTask()
    expect(compared.turns.at(-1)!.queryRuns).toHaveLength(2)
    for (const reference of compared.turns.at(-1)!.queryRuns)
      expect(compared.runs.find((run) => run.id === reference.runId)?.answer.status).toBe(
        'published'
      )
    await app.page.getByTestId('natural-question').fill('分析利润')
    await app.page.getByTestId('natural-ask').click()
    await expect(app.page.getByTestId('natural-clarification')).toContainText('利润的来源字段')
    await expect(app.page.getByTestId('natural-publish')).toHaveCount(0)
    const beforeFailure = await getTask()
    await app.page.getByTestId('natural-question').fill('错误字段测试')
    await app.page.getByTestId('natural-ask').click()
    await expect(app.page.getByTestId('natural-error')).toContainText('未通过校验')
    expect((await getTask()).turns.length).toBe(beforeFailure.turns.length)
    await expect(app.page.getByTestId('natural-question')).toHaveValue('错误字段测试')
    await app.page.getByTestId('natural-question').fill('等待取消')
    await app.page.getByTestId('natural-ask').click()
    await expect.poll(() => slowStarted).toBe(true)
    await app.page.getByTestId('natural-stop').click()
    await expect(app.page.getByTestId('natural-error')).toContainText('分析已停止')
    await expect.poll(() => slowAborted).toBe(true)
    const afterCancel = await getTask()
    expect(afterCancel.turns.length).toBe(beforeFailure.turns.length)
    expect(afterCancel.runs.length).toBe(beforeFailure.runs.length)
    expect(afterCancel.turns[0]).toEqual(original.turns[0])
    await app.page.getByTestId('natural-question').fill('按区域汇总销售额，找出最高区域并计算占比')
    await app.page.getByTestId('natural-ask').click()
    await expect(app.page.getByTestId('natural-value-0-0')).toHaveText(/1\.3/)
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL().includes('/renderer/'))
        ?.setSize(1280, 800)
    })
    await app.page.evaluate(() => window.deepchat.invoke('config.setTheme', { theme: 'dark' }))
    await app.page.locator('.analysis-main').evaluate((element) => {
      element.scrollTop = 0
    })
    await app.page.getByTestId('analysis-frame-continue-h1').click()
    await expect(app.page.getByTestId('natural-question')).toBeInViewport()
    expect(
      await app.page
        .getByTestId('analysis-workbench')
        .evaluate((element) => element.scrollWidth > element.clientWidth)
    ).toBe(false)
    await app.page.screenshot({
      path: testInfo.outputPath('natural-answer-dark-1280.png'),
      fullPage: true
    })
    expect(app.pageErrors).toEqual([])
    expect(await app.close()).toBe('graceful')
  } finally {
    await app.close().catch(() => {})
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
