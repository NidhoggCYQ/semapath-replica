import { createServer } from 'node:http'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import * as XLSX from 'xlsx'
import pdfParse from 'pdf-parse-new'
import { test, expect } from '../fixtures/electronApp'
import { waitForAppReady } from '../helpers/wait'
import type { WorkbookCatalog, NaturalReadyPlan } from '../../../src/shared/analysis'
import type { ModelType } from '../../../src/shared/model'
import { REPORT_RENDERER_VERSION } from '../../../src/shared/analysisReport'

test('MySQL -> Excel join -> natural analysis -> root cell evidence -> frozen reports and restart @smoke', async ({
  launchApp
}, testInfo) => {
  const port = Number(process.env.SEMAPATH_MYSQL_TEST_PORT ?? 0)
  test.skip(!port, 'Requires the explicitly provisioned isolated synthetic MySQL fixture')
  test.setTimeout(300000)
  const prompts: string[] = [],
    focusChecks: unknown[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const prompt = body.messages.map((m: { content: string }) => m.content).join('\n')
      prompts.push(prompt)
      let answer: unknown
      if (prompt.includes('EXECUTED_EVIDENCE_DATA\n')) answer = { decision: 'confirm' }
      else {
        const catalogs = JSON.parse(prompt.split('WORKBOOK_CATALOG_DATA\n')[1]) as WorkbookCatalog[]
        const source = catalogs.find((c) => c.name === '订单区域关联.xlsx')
        if (!source) throw new Error('Joined snapshot missing from real worker catalog')
        const plan: NaturalReadyPlan = {
          status: 'ready',
          queries: [
            {
              key: 'q1',
              sourceId: source.sourceId,
              sheet: '数据',
              headerRow: 1,
              operation: 'sum',
              measure: 'D',
              groupBy: 'F',
              filters: []
            }
          ],
          views: [{ kind: 'summary', queryKey: 'q1', chart: 'bar' }]
        }
        answer = plan
      }
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          id: 'synthetic-data',
          object: 'chat.completion',
          created: 1,
          model: 'data-fixture',
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
  if (!address || typeof address === 'string') throw new Error('Synthetic model unavailable')
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ['客户', '区域', '目标'],
      ['001', '华东', '100'],
      ['002', '华南', '200'],
      ['004', '华西', '300']
    ]),
    '客户区域'
  )
  const mappingPath = testInfo.outputPath('synthetic-customer-regions.xlsx')
  await writeFile(mappingPath, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }))
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
    await app.page.getByTestId('analysis-connector-sql').click()
    await expect(app.page.getByTestId('sql-panel')).toBeVisible()
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
    for (const [field, value] of Object.entries({
      name: '合成订单数据库',
      host: '127.0.0.1',
      port: String(port),
      database: 'replica_fixture',
      user: 'replica_reader',
      password: 'synthetic-test-secret'
    }))
      await app.page.getByTestId('sql-' + field).fill(value)
    await app.page.getByTestId('sql-tls').uncheck()
    await app.page.getByTestId('sql-test').click()
    await expect(app.page.getByTestId('sql-notice')).toContainText('连接成功')
    await app.page.getByTestId('sql-save').click()
    await expect(app.page.getByTestId('sql-schema')).toBeVisible()
    expect(await app.page.getByTestId('sql-password').inputValue()).toBe('')
    const taskId = (await getTask()).id
    const publicConnections = await app.page.evaluate(
      async (taskId) => window.deepchat.invoke('analysis.sql.list', { taskId }),
      taskId
    )
    expect(publicConnections.ok && publicConnections.data[0].hasPassword).toBe(true)
    expect(JSON.stringify(publicConnections)).not.toContain('synthetic-test-secret')
    const userData = await app.electronApp.evaluate(({ app }) => app.getPath('userData'))
    const sealed = await readFile(path.join(userData, 'analysis-connections.json'), 'utf8')
    for (const secret of [
      'synthetic-test-secret',
      'replica_reader',
      '127.0.0.1',
      'replica_fixture'
    ])
      expect(sealed).not.toContain(secret)
    await app.page.getByTestId('sql-schema').click()
    await expect(app.page.getByTestId('sql-table')).toContainText('orders')
    await app.page.getByTestId('sql-table').selectOption('orders')
    await expect(app.page.getByTestId('sql-schema-table')).toContainText('decimal(65,20)')
    await app.page.getByTestId('sql-preview').click()
    await expect(app.page.getByTestId('sql-preview-table')).toContainText('9007199254740993001')
    await expect(app.page.getByTestId('sql-preview-table').locator('tbody tr')).toHaveCount(4)
    await app.page.getByTestId('sql-snapshot-name').fill('不能写入的查询')
    await app.page.getByTestId('sql-query').fill('UPDATE orders SET amount=0')
    await app.page.getByTestId('sql-run').click()
    await expect(app.page.getByTestId('sql-error')).toContainText('单条 SELECT')
    await expect(app.page.getByTestId('sql-error')).toBeInViewport({ ratio: 1 })
    await app.page.screenshot({
      path: testInfo.outputPath('sql-query-light-1440.png'),
      fullPage: true
    })
    expect((await getTask()).sources).toHaveLength(0)
    await app.page
      .getByTestId('sql-query')
      .fill(
        'SELECT SUM(a.n*b.n*c.n) FROM sequence_rows a CROSS JOIN sequence_rows b CROSS JOIN sequence_rows c'
      )
    await app.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes('/renderer/'))
        ?.setSize(1280, 1000)
    )
    await app.page.evaluate(() => window.deepchat.invoke('config.setTheme', { theme: 'dark' }))
    await app.page.getByTestId('sql-run').click()
    await expect(app.page.getByTestId('sql-stop')).toBeVisible()
    await expect(app.page.getByTestId('sql-query-feedback')).toContainText('正在取数')
    await expect(app.page.getByTestId('sql-stop')).toBeInViewport({ ratio: 1 })
    await app.page.screenshot({
      path: testInfo.outputPath('sql-query-running-dark-1280.png'),
      fullPage: true
    })
    await expect(app.page.getByTestId('analysis-manage-data')).toBeDisabled()
    await app.page.getByTestId('sql-stop').click()
    await expect(app.page.getByTestId('sql-error')).toContainText('取消')
    await expect(app.page.getByTestId('sql-error')).toBeInViewport({ ratio: 1 })
    await app.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes('/renderer/'))
        ?.setSize(1440, 1000)
    )
    await app.page.evaluate(() => window.deepchat.invoke('config.setTheme', { theme: 'light' }))
    expect((await getTask()).sources).toHaveLength(0)
    await app.page
      .getByTestId('sql-query')
      .fill('SELECT id,customer,amount FROM orders ORDER BY id')
    await app.page.getByTestId('sql-snapshot-name').fill('SQL订单')
    await app.page.getByTestId('sql-query').scrollIntoViewIfNeeded()
    await app.page.screenshot({
      path: testInfo.outputPath('sql-query-ready-light-1440.png'),
      fullPage: true
    })
    await app.page.getByTestId('sql-run').click()
    await expect(app.page.getByTestId('analysis-preview-table')).toContainText(
      '0.10000000000000000000'
    )
    await expect(app.page.getByTestId('analysis-manage-data')).toBeEnabled()
    const sqlSource = (await getTask()).sources[0]
    expect(sqlSource.origin?.result?.rows).toHaveLength(4)
    const refresh = await app.page.evaluate(
      async ({ taskId, sourceId }) =>
        window.deepchat.invoke('analysis.sources.refresh', { taskId, sourceId }),
      { taskId, sourceId: sqlSource.id }
    )
    expect(refresh).toEqual({ ok: false, error: 'DATA_SNAPSHOT_IMMUTABLE' })
    await app.page.getByTestId('analysis-manage-data').click()
    await app.page.getByTestId('analysis-connector-excel').click()
    await app.electronApp.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] })
    }, mappingPath)
    await app.page.getByTestId('analysis-add-files').click()
    await expect(app.page.getByTestId('analysis-manage-data')).toBeEnabled()
    const mapping = (await getTask()).sources.find((s) => s.path === mappingPath)!
    await app.page.getByTestId('analysis-manage-data').click()
    await expect(app.page.getByTestId('join-panel')).toBeVisible()
    await app.page.getByTestId('join-panel').locator('summary').click()
    await app.page.getByTestId('join-left-source').selectOption(sqlSource.id)
    await expect(app.page.getByTestId('join-left-key')).toContainText('customer')
    await app.page.getByTestId('join-left-key').selectOption('C')
    await app.page.getByTestId('join-right-source').selectOption(mapping.id)
    await expect(app.page.getByTestId('join-right-key')).toContainText('客户')
    await app.page.getByTestId('join-right-key').selectOption('A')
    await app.page.getByTestId('join-name').fill('订单区域关联')
    await app.page.getByTestId('join-name').scrollIntoViewIfNeeded()
    await app.page.screenshot({
      path: testInfo.outputPath('join-form-light-1440.png'),
      fullPage: true
    })
    await app.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes('/renderer/'))
        ?.setSize(1280, 1000)
    )
    await app.page.evaluate(() => window.deepchat.invoke('config.setTheme', { theme: 'dark' }))
    await app.page.screenshot({
      path: testInfo.outputPath('join-form-dark-1280.png'),
      fullPage: true
    })
    await app.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes('/renderer/'))
        ?.setSize(1440, 1000)
    )
    await app.page.evaluate(() => window.deepchat.invoke('config.setTheme', { theme: 'light' }))
    await app.page.getByTestId('join-create').click()
    await expect(app.page.getByTestId('analysis-preview-table')).toContainText('R.区域')
    await expect(app.page.getByTestId('analysis-source')).toBeEnabled()
    const joined = (await getTask()).sources.at(-1)!
    expect(joined.origin).toMatchObject({ kind: 'join', rows: 4, matched: 3, unmatched: 1 })
    expect(joined.origin!.parents![0].result!.rows[0][1]).toBe('9007199254740993001')
    expect(joined.origin!.parents![0].createdAt).toBe(sqlSource.origin!.createdAt)
    expect(joined.origin!.parents![0].types).toEqual(sqlSource.origin!.types)
    await app.page.evaluate(
      async (baseUrl) => {
        await window.deepchat.invoke('providers.add', {
          provider: {
            id: 'data-fixture-provider',
            name: '合成数据链路模型',
            apiType: 'openai-completions',
            apiKey: 'synthetic-not-real',
            baseUrl,
            enable: true,
            custom: true
          }
        })
        await window.deepchat.invoke('models.addCustom', {
          providerId: 'data-fixture-provider',
          model: {
            id: 'data-fixture',
            name: 'Data fixture',
            type: 'chat' as ModelType,
            contextLength: 32768,
            maxTokens: 8192
          }
        })
        await window.deepchat.invoke('models.setStatus', {
          providerId: 'data-fixture-provider',
          modelId: 'data-fixture',
          enabled: true
        })
      },
      'http://127.0.0.1:' + address.port + '/v1'
    )
    await app.page.getByTestId('analysis-tab-analysis').click()
    await app.page.getByTestId('natural-refresh-models').click()
    await app.page
      .getByTestId('natural-question')
      .fill('对订单区域关联结果按区域汇总金额，保留未匹配客户')
    await app.page.getByTestId('natural-ask').click()
    await expect(app.page.getByTestId('natural-value-0-0')).toHaveText(/0\.3/)
    const calculated = await getTask(),
      run = calculated.runs[0]
    expect(run.values.map((v) => [v.category, v.value])).toEqual([
      ['华东', '0.3'],
      ['华南', '5'],
      ['', '2.5']
    ])
    expect(run.values[0].inputs[0].origin).toEqual([
      {
        sourceId: sqlSource.id,
        source: sqlSource.name,
        sha256: sqlSource.sha256,
        sheet: '数据',
        cell: 'D2',
        value: '0.10000000000000000000'
      },
      {
        sourceId: mapping.id,
        source: mapping.name,
        sha256: mapping.sha256,
        sheet: '客户区域',
        cell: 'B2',
        value: '华东'
      }
    ])
    expect(prompts).toHaveLength(2)
    expect(prompts.join('\n')).not.toContain('synthetic-test-secret')
    expect(prompts[0]).not.toContain(sqlSource.origin!.query!)
    await app.page.getByTestId('natural-value-0-0').click()
    await expect(app.page.getByTestId('evidence-inputs')).toContainText(
      'SQL订单.xlsx · 数据 · D2 ='
    )
    await expect(app.page.getByTestId('evidence-inputs')).toContainText('客户区域 · B2 = 华东')
    const originPanel = app.page.getByTestId('analysis-evidence').getByTestId('data-origin')
    await originPanel.locator('summary').click()
    await originPanel.scrollIntoViewIfNeeded()
    await app.page.screenshot({
      path: testInfo.outputPath('join-origin-light-1440.png'),
      fullPage: true
    })
    await app.page.getByTestId('evidence-inputs').scrollIntoViewIfNeeded()
    await app.page.screenshot({
      path: testInfo.outputPath('join-evidence-light-1440.png'),
      fullPage: true
    })
    await app.page.getByTestId('analysis-tab-analysis').click()
    await app.page.getByTestId('natural-publish').click()
    await expect(app.page.getByTestId('natural-published')).toBeVisible()
    await unlink(mappingPath)
    await unlink(sqlSource.path)
    await unlink(joined.path)
    await app.page.getByTestId('natural-export-report').click()
    const reports = () =>
      app.page.evaluate(async (taskId) => {
        const result = await window.deepchat.invoke('analysis.reports.list', { taskId })
        if (!result.ok) throw new Error(result.error)
        return result.data
      }, taskId)
    const reportIds: string[] = []
    for (const format of ['a4', 'slides'] as const) {
      await app.page.getByTestId('report-title').fill('数据库与客户区域关联报告')
      await app.page.getByTestId('report-format').selectOption(format)
      await app.page.getByTestId('report-create').click()
      await expect.poll(async () => (await reports()).length).toBe(reportIds.length + 1)
      const report = (await reports())[0]
      await expect
        .poll(async () => (await reports()).find((r) => r.id === report.id)!.status, {
          timeout: 90000
        })
        .not.toBe('rendering')
      const ready = (await reports()).find((r) => r.id === report.id)!
      expect(ready.status, JSON.stringify(ready.attempts)).toBe('ready')
      expect(ready.rendererVersion).toBe(REPORT_RENDERER_VERSION)
      reportIds.push(ready.id)
      for (const kind of ['pdf', 'evidence'] as const) {
        const target = testInfo.outputPath('joined-' + format + (kind === 'pdf' ? '.pdf' : '.json'))
        await app.electronApp.evaluate(({ dialog }, filePath) => {
          dialog.showSaveDialog = async () => ({ canceled: false, filePath })
        }, target)
        await app.page
          .getByTestId((kind === 'pdf' ? 'report-save-' : 'report-evidence-') + ready.id)
          .click()
        await expect(app.page.getByTestId('report-notice')).toContainText(target)
        const bytes = await readFile(target)
        if (kind === 'pdf') {
          const parsed = await pdfParse(bytes, { verbosityLevel: 0 }),
            words = parsed.text.replace(/\s/g, '')
          expect(words).toContain('跨表关联快照')
          expect(words).toContain('多对一')
          expect(words).toContain('精确文本键')
          expect(words).toContain('0.3')
          expect(words).toContain('SELECTid,customer,amountFROMordersORDERBYid')
          expect(words).toContain('客户区域!B2=华东')
          expect(parsed.text).toContain(mapping.sha256)
        } else {
          expect(createHash('sha256').update(bytes).digest('hex')).toBe(ready.snapshotHash)
          const frozen = JSON.parse(bytes.toString('utf8'))
          expect(frozen.runs[0].source.origin.parents[0].result.rows).toHaveLength(4)
          expect(frozen.runs[0].source.origin.rowMap).toHaveLength(4)
          expect(frozen.runs[0].source.path).toBeUndefined()
          expect(bytes.toString('utf8')).not.toContain('synthetic-test-secret')
        }
      }
    }
    await app.page.getByTestId('analysis-manage-data').click()
    await app.page.getByTestId('analysis-connector-sql').click()
    const connectionId = publicConnections.ok ? publicConnections.data[0].id : ''
    await app.page.getByTestId('sql-connections').selectOption(connectionId)
    for (const [width, theme, color] of [
      [1440, 'light', 'rgb(35, 100, 202)'],
      [1280, 'dark', 'rgb(133, 180, 255)']
    ] as const) {
      await app.electronApp.evaluate(
        ({ BrowserWindow }, width) =>
          BrowserWindow.getAllWindows()
            .find((w) => w.webContents.getURL().includes('/renderer/'))
            ?.setSize(width, 1000),
        width
      )
      await app.page.evaluate(
        (theme) => window.deepchat.invoke('config.setTheme', { theme }),
        theme
      )
      await app.page.getByTestId('sql-host').focus()
      await app.page.keyboard.press('Tab')
      await app.page.keyboard.press('Shift+Tab')
      const focus = await app.page.getByTestId('sql-host').evaluate((el) => ({
        visible: el.matches(':focus-visible'),
        style: getComputedStyle(el).outlineStyle,
        color: getComputedStyle(el).outlineColor,
        width: getComputedStyle(el).outlineWidth,
        dpr: devicePixelRatio
      }))
      expect(focus).toMatchObject({ visible: true, style: 'solid', color })
      expect(Math.abs(Number.parseFloat(focus.width) - 2)).toBeLessThanOrEqual(1 / focus.dpr)
      focusChecks.push({ width, theme, ...focus })
      await app.page.locator('.analysis-main').evaluate((el) => {
        el.scrollTop = 0
      })
      await app.page.screenshot({
        path: testInfo.outputPath('sql-connection-' + theme + '-' + width + '.png'),
        fullPage: true
      })
      expect(
        await app.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true)
    }
    await writeFile(
      testInfo.outputPath('data-focus-checks.json'),
      JSON.stringify(focusChecks, null, 2)
    )
    await writeFile(
      testInfo.outputPath('data-final-task.json'),
      JSON.stringify(await getTask(), null, 2)
    )
    await app.close()
    app = await launchApp()
    await waitForAppReady(app.page)
    await app.page.getByTestId('sidebar-analysis-button').click()
    const restored = await app.page.evaluate(async (taskId) => {
      const result = await window.deepchat.invoke('analysis.sql.list', { taskId })
      if (!result.ok) throw new Error(result.error)
      const { hasPassword, ...config } = result.data[0]
      return {
        hasPassword,
        test: await window.deepchat.invoke('analysis.sql.test', {
          taskId,
          requestId: crypto.randomUUID(),
          config
        })
      }
    }, taskId)
    expect(restored.hasPassword).toBe(true)
    expect(restored.test.ok).toBe(true)
    expect(
      (await reports()).filter((r) => reportIds.includes(r.id) && r.status === 'ready')
    ).toHaveLength(2)
    expect((await getTask()).turns[0].answer.status).toBe('published')
    expect(app.pageErrors).toEqual([])
  } finally {
    await app.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
