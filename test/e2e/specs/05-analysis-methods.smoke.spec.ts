import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import * as XLSX from 'xlsx'
import pdfParse from 'pdf-parse-new'
import { test, expect } from '../fixtures/electronApp'
import { waitForAppReady } from '../helpers/wait'
import type {
  AnalysisPlan,
  AnalysisRun,
  NaturalReadyPlan,
  WorkbookCatalog
} from '../../../src/shared/analysis'
import type { StudyPlan } from '../../../src/shared/analysisStudy'
import type { ModelType } from '../../../src/shared/model'
import type { ReportRecord } from '../../../src/shared/analysisReport'

test('Nine methods -> fourteen real charts -> frozen PDF/evidence, natural planning and restart @smoke', async ({
  launchApp
}, testInfo) => {
  test.setTimeout(360000)
  const definitions: { study: StudyPlan; plan?: Partial<AnalysisPlan> }[] = [
    {
      study: { method: 'cycle-analysis', chart: 'line', interval: 'month' },
      plan: { groupBy: 'B' }
    },
    { study: { method: 'label-analysis', chart: 'bar' } },
    {
      study: {
        method: 'metric-decomposition',
        chart: 'waterfall',
        factors: ['H', 'I'],
        identity: 'sum',
        ruleBasis: '实际指标 = 两个因素之和',
        observationBy: 'A'
      },
      plan: { measure: 'J', groupBy: '' }
    },
    {
      study: {
        method: 'correlation-analysis',
        chart: 'scatter',
        secondMeasure: 'F',
        observationBy: 'A',
        correlation: 'spearman'
      }
    },
    {
      study: {
        method: 'matrix-analysis',
        chart: 'bubble',
        secondMeasure: 'F',
        sizeMeasure: 'G',
        observationBy: 'A'
      }
    },
    {
      study: {
        method: 'funnel-analysis',
        chart: 'funnel',
        stages: ['K', 'L', 'M'],
        observationBy: 'A',
        window: '同批七天',
        windowComplete: true,
        ruleBasis: '合成同批用户事件'
      },
      plan: { operation: 'count', measure: '', groupBy: '' }
    },
    { study: { method: 'structure-analysis', chart: 'stacked', seriesBy: 'D' } },
    { study: { method: 'structure-analysis', chart: 'percent_stacked', seriesBy: 'D' } },
    { study: { method: 'mece-decomposition', chart: 'pie' } },
    { study: { method: 'structure-analysis', chart: 'donut' } },
    { study: { method: 'stratification-analysis', chart: 'histogram', observationBy: 'A' } },
    { study: { method: 'stratification-analysis', chart: 'boxplot', observationBy: 'A' } },
    { study: { method: 'structure-analysis', chart: 'heatmap', seriesBy: 'D' } },
    {
      study: {
        method: 'metric-decomposition',
        chart: 'table',
        factors: ['H', 'I'],
        identity: 'sum',
        ruleBasis: '实际指标 = 两个因素之和'
      },
      plan: { measure: 'J', groupBy: '' }
    }
  ]
  const prompts: string[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const prompt = body.messages.map((message: { content: string }) => message.content).join('\n')
      prompts.push(prompt)
      let answer: unknown
      if (prompt.includes('EXECUTED_EVIDENCE_DATA\n')) answer = { decision: 'confirm' }
      else {
        const catalog = JSON.parse(prompt.split('WORKBOOK_CATALOG_DATA\n')[1]) as WorkbookCatalog[]
        const question = JSON.parse(prompt.split('HUMAN_QUESTION\n')[1].split('\n')[0]) as string
        const indexes = question.includes('第一组') ? [0, 6, 11, 4, 2] : [5, 3, 1, 8]
        const queries = indexes.map((index, i) => ({
          key: `q${i + 1}`,
          sourceId: catalog[0].sourceId,
          sheet: '明细',
          headerRow: 1,
          operation: 'sum',
          measure: 'E',
          groupBy: 'C',
          filters: [],
          ...definitions[index].plan,
          study: definitions[index].study
        })) as NaturalReadyPlan['queries']
        answer = {
          status: 'ready',
          queries,
          views: queries.map((query) => ({
            kind: 'method',
            queryKey: query.key,
            chart: query.study!.chart
          }))
        }
      }
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          id: 'synthetic-methods',
          object: 'chat.completion',
          created: 1,
          model: 'method-fixture',
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
  if (!address || typeof address === 'string') throw new Error('Fixture server failed')
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      [
        '对象',
        '日期',
        '区域',
        '系列',
        '金额',
        'Y指标',
        '规模',
        '因素一',
        '因素二',
        '实际指标',
        '访问',
        '注册',
        '支付',
        '时长一',
        '时长二'
      ],
      ['甲', '2026-01-01', '东', '线上', 0.1, 2, 10, 0.1, 0.2, 0.3, 1, 1, 1, 2, 3],
      ['乙', '2026-02-01', '东', '线下', 0.2, 4, 20, 2, 3, 5, 1, 1, 0, 4, 5],
      ['丙', '2026-04-01', '南', '线上', 10, 20, 0, -2, 3, 1, 1, 0, 0, 6, 7],
      ['丁', '2026-05-01', '南', '线下', null, 99, 5, 1, 1, 2, 0, 0, 0, 8, 9],
      ['戊', '2026-06-01', '南', '线下', 5, 10, 15, 1, 2, 3, 0, 0, 0, 4, 5]
    ]),
    '明细'
  )
  const workbookPath = testInfo.outputPath('synthetic-methods.xlsx')
  const workbookBytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer
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
    await expect(app.page.getByTestId('analysis-preview-table')).toContainText('因素一')
    await app.page.getByTestId('analysis-tab-analysis').click()
    await app.page.getByTestId('analysis-mode-manual').click()
    await app.page.getByTestId('analysis-measure').selectOption('E')
    await app.page.getByTestId('analysis-group').selectOption('C')
    await app.page.getByTestId('method-select').selectOption('stratification-analysis')
    await app.page.getByTestId('method-observation').selectOption('A')
    await app.page.getByTestId('method-plan-chart').selectOption('boxplot')
    await app.page
      .getByTestId('analysis-question')
      .fill('合成数据：查看完整分布和箱线，不把样本均值当作分布')
    await app.page
      .getByTestId('method-form')
      .evaluate((element) => element.scrollIntoView({ block: 'start' }))
    await app.page.screenshot({
      path: testInfo.outputPath('method-settings-light.png'),
      fullPage: true
    })
    await app.page.getByTestId('analysis-calculate').click()
    await expect(app.page.getByTestId('method-answer')).toContainText('分层分析')
    await expect(app.page.getByTestId('method-answer').locator('svg')).toHaveCount(1)
    await app.page.getByTestId('method-answer').locator('svg [data-value-id]').first().click()
    await expect(app.page.getByTestId('evidence-inputs')).toContainText('E2')
    await expect(app.page.getByTestId('analysis-evidence')).toContainText('计算公式')
    await app.page.getByTestId('analysis-tab-analysis').click()
    await app.page
      .getByTestId('method-answer')
      .locator('svg')
      .evaluate((element) => element.scrollIntoView({ block: 'center' }))
    await app.page.screenshot({
      path: testInfo.outputPath('method-distribution-light.png'),
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
    const initial = await getTask()
    const taskId = initial.id
    const calculated: AnalysisRun[] = []
    for (const definition of definitions) {
      const result = await app.page.evaluate(
        async ({ taskId, definition }) => {
          const task = await window.deepchat.invoke('analysis.tasks.get', { taskId })
          if (!task.ok) throw new Error(task.error)
          const computed = await window.deepchat.invoke('analysis.calculate', {
            taskId,
            plan: {
              sourceId: task.data.sources[0].id,
              sheet: '明细',
              headerRow: 1,
              operation: 'sum',
              measure: 'E',
              groupBy: 'C',
              filters: [],
              unit: '元',
              period: '合成2026',
              question: `合成图表 ${definition.study.chart}`,
              ...definition.plan,
              study: definition.study
            }
          })
          if (!computed.ok) throw new Error(computed.error)
          const run = computed.data.runs.at(-1)!
          const published = await window.deepchat.invoke('analysis.answers.publish', {
            taskId,
            runId: run.id,
            candidateHash: run.answer.candidateHash
          })
          if (!published.ok) throw new Error(published.error)
          return published.data.runs.at(-1)!
        },
        { taskId, definition }
      )
      calculated.push(result)
    }
    await app.page.evaluate(async (baseUrl) => {
      await window.deepchat.invoke('providers.add', {
        provider: {
          id: 'methods-http-fixture',
          name: '合成方法验收模型',
          apiType: 'openai-completions',
          apiKey: 'synthetic-not-a-real-key',
          baseUrl,
          enable: true,
          custom: true
        }
      })
      await window.deepchat.invoke('models.addCustom', {
        providerId: 'methods-http-fixture',
        model: {
          id: 'method-fixture',
          name: 'Method fixture',
          type: 'chat' as ModelType,
          contextLength: 131072,
          maxTokens: 16384
        }
      })
      await window.deepchat.invoke('models.setStatus', {
        providerId: 'methods-http-fixture',
        modelId: 'method-fixture',
        enabled: true
      })
    }, `http://127.0.0.1:${address.port}/v1`)
    await app.page.getByTestId('analysis-mode-natural').click()
    await app.page.getByTestId('natural-refresh-models').click()
    for (const group of ['第一组', '第二组']) {
      await app.page
        .getByTestId('natural-question')
        .fill(`合成方法验收${group}：按已有定义计算，保留数据依据和限制`)
      await app.page.getByTestId('natural-ask').click()
      await expect
        .poll(async () => (await getTask()).turns.length, { timeout: 60000 })
        .toBe(group === '第一组' ? 1 : 2)
      await expect(
        app.page.getByTestId('natural-answer').last().getByTestId('method-answer')
      ).toHaveCount(group === '第一组' ? 5 : 4)
      await app.page.getByTestId('natural-publish').last().click()
      await expect(app.page.getByTestId('natural-published').last()).toBeVisible()
    }
    expect(prompts).toHaveLength(4)
    expect(prompts.some((p) => p.includes('ruleVersion'))).toBe(true)
    const publishedTask = await getTask()
    expect(
      new Set(publishedTask.turns.flatMap((t) => t.plan!.queries.map((q) => q.study!.method))).size
    ).toBe(9)
    await app.page.locator('.analysis-main').evaluate((element) => {
      element.scrollTop = 0
    })
    await app.page.screenshot({
      path: testInfo.outputPath('method-natural-light.png'),
      fullPage: true
    })
    await app.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes('/renderer/'))
        ?.setSize(1280, 900)
    )
    await app.page.evaluate(() => window.deepchat.invoke('config.setTheme', { theme: 'dark' }))
    await app.page.getByTestId('natural-history').selectOption(publishedTask.turns[0].id)
    await app.page
      .getByTestId('method-answer')
      .nth(3)
      .locator('svg')
      .first()
      .evaluate((element) => element.scrollIntoView({ block: 'center' }))
    await app.page.screenshot({
      path: testInfo.outputPath('method-natural-dark-1280.png'),
      fullPage: true
    })
    expect(
      await app.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    await app.page
      .getByTestId('method-answer')
      .nth(2)
      .locator('svg')
      .first()
      .evaluate((element) => element.scrollIntoView({ block: 'center' }))
    await app.page.screenshot({
      path: testInfo.outputPath('method-boxplot-dark-1280.png'),
      fullPage: true
    })
    await app.page
      .getByTestId('method-answer')
      .nth(1)
      .getByTestId('method-chart')
      .selectOption('heatmap')
    await app.page
      .getByTestId('method-answer')
      .nth(1)
      .locator('svg')
      .first()
      .evaluate((element) => element.scrollIntoView({ block: 'center' }))
    await app.page.screenshot({
      path: testInfo.outputPath('method-heatmap-dark-1280.png'),
      fullPage: true
    })
    // All following exports use saved published evidence, after the actual source has been removed.
    await unlink(workbookPath)
    const reports: ReportRecord[] = []
    const answers = [
      ...calculated.map((run) => ({
        kind: 'run' as const,
        id: run.id,
        candidateHash: run.answer.candidateHash,
        name: run.chart.kind
      })),
      ...publishedTask.turns.map((turn, i) => ({
        kind: 'turn' as const,
        id: turn.id,
        candidateHash: turn.answer.candidateHash,
        name: `natural-${i + 1}`
      }))
    ]
    for (let index = 0; index < answers.length; index++) {
      const { name, ...answer } = answers[index]
      const report = await app.page.evaluate(
        async (input) => {
          const result = await window.deepchat.invoke('analysis.reports.create', input)
          if (!result.ok) throw new Error(result.error)
          return result.data
        },
        {
          taskId,
          requestId: randomUUID(),
          answer,
          options: {
            format: index % 2 ? ('slides' as const) : ('a4' as const),
            locale: 'zh-CN' as const,
            title: `合成验收-${name}`
          }
        }
      )
      const getReport = () =>
        app.page.evaluate(
          async ({ taskId, id }) => {
            const result = await window.deepchat.invoke('analysis.reports.list', { taskId })
            if (!result.ok) throw new Error(result.error)
            return result.data.find((r) => r.id === id)!
          },
          { taskId, id: report.id }
        )
      await expect
        .poll(async () => (await getReport()).status, { timeout: 90000 })
        .not.toBe('rendering')
      const ready = await getReport()
      expect(ready.status, `${name}: ${JSON.stringify(ready.attempts)}`).toBe('ready')
      reports.push(ready)
      const filePath = testInfo.outputPath(`method-${name}.pdf`)
      await app.electronApp.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath })
      }, filePath)
      const saved = await app.page.evaluate(
        (input) => window.deepchat.invoke('analysis.reports.save', input),
        { taskId, reportId: ready.id, kind: 'pdf' as const }
      )
      expect(saved.ok).toBe(true)
      const parsed = await pdfParse(await readFile(filePath), { verbosityLevel: 0 })
      expect(parsed.text.replace(/\s/g, '')).toContain('方法自检')
      expect(parsed.text).toContain(initial.sources[0].sha256)
      if (name === 'boxplot') {
        const jsonPath = testInfo.outputPath('method-boxplot-evidence.json')
        await app.electronApp.evaluate(({ dialog }, filePath) => {
          dialog.showSaveDialog = async () => ({ canceled: false, filePath })
        }, jsonPath)
        await app.page.evaluate((input) => window.deepchat.invoke('analysis.reports.save', input), {
          taskId,
          reportId: ready.id,
          kind: 'evidence' as const
        })
        const snapshot = JSON.parse(await readFile(jsonPath, 'utf8'))
        expect(snapshot.runs[0].study.method).toBe('stratification-analysis')
        expect(
          snapshot.runs[0].values.some((v: { inputs: { cell: string; value: string }[] }) =>
            v.inputs.some((c) => c.cell === 'E2' && c.value === '0.1')
          )
        ).toBe(true)
      }
    }
    expect(reports).toHaveLength(16)
    expect(prompts).toHaveLength(4)
    await writeFile(workbookPath, workbookBytes)
    await app.close()
    app = await launchApp()
    await waitForAppReady(app.page)
    await app.page.getByTestId('sidebar-analysis-button').click()
    const restored = await app.page.evaluate(
      (taskId) => window.deepchat.invoke('analysis.tasks.get', { taskId }),
      taskId
    )
    expect(restored.ok && restored.data.turns.length).toBe(2)
    const restoredReports = await app.page.evaluate(
      (taskId) => window.deepchat.invoke('analysis.reports.list', { taskId }),
      taskId
    )
    expect(
      restoredReports.ok && restoredReports.data.filter((r) => r.status === 'ready').length
    ).toBe(16)
    expect(app.pageErrors).toEqual([])
  } finally {
    await app.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
