import { createServer } from 'node:http'
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from '../fixtures/electronApp'
import { waitForAppReady } from '../helpers/wait'
import { sendMessage } from '../helpers/chat'
import { createAnalysisWorkbook } from '../../fixtures/analysisWorkbook'
import type { AnalysisTask } from '../../../src/shared/analysis'
import type { ModelType } from '../../../src/shared/model'

// Synthetic model decisions cross the actual streaming provider, Tool Surface, Agent dispatch,
// task database, workbook worker, candidate review and Chromium PDF boundary.
test('Unified task conversation -> Agent tools -> exact evidence -> reviewed publication -> frozen reports and restart @smoke', async ({
  launchApp
}, testInfo) => {
  let step = 0,
    requestNumber = 0
  let sourceId = '',
    runId = '',
    turnId = '',
    candidateHash = '',
    reviewReceiptId = ''
  let file = ''
  const seen: string[] = []
  const diagnostics: Array<{
    step: number
    available: string[]
    lastRole?: string
    lastContent?: string
    toolChars?: number
    messageChars?: number
    error?: string
  }> = []
  const decode = (value: unknown): any => {
    if (typeof value === 'string') {
      try {
        return decode(JSON.parse(value))
      } catch {
        return value
      }
    }
    if (Array.isArray(value)) return value.map(decode)
    if (value && typeof value === 'object') {
      const item = value as Record<string, unknown>
      if (typeof item.content === 'string') return decode(item.content)
      if (item.type === 'text' && typeof item.text === 'string') return decode(item.text)
      if (item.data && typeof item.data === 'object') return decode(item.data)
    }
    return value
  }
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
      const names = (body.tools ?? [])
        .map((t: { function?: { name: string } }) => t.function?.name)
        .filter(Boolean) as string[]
      const last = body.messages?.at(-1)
      diagnostics.push({
        step,
        available: names,
        lastRole: last?.role,
        toolChars: JSON.stringify(body.tools ?? []).length,
        messageChars: JSON.stringify(body.messages ?? []).length,
        ...(last?.role === 'tool'
          ? { lastContent: JSON.stringify(last.content).slice(0, 2000) }
          : {})
      })
      if (last?.role === 'tool') {
        let result = decode(last.content)
        if (Array.isArray(result) && result.length === 1) result = result[0]
        if (typeof result === 'string')
          throw Error('Undecoded tool output: ' + result.slice(0, 1000))
        if (result?.error) throw Error('Tool error: ' + JSON.stringify(result))
        if (result?.ok === false) throw Error('Analysis tool failed: ' + JSON.stringify(result))
        if (result?.ready === false)
          throw Error('Report was not generated: ' + JSON.stringify(result))
        if (result?.sources) sourceId = result.sources[0]?.id ?? sourceId
        if (result?.runId) runId = result.runId
        if (result?.turnId) turnId = result.turnId
        if (result?.candidateHash) candidateHash = result.candidateHash
        if (result?.reviewReceipt) {
          candidateHash = result.reviewReceipt.hash
          reviewReceiptId = result.reviewReceipt.id
        }
      }
      const actions = [
        { name: 'datasource_context', args: () => ({}) },
        { name: 'datasource_schema', args: () => ({ sourceId }) },
        {
          name: 'datasource_query',
          args: () => ({
            kind: 'file',
            plan: {
              sourceId,
              sheet: '销售明细',
              headerRow: 1,
              operation: 'sum',
              measure: 'C',
              groupBy: 'B',
              filters: [],
              question: '按区域汇总销售额',
              unit: '元',
              period: '2026年10月'
            }
          })
        },
        { name: 'analysis_evidence', args: () => ({ runId }) },
        {
          name: 'answer_submit',
          args: () => ({
            question: '按区域汇总销售额，并保留原始依据',
            runs: [{ key: 'q1', runId }],
            views: [{ kind: 'summary', queryKey: 'q1', chart: 'bar' }],
            frame: {
              objective: '核对区域销售额',
              questions: [{ key: 'h1', kind: 'question', text: '各区域销售额', queryKeys: ['q1'] }]
            }
          })
        },
        { name: 'analysis_get', args: () => ({ turnId }) },
        { name: 'answer_confirm', args: () => ({ turnId, candidateHash, reviewReceiptId }) },
        {
          name: 'report_export',
          args: () => ({
            turnId,
            options: { title: '合成任务工具链报告', format: 'a4', locale: 'zh-CN' }
          })
        },
        {
          name: 'report_export',
          args: () => ({
            turnId,
            options: { title: '合成任务工具链报告', format: 'slides', locale: 'zh-CN' }
          })
        }
      ]
      let name: string | undefined, args: unknown
      // Non-tool requests can be title generation or compaction and must not advance the tool loop.
      const isToolRequest = names.length > 0
      if (isToolRequest && step < actions.length) {
        const action = actions[step]
        if (names.includes(action.name)) {
          if (step === 8 && file) {
            await unlink(file)
            file = ''
          }
          name = action.name
          args = action.args()
          seen.push(name)
          step++
        } else if (names.includes('tool_search')) {
          name = 'tool_search'
          args = { query: action.name, limit: 2 }
        } else throw Error('Required analysis tool is not discoverable: ' + action.name)
      }
      const callId = `synthetic-workspace-${++requestNumber}`
      const content = isToolRequest
        ? '已按真实数据完成汇总：华东 0.3 元，华南 8 元；已核对依据并发布，报告可在当前任务成果中查看。'
        : '合成区域分析任务'
      if (body.stream) {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        })
        const chunk = (delta: unknown, finish_reason: string | null) => ({
          id: callId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'fixture-chat',
          choices: [{ index: 0, delta, finish_reason }]
        })
        response.write(
          'data: ' +
            JSON.stringify(
              chunk(
                name
                  ? {
                      role: 'assistant',
                      tool_calls: [
                        {
                          index: 0,
                          id: callId,
                          type: 'function',
                          function: { name, arguments: JSON.stringify(args) }
                        }
                      ]
                    }
                  : { role: 'assistant', content },
                null
              )
            ) +
            '\n\n'
        )
        response.write('data: ' + JSON.stringify(chunk({}, name ? 'tool_calls' : 'stop')) + '\n\n')
        response.end('data: [DONE]\n\n')
      } else {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            id: callId,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'fixture-chat',
            choices: [
              {
                index: 0,
                message: name
                  ? {
                      role: 'assistant',
                      content: null,
                      tool_calls: [
                        {
                          id: callId,
                          type: 'function',
                          function: { name, arguments: JSON.stringify(args) }
                        }
                      ]
                    }
                  : { role: 'assistant', content },
                finish_reason: name ? 'tool_calls' : 'stop'
              }
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
          })
        )
      }
    } catch (error) {
      diagnostics.push({ step, available: [], error: String(error) })
      response.statusCode = 500
      response.end(String(error))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Synthetic provider did not start')
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  let app = await launchApp()
  const captureRoot = process.env.SEMAPATH_WORKSPACE_CAPTURE_DIR
  const capture = async (label: string) => {
    if (!captureRoot) return
    await mkdir(captureRoot, { recursive: true })
    for (const [width, height, theme] of [
      [1440, 1000, 'light'],
      [1280, 1000, 'dark'],
      [900, 640, 'light']
    ] as const) {
      await app.electronApp.evaluate(
        ({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows()
            .find((w) => w.webContents.getURL().includes('/renderer/'))
            ?.setSize(size[0], size[1])
        },
        [width, height]
      )
      await app.page.evaluate(
        (theme) => window.deepchat.invoke('config.setTheme', { theme }),
        theme
      )
      await app.page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      )
      const overflow = await app.page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1
      )
      expect(overflow).toBe(false)
      if (await app.page.getByTestId('chat-page-shell').isVisible()) {
        const editor = await app.page.getByTestId('chat-input-box').boundingBox()
        expect(editor).toBeTruthy()
        expect(editor!.x + editor!.width).toBeLessThanOrEqual(width + 1)
        const visible = await app.electronApp.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().filter((window) => window.isVisible()).length
        )
        expect(visible).toBe(0)
      }
      await app.page.screenshot({
        path: path.join(captureRoot, `${label}-${theme}-${width}.png`),
        fullPage: true,
        animations: 'disabled'
      })
    }
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes('/renderer/'))
        ?.setSize(1440, 1000)
    })
    await app.page.evaluate(() => window.deepchat.invoke('config.setTheme', { theme: 'light' }))
  }
  try {
    await waitForAppReady(app.page)
    await app.page.getByTestId('sidebar-analysis-button').click()
    await app.page.getByTestId('analysis-new-task').click()
    await app.page.getByTestId('analysis-tab-conversation').click()
    await expect(app.page.getByTestId('task-conversation')).toContainText('模型')
    await capture('conversation-unconfigured')
    await app.page.getByTestId('analysis-tab-analysis').click()
    await app.page.getByTestId('workspace-pin').click()
    await expect(app.page.getByTestId('workspace-pin')).toHaveAttribute('aria-pressed', 'true')
    const chosen = await app.page.evaluate(async (url) => {
      await window.deepchat.invoke('providers.add', {
        provider: {
          id: 'workspace-http-fixture',
          name: '合成任务工具模型',
          apiType: 'openai-completions',
          apiKey: 'synthetic-workspace-key',
          baseUrl: url,
          enable: true,
          custom: true
        }
      })
      await window.deepchat.invoke('models.addCustom', {
        providerId: 'workspace-http-fixture',
        model: {
          id: 'fixture-chat',
          name: 'Workspace Fixture',
          type: 'chat' as ModelType,
          contextLength: 131072,
          maxTokens: 8192
        }
      })
      await window.deepchat.invoke('models.setStatus', {
        providerId: 'workspace-http-fixture',
        modelId: 'fixture-chat',
        enabled: true
      })
      const { config } = await window.deepchat.invoke('models.getConfig', {
        providerId: 'workspace-http-fixture',
        modelId: 'fixture-chat'
      })
      await window.deepchat.invoke('models.setConfig', {
        providerId: 'workspace-http-fixture',
        modelId: 'fixture-chat',
        config: { ...config, contextLength: 131072, maxTokens: 8192 }
      })
      await window.deepchat.invoke('config.updateEntries', {
        changes: [
          {
            key: 'defaultModel',
            value: { providerId: 'workspace-http-fixture', modelId: 'fixture-chat' }
          }
        ]
      })
      const entries = await window.deepchat.invoke('analysis.workspace.list', {})
      if (!entries.ok || !entries.data[0].taskId) throw Error('Analysis task missing')
      const taskId = entries.data[0].taskId
      const updated = await window.deepchat.invoke('analysis.tasks.rename', {
        taskId,
        title: '合成统一任务 · 区域销售'
      })
      if (!updated.ok) throw Error(updated.error)
      return taskId
    }, baseUrl)
    const workbookPath = testInfo.outputPath('synthetic-workspace-sales.xlsx')
    file = workbookPath
    await writeFile(workbookPath, createAnalysisWorkbook())
    await app.electronApp.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] })
    }, workbookPath)
    if (!(await app.page.getByTestId('analysis-add-files').isVisible()))
      await app.page.getByTestId('analysis-manage-data').click()
    await app.page.getByTestId('analysis-add-files').click()
    await expect(app.page.getByTestId('analysis-preview-table')).toContainText('销售额')
    await app.electronApp.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] })
    }, testInfo.outputDir)
    await app.page.getByTestId('workspace-directory').click()
    await app.page.getByTestId('analysis-tab-conversation').click()
    await expect(app.page.getByTestId('chat-input-editor')).toBeVisible()
    const generation = await app.page.evaluate(async (taskId) => {
      const workspace = await window.deepchat.invoke('analysis.workspace.list', {})
      const sessionId = workspace.ok
        ? workspace.data.find((entry) => entry.taskId === taskId)?.sessionId
        : null
      if (!sessionId) throw Error('Conversation association missing')
      return window.deepchat.invoke('sessions.getGenerationSettings', { sessionId })
    }, chosen)
    await writeFile(testInfo.outputPath('workspace-generation.json'), JSON.stringify(generation))
    expect(generation.settings?.contextLength).toBe(131072)
    await capture('conversation-ready')
    await sendMessage(
      app.page,
      '合成验收：请按区域汇总本任务 Excel 的销售额，核对依据、发布回答，并生成 A4 和演示报告。'
    )
    const deadline = Date.now() + 120000
    while (step < 9 && Date.now() < deadline) {
      const failure = diagnostics.find((item) => item.error)
      if (failure) throw Error(failure.error)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(step).toBe(9)
    await expect(app.page.getByTestId('chat-page-shell')).toHaveAttribute(
      'data-generating',
      'false',
      { timeout: 120000 }
    )
    expect(seen).toEqual([
      'datasource_context',
      'datasource_schema',
      'datasource_query',
      'analysis_evidence',
      'answer_submit',
      'analysis_get',
      'answer_confirm',
      'report_export',
      'report_export'
    ])
    const renamedTitle = '合成统一任务 · 区域销售验收'
    await app.page.getByTestId('chat-topbar-title-trigger').click()
    await app.page.getByTestId('chat-topbar-title-input').fill(renamedTitle)
    await app.page.getByTestId('chat-topbar-title-save').click()
    await expect(app.page.getByTestId('workspace-task-' + chosen)).toContainText(renamedTitle)
    const state = await app.page.evaluate(async (taskId) => {
      const data = await window.deepchat.invoke('analysis.tasks.get', { taskId })
      const entries = await window.deepchat.invoke('analysis.workspace.list', {})
      const reports = await window.deepchat.invoke('analysis.reports.list', { taskId })
      if (!data.ok || !entries.ok || !reports.ok) throw Error('Workspace state missing')
      return { task: data.data, entries: entries.data, reports: reports.data }
    }, chosen)
    expect(state.task.runs).toHaveLength(1)
    expect(state.task.runs[0].values.map((v) => v.value)).toEqual(['0.3', '8'])
    expect(state.task.turns[0].answer.status).toBe('published')
    expect(state.reports).toHaveLength(2)
    expect(state.reports.every((r) => r.status === 'ready')).toBe(true)
    const linked = state.entries.find((e) => e.taskId === chosen)!
    expect(state.task.title).toBe(renamedTitle)
    expect(linked.title).toBe(renamedTitle)
    expect(linked.sessionId).toBeTruthy()
    expect(linked.isPinned).toBe(true)
    expect(linked.projectDir).toBe(testInfo.outputDir)
    await app.page.getByTestId('analysis-tab-analysis').click()
    await expect(app.page.getByTestId('natural-value-0-0')).toContainText('0.3')
    await app.page.getByTestId('workspace-tool-history').locator('summary').click()
    await expect(app.page.getByTestId('workspace-tool-history')).toContainText('确认并发布回答')
    await capture('analysis-tool-history')
    await app.page.getByTestId('natural-value-0-0').click()
    await expect(app.page.getByTestId('evidence-inputs')).toContainText('C2')
    await expect(app.page.getByTestId('evidence-inputs')).toContainText('C3')
    await app.page.getByTestId('workspace-search').fill('不存在的合成任务')
    await expect(app.page.locator('.task-list')).toContainText('没有匹配')
    await capture('workspace-no-results')
    await app.page.getByTestId('workspace-search').fill('区域销售')
    await expect(app.page.getByTestId('workspace-task-' + chosen)).toBeVisible()
    await app.page.getByTestId('workspace-search').fill('')
    await app.page.getByTestId('analysis-tab-reports').click()
    for (const report of state.reports) {
      const pdfPath = testInfo.outputPath(`${report.options.format}.pdf`)
      await app.electronApp.evaluate(({ dialog }, selectedPath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: selectedPath })
      }, pdfPath)
      const saved = await app.page.evaluate(
        ({ taskId, reportId }) =>
          window.deepchat.invoke('analysis.reports.save', { taskId, reportId, kind: 'pdf' }),
        { taskId: chosen, reportId: report.id }
      )
      expect(saved.ok).toBe(true)
      expect((await readFile(pdfPath)).subarray(0, 5).toString()).toBe('%PDF-')
      const jsonPath = testInfo.outputPath(`${report.options.format}.json`)
      await app.electronApp.evaluate(({ dialog }, selectedPath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: selectedPath })
      }, jsonPath)
      const evidence = await app.page.evaluate(
        ({ taskId, reportId }) =>
          window.deepchat.invoke('analysis.reports.save', { taskId, reportId, kind: 'evidence' }),
        { taskId: chosen, reportId: report.id }
      )
      expect(evidence.ok).toBe(true)
      const frozen = await readFile(jsonPath, 'utf8')
      expect(frozen).toContain('0.3')
      expect(frozen).not.toContain('synthetic-workspace-key')
      expect(frozen).not.toContain(workbookPath)
    }
    expect(app.pageErrors).toEqual([])
    await app.close()
    app = await launchApp()
    await waitForAppReady(app.page)
    await app.page.getByTestId('sidebar-analysis-button').click()
    await expect(app.page.getByTestId('workspace-task-' + chosen)).toBeVisible()
    await app.page.getByTestId('workspace-task-' + chosen).click()
    await expect(app.page.getByTestId('natural-value-0-0')).toContainText('0.3')
    await app.page.getByTestId('analysis-tab-conversation').click()
    await expect(app.page.getByTestId('chat-page')).toContainText('合成验收')
    const restored = await app.page.evaluate(
      (taskId) =>
        window.deepchat
          .invoke('analysis.workspace.list', {})
          .then((r) => (r.ok ? r.data.find((e) => e.taskId === taskId) : null)),
      chosen
    )
    expect(restored?.sessionId).toBe(linked.sessionId)
  } finally {
    await writeFile(
      testInfo.outputPath('workspace-provider-diagnostics.json'),
      JSON.stringify({ seen, step, diagnostics }, null, 2)
    )
    await app.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
