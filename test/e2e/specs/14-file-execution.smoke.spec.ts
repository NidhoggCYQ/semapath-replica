import { createServer } from 'node:http'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from '../fixtures/electronApp'
import { waitForAppReady } from '../helpers/wait'
import { sendMessage } from '../helpers/chat'
import { createAnalysisWorkbook } from '../../fixtures/analysisWorkbook'
import type { ModelType } from '../../../src/shared/model'
test.setTimeout(240000)

test('Registered Excel -> actual shell code -> complete tables -> evidence -> publication -> PDF and restart @smoke', async ({
  launchApp
}, info) => {
  let step = 0,
    serial = 0
  let inputId = '',
    outputId = '',
    runId = '',
    turnId = '',
    hash = '',
    receipt = '',
    executionId = ''
  let file = ''
  const errors: string[] = [],
    seen: string[] = []
  const toolResults: unknown[] = []
  const script = info.outputPath('synthetic-file-calculation.cjs')
  const xlsx = path.resolve('node_modules/xlsx')
  await writeFile(
    script,
    `const fs = require('node:fs'); const XLSX = require(${JSON.stringify(xlsx)});
const input = JSON.parse(fs.readFileSync(process.env.PBI_INPUTS_PATH, 'utf8')).inputs[0];
const book = XLSX.readFile(input.path); const rows = XLSX.utils.sheet_to_json(book.Sheets[input.sheet], {header:1, raw:true});
const totals = new Map();
for (const row of rows.slice(1)) { if (row[2] == null) continue; const [whole, fraction=''] = String(row[2]).split('.'); const negative = whole.startsWith('-'); const cents = BigInt(whole.replace('-', '')) * 100n + BigInt(fraction.padEnd(2,'0')); const doubled = (negative ? -cents : cents) * 2n; totals.set(row[1], (totals.get(row[1]) ?? 0n) + doubled); }
const amount = n => (n < 0n ? '-' : '') + String((n < 0n ? -n : n)/100n) + '.' + String((n < 0n ? -n : n)%100n).padStart(2,'0');
const output = {complete:true,tables:[{title:'合成代码：翻倍销售额',columns:['区域','翻倍销售额'],columnTypes:['text','number'],rows:[...totals].map(([region,value])=>[region,amount(value)])},{title:'合成输入行数',columns:['行数'],columnTypes:['number'],rows:[[String(rows.length-1)]]}]};
fs.writeFileSync(process.env.PBI_RESULT_PATH, JSON.stringify(output), 'utf8'); console.log('Synthetic code read the registered Excel and wrote two complete tables.');
`
  )
  const decode = (value: any): any => {
    if (typeof value === 'string') {
      try {
        return decode(JSON.parse(value))
      } catch {
        return value
      }
    }
    if (Array.isArray(value)) return value.length === 1 ? decode(value[0]) : value.map(decode)
    if (value && typeof value === 'object') {
      if (typeof value.content === 'string') return decode(value.content)
      if (value.type === 'text') return decode(value.text)
      if (value.data && typeof value.data === 'object') return decode(value.data)
    }
    return value
  }
  const actions = [
    { name: 'datasource_context', args: () => ({}) },
    {
      name: 'exec',
      args: () => ({
        command: `node '${script.replaceAll("'", "''")}'`,
        description: '合成验收：读取实际 Excel 并计算翻倍销售额',
        fileInputs: [{ sourceId: inputId, sheet: '销售明细', range: 'A1:D7' }],
        fileOutput: 'table'
      })
    },
    { name: 'analysis_get', args: () => ({ executionId, tableIndex: 0, offset: 0, limit: 1 }) },
    {
      name: 'datasource_query',
      args: () => ({
        kind: 'file',
        plan: {
          sourceId: outputId,
          sheet: '数据',
          headerRow: 1,
          operation: 'sum',
          measure: 'B',
          groupBy: 'A',
          filters: [],
          question: '合成代码结果汇总',
          unit: '元',
          period: ''
        }
      })
    },
    { name: 'analysis_evidence', args: () => ({ runId, limit: 20 }) },
    {
      name: 'answer_submit',
      args: () => ({
        question: '合成代码翻倍销售额',
        runs: [{ key: 'q1', runId }],
        views: [{ kind: 'summary', queryKey: 'q1', chart: 'bar' }]
      })
    },
    { name: 'analysis_get', args: () => ({ turnId }) },
    {
      name: 'answer_confirm',
      args: () => ({ turnId, candidateHash: hash, reviewReceiptId: receipt })
    },
    {
      name: 'report_export',
      args: () => ({
        turnId,
        options: { format: 'a4', locale: 'zh-CN', title: '合成代码执行依据' }
      })
    },
    {
      name: 'report_export',
      args: () => ({
        turnId,
        options: { format: 'slides', locale: 'en-US', title: 'Synthetic recorded code output' }
      })
    }
  ]
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({ object: 'list', data: [{ id: 'file-fixture', object: 'model' }] })
      )
      return
    }
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const names = (body.tools ?? []).map((t: any) => t.function?.name)
      const last = body.messages?.at(-1)
      if (last?.role === 'tool') {
        const value = decode(last.content)
        toolResults.push(value)
        if (value?.error || value?.ok === false || value?.tableDelivery?.state === 'failed')
          throw Error(JSON.stringify(value))
        if (value?.sources && !inputId) inputId = value.sources[0].id
        if (value?.tableDelivery) {
          outputId = value.tableDelivery.sources[0].id
          executionId = value.tableDelivery.executionId
          expect(value.tableDelivery.sources).toHaveLength(2)
        }
        if (value?.metadata?.id === executionId) {
          expect(value.table.rows).toEqual([['华东', '0.60']])
          expect(value.hasMore).toBe(true)
        }
        if (value?.runId) runId = value.runId
        if (value?.turnId) turnId = value.turnId
        if (value?.candidateHash) hash = value.candidateHash
        if (value?.reviewReceipt) {
          receipt = value.reviewReceipt.id
          hash = value.reviewReceipt.hash
        }
      }
      let name: string | undefined, args: unknown
      if (names.length && step < actions.length) {
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
        } else throw Error('Missing tool: ' + action.name)
      }
      const id = 'file-fixture-' + ++serial
      const content = '合成代码结果已核对并发布：华东 0.6 元，华南 16 元。'
      const message = name
        ? {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
            ]
          }
        : { role: 'assistant', content }
      if (body.stream) {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache'
        })
        const chunk = (delta: unknown, finish_reason: string | null) => ({
          id,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'file-fixture',
          choices: [{ index: 0, delta, finish_reason }]
        })
        response.write(
          'data: ' +
            JSON.stringify(
              chunk(
                name
                  ? { role: 'assistant', tool_calls: [{ index: 0, ...message.tool_calls![0] }] }
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
            id,
            object: 'chat.completion',
            model: 'file-fixture',
            choices: [{ index: 0, message, finish_reason: name ? 'tool_calls' : 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
          })
        )
      }
    } catch (error) {
      errors.push(String(error))
      response.statusCode = 500
      response.end(String(error))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('No synthetic provider')
  let app = await launchApp()
  try {
    await waitForAppReady(app.page)
    await app.page.getByTestId('sidebar-analysis-button').click()
    await app.page.getByTestId('analysis-new-task').click()
    const taskId = await app.page.evaluate(async (url) => {
      await window.deepchat.invoke('providers.add', {
        provider: {
          id: 'file-http-fixture',
          name: '合成文件执行模型',
          apiType: 'openai-completions',
          apiKey: 'synthetic-key',
          baseUrl: url,
          enable: true,
          custom: true
        }
      })
      await window.deepchat.invoke('models.addCustom', {
        providerId: 'file-http-fixture',
        model: {
          id: 'file-fixture',
          name: 'File Fixture',
          type: 'chat' as ModelType,
          contextLength: 131072,
          maxTokens: 8192
        }
      })
      await window.deepchat.invoke('models.setStatus', {
        providerId: 'file-http-fixture',
        modelId: 'file-fixture',
        enabled: true
      })
      const { config } = await window.deepchat.invoke('models.getConfig', {
        providerId: 'file-http-fixture',
        modelId: 'file-fixture'
      })
      await window.deepchat.invoke('models.setConfig', {
        providerId: 'file-http-fixture',
        modelId: 'file-fixture',
        config: { ...config, contextLength: 131072, maxTokens: 8192 }
      })
      await window.deepchat.invoke('config.updateEntries', {
        changes: [
          {
            key: 'defaultModel',
            value: { providerId: 'file-http-fixture', modelId: 'file-fixture' }
          }
        ]
      })
      const entries = await window.deepchat.invoke('analysis.workspace.list', {})
      if (!entries.ok || !entries.data[0].taskId) throw Error('No task')
      return entries.data[0].taskId
    }, `http://127.0.0.1:${address.port}/v1`)
    file = info.outputPath('synthetic-input.xlsx')
    await writeFile(file, createAnalysisWorkbook())
    await app.electronApp.evaluate(({ dialog }, input) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input] })
    }, file)
    if (!(await app.page.getByTestId('analysis-add-files').isVisible()))
      await app.page.getByTestId('analysis-manage-data').click()
    await app.page.getByTestId('analysis-add-files').click()
    await expect(app.page.getByTestId('analysis-preview-table')).toContainText('销售额')
    await app.electronApp.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
    }, info.outputDir)
    await app.page.getByTestId('workspace-directory').click()
    await app.page.getByTestId('analysis-tab-conversation').click()
    await expect(app.page.getByTestId('chat-input-editor')).toBeVisible()
    // Only the isolated synthetic test task is configured. User sessions are never changed.
    await app.page.evaluate(async (taskId) => {
      const entries = await window.deepchat.invoke('analysis.workspace.list', {})
      const sessionId = entries.ok
        ? entries.data.find((entry) => entry.taskId === taskId)?.sessionId
        : null
      if (!sessionId) throw Error('No linked session')
      await window.deepchat.invoke('sessions.setPermissionMode', { sessionId, mode: 'full_access' })
    }, taskId)
    await sendMessage(
      app.page,
      '合成验收：读取本任务 Excel，用代码计算翻倍销售额，核对依据并发布，再导出两种 PDF。'
    )
    await expect
      .poll(
        () => {
          if (errors.length) throw Error(errors.join('\n'))
          return step
        },
        { timeout: 150000 }
      )
      .toBe(actions.length)
    await expect(app.page.getByTestId('chat-page-shell')).toHaveAttribute(
      'data-generating',
      'false',
      { timeout: 120000 }
    )
    expect(seen).toEqual(actions.map((a) => a.name))
    const saved = await app.page.evaluate(async (taskId) => {
      const task = await window.deepchat.invoke('analysis.tasks.get', { taskId })
      const reports = await window.deepchat.invoke('analysis.reports.list', { taskId })
      if (!task.ok || !reports.ok) throw Error('Missing saved state')
      return { task: task.data, reports: reports.data }
    }, taskId)
    expect(saved.task.sources).toHaveLength(3)
    expect(saved.task.runs[0].values.map((v) => v.value)).toEqual(['0.6', '16'])
    expect(saved.task.turns[0].answer.status).toBe('published')
    expect(saved.task.sources[1].origin?.fileExecution).toMatchObject({
      id: executionId,
      verification: 'recorded_result',
      replay: 'not_captured',
      skillStatus: 'not_loaded'
    })
    expect(saved.reports).toHaveLength(2)
    expect(saved.reports.every((r) => r.status === 'ready')).toBe(true)
    await app.page.getByTestId('analysis-tab-analysis').click()
    await app.page.getByTestId('natural-value-0-0').click()
    const executionOrigin = app.page
      .getByTestId('analysis-evidence')
      .getByTestId('file-execution-origin')
    await expect(executionOrigin).toContainText('已记录的程序输出')
    for (const summary of await executionOrigin.locator('summary').all()) await summary.click()
    for (const [width, height, theme] of [
      [1440, 1000, 'light'],
      [1280, 1000, 'dark'],
      [900, 640, 'light']
    ] as const) {
      await app.electronApp.evaluate(
        ({ BrowserWindow }, size) => {
          for (const window of BrowserWindow.getAllWindows())
            if (window.webContents.getURL().includes('/renderer/')) window.setSize(size[0], size[1])
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
      expect(
        await app.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)
      ).toBe(false)
      expect(
        await app.electronApp.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length
        )
      ).toBe(0)
      await app.page.screenshot({
        path: info.outputPath(`execution-${theme}-${width}.png`),
        fullPage: true,
        animations: 'disabled'
      })
    }
    for (const report of saved.reports)
      for (const kind of ['pdf', 'evidence'] as const) {
        const target = info.outputPath(
          `${report.options.format}.${kind === 'pdf' ? 'pdf' : 'json'}`
        )
        await app.electronApp.evaluate(({ dialog }, target) => {
          dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
        }, target)
        const result = await app.page.evaluate(
          ({ taskId, reportId, kind }) =>
            window.deepchat.invoke('analysis.reports.save', { taskId, reportId, kind }),
          { taskId, reportId: report.id, kind }
        )
        expect(result.ok).toBe(true)
        if (kind === 'evidence') {
          const snapshot = JSON.parse(await readFile(target, 'utf8'))
          expect(snapshot.runs[0].source.origin.fileExecution.id).toBe(executionId)
          expect(JSON.stringify(snapshot)).not.toContain(
            JSON.stringify(saved.task.sources[0].path).slice(1, -1)
          )
        } else expect((await readFile(target)).subarray(0, 5).toString()).toBe('%PDF-')
      }
    await app.close()
    app = await launchApp()
    await waitForAppReady(app.page)
    const restored = await app.page.evaluate(
      async (taskId) => window.deepchat.invoke('analysis.tasks.get', { taskId }),
      taskId
    )
    expect(restored.ok && restored.data.turns[0].answer.status).toBe('published')
    expect(
      await app.electronApp.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length
      )
    ).toBe(0)
  } finally {
    await writeFile(
      info.outputPath('file-execution-results.json'),
      JSON.stringify({ seen, errors, toolResults }, null, 2)
    )
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
