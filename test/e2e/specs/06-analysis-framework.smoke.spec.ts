import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import pdfParse from 'pdf-parse-new'
import { test, expect } from '../fixtures/electronApp'
import { waitForAppReady } from '../helpers/wait'
import { createAnalysisWorkbook } from '../../fixtures/analysisWorkbook'
import type { NaturalReadyPlan, WorkbookCatalog } from '../../../src/shared/analysis'
import type { ModelType } from '../../../src/shared/model'
import { REPORT_RENDERER_VERSION } from '../../../src/shared/analysisReport'

test('Business frame -> bounded recursive branches -> frozen framework PDF/JSON and restart @smoke', async ({
  launchApp
}, testInfo) => {
  test.setTimeout(300000)
  const prompts: string[] = []
  const focusChecks: unknown[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const prompt = body.messages.map((message: { content: string }) => message.content).join('\n')
      prompts.push(prompt)
      let answer: unknown
      if (prompt.includes('EXECUTED_EVIDENCE_DATA\n')) {
        const evidence = JSON.parse(prompt.split('EXECUTED_EVIDENCE_DATA\n')[1])
        answer = {
          decision: 'confirm',
          decisions: [
            {
              questionKey: 'h1',
              judgment: 'supported',
              next: 'stop',
              reason: '当前读数来自本分支实际计算，结论只适用于所示范围。',
              evidence: [{ queryKey: 'q1', valueId: evidence[0].values[0].id }]
            }
          ]
        }
      } else {
        const catalog = JSON.parse(prompt.split('WORKBOOK_CATALOG_DATA\n')[1]) as WorkbookCatalog[]
        const question = JSON.parse(prompt.split('HUMAN_QUESTION\n')[1].split('\n')[0]) as string
        const count = question.includes('统计记录')
        const quantity = question.includes('数量')
        const south = question.includes('SOUTH_SIBLING_SENTINEL')
        const query: NaturalReadyPlan['queries'][number] = {
          key: 'q1',
          sourceId: catalog[0].sourceId,
          sheet: '销售明细',
          headerRow: 1,
          operation: count ? 'count' : 'sum',
          measure: count ? '' : quantity ? 'D' : 'C',
          groupBy: question.includes('根问题') ? 'B' : '',
          filters: south ? [{ column: 'B', operator: 'eq', kind: 'text', value: '华南' }] : []
        }
        answer = {
          status: 'ready',
          queries: [query],
          views: [{ kind: 'summary', queryKey: 'q1', chart: 'bar' }],
          frame: {
            objective: '核对当前销售范围并保留未验证的经营解释',
            workflowRefs: ['data-quality', 'claim-validation'],
            questions: [
              { key: 'h1', kind: 'question', text: '当前范围的经营读数是什么', queryKeys: ['q1'] },
              {
                key: 'h2',
                kind: 'hypothesis',
                text: '营销投入是否解释差异，尚缺投入与对照资料',
                queryKeys: []
              }
            ]
          }
        }
      }
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          id: 'synthetic-frame',
          object: 'chat.completion',
          created: 1,
          model: 'frame-fixture',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: JSON.stringify(answer) },
              finish_reason: 'stop'
            }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      )
    } catch (error) {
      response.statusCode = 500
      response.end(String(error))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server unavailable')
  const workbookPath = testInfo.outputPath('synthetic-framework.xlsx')
  const workbookBytes = createAnalysisWorkbook()
  await writeFile(workbookPath, workbookBytes)
  let app = await launchApp()
  try {
    await waitForAppReady(app.page)
    await app.page.getByTestId('sidebar-analysis-button').click()
    await app.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes('/renderer/'))
        ?.setSize(1440, 1000)
    )
    await app.page.evaluate(() => window.deepchat.invoke('config.setTheme', { theme: 'light' }))
    await app.page.getByTestId('analysis-new-task').click()
    await app.electronApp.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] })
    }, workbookPath)
    await app.page.getByTestId('analysis-add-files').click()
    await expect(app.page.getByTestId('analysis-preview-table')).toContainText('销售额')
    await app.page.evaluate(
      async (baseUrl) => {
        await window.deepchat.invoke('providers.add', {
          provider: {
            id: 'frame-fixture-provider',
            name: '合成框架验收模型',
            apiType: 'openai-completions',
            apiKey: 'synthetic-not-real',
            baseUrl,
            enable: true,
            custom: true
          }
        })
        await window.deepchat.invoke('models.addCustom', {
          providerId: 'frame-fixture-provider',
          model: {
            id: 'frame-fixture',
            name: 'Frame fixture',
            type: 'chat' as ModelType,
            contextLength: 32768,
            maxTokens: 8192
          }
        })
        await window.deepchat.invoke('models.setStatus', {
          providerId: 'frame-fixture-provider',
          modelId: 'frame-fixture',
          enabled: true
        })
      },
      'http://127.0.0.1:' + address.port + '/v1'
    )
    await app.page.getByTestId('analysis-tab-analysis').click()
    await app.page.getByTestId('natural-refresh-models').click()
    const getTask = () =>
      app.page.evaluate(async () => {
        const list = await window.deepchat.invoke('analysis.tasks.list', {})
        if (!list.ok) throw new Error(list.error)
        const value = await window.deepchat.invoke('analysis.tasks.get', {
          taskId: list.data[0].id
        })
        if (!value.ok) throw new Error(value.error)
        return value.data
      })
    async function ask(question: string, length: number) {
      await app.page.getByTestId('natural-question').fill(question)
      await app.page.getByTestId('natural-ask').click()
      await expect.poll(async () => (await getTask()).turns.length, { timeout: 60000 }).toBe(length)
      await expect(app.page.getByTestId('natural-answer')).toBeVisible()
      return (await getTask()).turns.at(-1)!
    }
    async function verifyFocus(id: string, color: string) {
      const target = app.page.getByTestId(id)
      await target.focus()
      await app.page.keyboard.press('Tab')
      await app.page.keyboard.press('Shift+Tab')
      await expect(target).toBeFocused()
      const actual = await target.evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          style: style.outlineStyle,
          width: style.outlineWidth,
          color: style.outlineColor,
          visible: element.matches(':focus-visible'),
          devicePixelRatio: window.devicePixelRatio
        }
      })
      expect(actual).toMatchObject({ style: 'solid', color, visible: true })
      // Chromium snaps outline widths to device pixels (2 CSS px -> 1.6 at 125% scaling).
      const width = Number.parseFloat(actual.width)
      expect(width * actual.devicePixelRatio).toBeGreaterThanOrEqual(
        Math.floor(2 * actual.devicePixelRatio) - 0.01
      )
      expect(width).toBeLessThanOrEqual(2.01)
      focusChecks.push({ id, ...actual })
    }
    const root = await ask('合成根问题：按区域汇总销售额', 1)
    expect(root.framework?.questions[0].judgment).toBe('supported')
    expect(root.framework?.questions[1].judgment).toBe('unverified')
    await expect(app.page.getByTestId('analysis-frame-question-h2')).toContainText('需要数据')
    await expect(app.page.getByTestId('analysis-frame-question-h2')).not.toContainText('已完成计算')
    await verifyFocus('analysis-drilldown-q1', 'rgb(35, 100, 202)')
    await verifyFocus('analysis-frame-continue-h1', 'rgb(35, 100, 202)')
    await app.page
      .getByTestId('analysis-frame')
      .evaluate((element) => element.scrollIntoView({ block: 'start' }))
    await app.page.screenshot({
      path: testInfo.outputPath('framework-root-light.png'),
      fullPage: true
    })
    const task = await getTask()
    const rootRun = task.runs.find((run) => run.id === root.queryRuns[0].runId)!
    const east = rootRun.values.find((value) => value.category === '华东')!
    await app.page.getByTestId('analysis-drilldown-q1').click()
    await app.page.getByTestId('analysis-scope-search').fill('华东')
    await app.page.getByTestId('analysis-scope-value').selectOption(east.id)
    await expect(app.page.getByTestId('analysis-scope-notice')).toContainText('2 条输入记录')
    await verifyFocus('analysis-scope-query', 'rgb(35, 100, 202)')
    await app.page.screenshot({
      path: testInfo.outputPath('framework-scope-light.png'),
      fullPage: true
    })
    const child = await ask('合成：在所选输入记录内统计记录', 2)
    const childTask = await getTask()
    const childRun = childTask.runs.find((run) => run.id === child.queryRuns[0].runId)!
    expect(childRun.values[0].value).toBe('2')
    expect(childRun.plan.rowScope?.rows).toEqual([2, 3])
    expect(child.context?.parentTurnId).toBe(root.id)
    await app.page.getByTestId('analysis-frame-continue-h1').click()
    const grandchild = await ask('合成：继续本分支看数量', 3)
    const grandTask = await getTask()
    expect(
      grandTask.runs.find((run) => run.id === grandchild.queryRuns[0].runId)?.values[0].value
    ).toBe('3')
    expect(grandchild.context?.depth).toBe(2)
    await app.page.getByTestId('analysis-map-node-' + root.id).click()
    await app.page.getByTestId('analysis-scope-query').selectOption('q1')
    const sibling = await ask('SOUTH_SIBLING_SENTINEL：只看华南销售', 4)
    const siblingTask = await getTask()
    expect(
      siblingTask.runs.find((run) => run.id === sibling.queryRuns[0].runId)?.values[0].value
    ).toBe('8')
    await app.page.getByTestId('analysis-map-node-' + child.id).click()
    const recovered = await ask('合成：继续原有华东输入范围的销售', 5)
    const recoveredTask = await getTask()
    expect(
      recoveredTask.runs.find((run) => run.id === recovered.queryRuns[0].runId)?.values[0].value
    ).toBe('0.3')
    expect(recovered.context?.parentTurnId).toBe(child.id)
    expect(prompts.slice(-2).every((prompt) => !prompt.includes('SOUTH_SIBLING_SENTINEL'))).toBe(
      true
    )
    await app.page.getByTestId('natural-publish').click()
    await expect(app.page.getByTestId('natural-published')).toBeVisible()
    await app.page.getByTestId('analysis-new-root').click()
    const fresh = await ask('合成：全表数量', 6)
    const finalTask = await getTask()
    expect(fresh.context).toBeUndefined()
    expect(finalTask.runs.find((run) => run.id === fresh.queryRuns[0].runId)?.values[0].value).toBe(
      '21'
    )
    expect(prompts.slice(-2).every((prompt) => !prompt.includes('SOUTH_SIBLING_SENTINEL'))).toBe(
      true
    )
    await app.page.getByTestId('analysis-map-node-' + recovered.id).click()
    await app.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes('/renderer/'))
        ?.setSize(1280, 900)
    )
    await app.page.evaluate(() => window.deepchat.invoke('config.setTheme', { theme: 'dark' }))
    await verifyFocus('analysis-map-node-' + recovered.id, 'rgb(133, 180, 255)')
    await app.page.locator('.analysis-main').evaluate((element) => {
      element.scrollTop = 0
    })
    await app.page.screenshot({
      path: testInfo.outputPath('framework-map-dark-1280.png'),
      fullPage: true
    })
    await app.page
      .getByTestId('analysis-frame')
      .evaluate((element) => element.scrollIntoView({ block: 'start' }))
    await verifyFocus('analysis-frame-continue-h1', 'rgb(133, 180, 255)')
    await app.page.screenshot({
      path: testInfo.outputPath('framework-current-dark-1280.png'),
      fullPage: true
    })
    expect(
      await app.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    await app.page.getByTestId('analysis-frame').getByRole('button').first().click()
    await expect(app.page.getByTestId('evidence-inputs')).toContainText('C2')
    await expect(app.page.getByTestId('evidence-row-scope')).toContainText('2 条输入记录')
    await app.page.getByTestId('analysis-tab-analysis').click()
    await app.page.getByTestId('natural-export-report').click()
    await expect(app.page.getByTestId('analysis-reports')).toBeVisible()
    await unlink(workbookPath)
    const taskId = finalTask.id
    const reportIds: string[] = []
    for (const format of ['a4', 'slides'] as const) {
      const report = await app.page.evaluate(
        async (input) => {
          const value = await window.deepchat.invoke('analysis.reports.create', input)
          if (!value.ok) throw new Error(value.error)
          return value.data
        },
        {
          taskId,
          requestId: randomUUID(),
          answer: {
            kind: 'turn' as const,
            id: recovered.id,
            candidateHash: recovered.answer.candidateHash
          },
          options: { format, locale: 'zh-CN' as const, title: '合成业务分析与递归下钻' }
        }
      )
      const readReport = () =>
        app.page.evaluate(
          async ({ taskId, reportId }) => {
            const list = await window.deepchat.invoke('analysis.reports.list', { taskId })
            if (!list.ok) throw new Error(list.error)
            return list.data.find((item) => item.id === reportId)!
          },
          { taskId, reportId: report.id }
        )
      await expect
        .poll(async () => (await readReport()).status, { timeout: 90000 })
        .not.toBe('rendering')
      const ready = await readReport()
      expect(ready.status, JSON.stringify(ready.attempts)).toBe('ready')
      expect(ready.rendererVersion).toBe(REPORT_RENDERER_VERSION)
      reportIds.push(ready.id)
      for (const kind of ['pdf', 'evidence'] as const) {
        const target = testInfo.outputPath(
          'framework-' + format + (kind === 'pdf' ? '.pdf' : '.json')
        )
        await app.electronApp.evaluate(({ dialog }, filePath) => {
          dialog.showSaveDialog = async () => ({ canceled: false, filePath })
        }, target)
        const saved = await app.page.evaluate(
          (input) => window.deepchat.invoke('analysis.reports.save', input),
          { taskId, reportId: ready.id, kind }
        )
        expect(saved.ok).toBe(true)
        if (kind === 'pdf') {
          const parsed = await pdfParse(await readFile(target), { verbosityLevel: 0 })
          const words = parsed.text.replace(/\s/g, '')
          expect(words).toContain('业务分析框架')
          expect(words).toContain('分析路径')
          expect(words).toContain('仅所选数值的实际输入记录')
          expect(parsed.text).toContain(task.sources[0].sha256)
          expect(parsed.text).toContain('0.3')
        } else {
          const snapshot = JSON.parse(await readFile(target, 'utf8'))
          expect(snapshot.lineage.map((parent: { id: string }) => parent.id)).toEqual([
            root.id,
            child.id
          ])
          expect(snapshot.runs[0].plan.rowScope.rows).toEqual([2, 3])
          expect(snapshot.framework.questions[1].judgment).toBe('unverified')
        }
      }
    }
    expect(prompts).toHaveLength(12)
    await writeFile(
      testInfo.outputPath('framework-focus-checks.json'),
      JSON.stringify(focusChecks, null, 2)
    )
    await writeFile(
      testInfo.outputPath('framework-final-task.json'),
      JSON.stringify(finalTask, null, 2)
    )
    await writeFile(workbookPath, workbookBytes)
    await app.close()
    app = await launchApp()
    await waitForAppReady(app.page)
    await app.page.getByTestId('sidebar-analysis-button').click()
    const restored = await app.page.evaluate(
      async (taskId) => window.deepchat.invoke('analysis.tasks.get', { taskId }),
      taskId
    )
    expect(restored.ok && restored.data.turns.length).toBe(6)
    expect(restored.ok && restored.data.turns[4].context?.parentTurnId).toBe(child.id)
    const reports = await app.page.evaluate(
      async (taskId) => window.deepchat.invoke('analysis.reports.list', { taskId }),
      taskId
    )
    expect(
      reports.ok &&
        reports.data.filter((report) => reportIds.includes(report.id) && report.status === 'ready')
          .length
    ).toBe(2)
    expect(app.pageErrors).toEqual([])
  } finally {
    await app.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
