import { createServer } from 'node:http'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import * as XLSX from 'xlsx'
import pdfParse from 'pdf-parse-new'
import { test, expect, type ElectronAppInstance } from '../fixtures/electronApp'
import { waitForAppReady } from '../helpers/wait'
import type { WorkbookCatalog } from '../../../src/shared/analysis'
import type { ModelType } from '../../../src/shared/model'

async function nativeProtocol(app: ElectronAppInstance) {
  await app.electronApp.evaluate(() => {
    const cp = process.getBuiltinModule(
        'node:child_process'
      ) as typeof import('node:child_process'),
      module = process.getBuiltinModule('node:module') as typeof import('node:module'),
      path = process.getBuiltinModule('node:path') as typeof import('node:path')
    const spawn = cp.spawn
    cp.spawn = ((
      command: string,
      args: string[],
      options: import('node:child_process').SpawnOptions
    ) =>
      command.endsWith('SemaPath.PowerBiBridge.exe')
        ? spawn(
            process.execPath,
            [path.join(process.cwd(), 'test', 'fixtures', 'powerbiBridgeProtocol.cjs')],
            { ...options, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
          )
        : spawn(command, args, options)) as typeof cp.spawn
    module.syncBuiltinESMExports()
  })
}
for (const kind of ['mysql', 'powerbi'] as const) {
  test(`Natural ${kind} acquisition -> ${kind === 'mysql' ? 'Excel join' : 'native model'} -> exact evidence and frozen reports @smoke`, async ({
    launchApp
  }, testInfo) => {
    const port = Number(process.env.SEMAPATH_MYSQL_TEST_PORT ?? 0)
    test.skip(kind === 'mysql' && !port, 'Requires the isolated synthetic MySQL fixture')
    test.setTimeout(300000)
    const prompts: string[] = []
    let waiting = false
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')),
          prompt = body.messages.map((m: { content: string }) => m.content).join('\n')
        prompts.push(prompt)
        const acquisition = prompt.includes('REMOTE_CATALOG_DATA\n')
        const question = acquisition
          ? prompt.split('\nQUESTION\n')[1].split('\nHISTORY_DATA')[0]
          : (JSON.parse(prompt.split('HUMAN_QUESTION\n')[1].split('\n')[0]) as string)
        if (question.includes('等待取消')) {
          waiting = true
          return
        }
        let answer: unknown = { decision: 'confirm' }
        if (acquisition) {
          const remote = JSON.parse(
            prompt.split('REMOTE_CATALOG_DATA\n')[1].split('\nWORKBOOK_CATALOG_DATA')[0]
          ) as { id: string; structure: unknown }[]
          const files = JSON.parse(
            prompt.split('WORKBOOK_CATALOG_DATA\n')[1].split('\nACQUISITION_RESULTS_DATA')[0]
          ) as WorkbookCatalog[]
          const steps = JSON.parse(
            prompt.split('ACQUISITION_RESULTS_DATA\n')[1].split('\nLAST_ERROR_DATA')[0]
          ) as { sourceId: string; kind: string }[]
          if (!steps.length)
            answer = {
              action: 'fetch',
              targetId: remote[0].id,
              title: '自动读取订单',
              query: question.includes('拒绝范围')
                ? 'SELECT * FROM other.orders'
                : kind === 'mysql'
                  ? 'SELECT id,customer,amount FROM orders ORDER BY id'
                  : "EVALUATE 'Orders'"
            }
          else if (kind === 'mysql' && steps.length === 1) {
            const mapping = files.find((file) => file.name === '客户区域.xlsx')!
            answer = {
              action: 'join',
              input: {
                title: '自动关联订单区域',
                left: { sourceId: steps[0].sourceId, sheet: '数据', headerRow: 1, key: 'C' },
                right: { sourceId: mapping.sourceId, sheet: '客户区域', headerRow: 1, key: 'A' },
                kind: 'left',
                cardinality: 'many_to_one',
                keyKind: 'text'
              }
            }
          } else answer = { action: 'analyze', sourceIds: [steps.at(-1)!.sourceId] }
        } else if (!prompt.includes('EXECUTED_EVIDENCE_DATA\n')) {
          const files = JSON.parse(prompt.split('WORKBOOK_CATALOG_DATA\n')[1]) as WorkbookCatalog[]
          answer = {
            status: 'ready',
            queries: [
              {
                key: 'q1',
                sourceId: files[0].sourceId,
                sheet: '数据',
                headerRow: 1,
                operation: 'sum',
                measure: kind === 'mysql' ? 'D' : 'C',
                groupBy: kind === 'mysql' ? 'F' : 'B',
                filters: []
              }
            ],
            views: [{ kind: 'summary', queryKey: 'q1', chart: 'bar' }]
          }
        }
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            id: 'synthetic-acquisition',
            object: 'chat.completion',
            created: 1,
            model: 'acquisition-fixture',
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
    if (!address || typeof address === 'string') throw new Error('Synthetic provider unavailable')
    let app = await launchApp()
    try {
      await waitForAppReady(app.page)
      if (kind === 'powerbi') await nativeProtocol(app)
      await app.electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.webContents.getURL().includes('/renderer/'))
          ?.setSize(1440, 1000)
      )
      await app.page.evaluate(() => window.deepchat.invoke('config.setTheme', { theme: 'light' }))
      await app.page.getByTestId('sidebar-analysis-button').click()
      await app.page.getByTestId('analysis-new-task').click()
      await app.page.getByTestId('analysis-manage-data').click()
      await app.page.getByTestId('analysis-tab-analysis').click()
      await app.page.getByTestId('natural-data-mode').selectOption('connections')
      await app.page.getByTestId('natural-refresh-data').click()
      await expect(app.page.getByTestId('natural-data-selection')).toContainText(
        '当前任务还没有可用连接'
      )
      await expect(app.page.getByTestId('natural-ask')).toBeDisabled()
      await app.page.getByTestId('natural-data-selection').scrollIntoViewIfNeeded()
      await app.page.screenshot({
        path: testInfo.outputPath('acquisition-empty-light-1440.png'),
        fullPage: true
      })
      await app.page.getByTestId('analysis-manage-data').click()
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
      if (kind === 'mysql') {
        await app.page.getByTestId('analysis-connector-excel').click()
        const book = XLSX.utils.book_new()
        XLSX.utils.book_append_sheet(
          book,
          XLSX.utils.aoa_to_sheet([
            ['客户', '区域'],
            ['001', '华东'],
            ['002', '华南']
          ]),
          '客户区域'
        )
        const mapping = testInfo.outputPath('客户区域.xlsx')
        await writeFile(mapping, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }))
        await app.electronApp.evaluate(({ dialog }, filePath) => {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] })
        }, mapping)
        await app.page.getByTestId('analysis-add-files').click()
        await expect(app.page.getByTestId('analysis-preview-table')).toContainText('华东')
        await app.page.getByTestId('analysis-manage-data').click()
        await app.page.getByTestId('analysis-connector-sql').click()
        for (const [field, value] of Object.entries({
          name: '合成验收订单数据库',
          host: '127.0.0.1',
          port: String(port),
          database: 'replica_fixture',
          user: 'replica_reader',
          password: 'synthetic-test-secret'
        }))
          await app.page.getByTestId('sql-' + field).fill(value)
        await app.page.getByTestId('sql-tls').uncheck()
        await app.page.getByTestId('sql-save').click()
        await expect(app.page.getByTestId('sql-schema')).toBeVisible()
      } else {
        await app.page.getByTestId('analysis-connector-localPbi').click()
        await app.page.getByTestId('pbi-discover').click()
        await app.page.getByTestId('pbi-local-model').selectOption('synthetic-native-model')
        await app.page.getByTestId('pbi-bind').click()
        await expect(app.page.getByTestId('pbi-schema')).toBeEnabled()
        expect((await getTask()).sources).toEqual([])
      }
      if (
        (await app.page.getByTestId('analysis-manage-data').getAttribute('aria-expanded')) ===
        'true'
      )
        await app.page.getByTestId('analysis-manage-data').click()
      await app.page.evaluate(
        async (baseUrl) => {
          await window.deepchat.invoke('providers.add', {
            provider: {
              id: 'acquisition-provider',
              name: '合成自动取数验收模型',
              apiType: 'openai-completions',
              apiKey: 'synthetic-key',
              baseUrl,
              enable: true,
              custom: true
            }
          })
          await window.deepchat.invoke('models.addCustom', {
            providerId: 'acquisition-provider',
            model: {
              id: 'acquisition-fixture',
              name: 'Acquisition fixture',
              type: 'chat' as ModelType,
              contextLength: 32768,
              maxTokens: 8192
            }
          })
          await window.deepchat.invoke('models.setStatus', {
            providerId: 'acquisition-provider',
            modelId: 'acquisition-fixture',
            enabled: true
          })
        },
        'http://127.0.0.1:' + address.port + '/v1'
      )
      await app.page.getByTestId('analysis-tab-analysis').click()
      await app.page.getByTestId('natural-refresh-models').click()
      await app.page.getByTestId('natural-data-mode').selectOption('connections')
      await app.page.getByTestId('natural-refresh-data').click()
      await app.page.getByTestId('natural-target').check()
      if (kind === 'powerbi') {
        await expect(app.page.getByTestId('natural-local-transport')).toContainText('ADOMD')
        await expect(app.page.getByTestId('natural-data-transport')).toHaveCount(0)
      }
      if (kind === 'mysql') {
        await app.page.getByTestId('natural-data-selection').locator('summary').click()
        await app.page.getByTestId('natural-include-file').check()
        await app.page.getByTestId('natural-question').fill('拒绝范围：核对查询边界')
        await app.page.getByTestId('natural-ask').click()
        await expect(app.page.getByTestId('natural-error')).toContainText('超出了所选数据结构')
        expect((await getTask()).sources).toHaveLength(1)
        await app.page.getByTestId('natural-error').scrollIntoViewIfNeeded()
        await app.page.screenshot({
          path: testInfo.outputPath('acquisition-error-light-1440.png'),
          fullPage: true
        })
      }
      await app.page.getByTestId('natural-question').fill('等待取消：读取最新订单')
      await app.page.getByTestId('natural-ask').click()
      await expect.poll(() => waiting).toBe(true)
      await expect(app.page.getByTestId('natural-data-mode')).toBeDisabled()
      await expect(app.page.getByTestId('natural-target')).toBeDisabled()
      await app.page.getByTestId('natural-progress').scrollIntoViewIfNeeded()
      await app.page.screenshot({
        path: testInfo.outputPath('acquisition-progress-light-1440.png'),
        fullPage: true
      })
      await app.page.getByTestId('natural-stop').click()
      await expect(app.page.getByTestId('natural-error')).toContainText('分析已停止')
      expect((await getTask()).turns).toEqual([])
      const question =
        kind === 'mysql'
          ? '读取最新订单，按客户键关联客户区域文件，汇总各区域金额并保留未匹配客户'
          : '读取当前 Power BI 订单模型，按客户汇总金额'
      await app.page.getByTestId('natural-question').fill(question)
      await app.page.getByTestId('natural-data-mode').focus()
      for (const [width, theme] of [
        [1440, 'light'],
        [1280, 'dark']
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
        await app.page.getByTestId('natural-data-selection').scrollIntoViewIfNeeded()
        expect(
          await app.page
            .getByTestId('natural-target')
            .evaluate((el) => getComputedStyle(el.closest('label')!).flexDirection)
        ).toBe('row')
        const contrast = await app.page.getByTestId('natural-error').evaluate((el) => {
          const style = getComputedStyle(el),
            canvas = document.createElement('canvas')
          canvas.width = canvas.height = 1
          const context = canvas.getContext('2d')!
          const luminance = (color: string) => {
            context.fillStyle = color
            context.fillRect(0, 0, 1, 1)
            const rgb = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((v) => {
              const s = v / 255
              return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
            })
            return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
          }
          const a = luminance(style.color),
            b = luminance(style.getPropertyValue('--background'))
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
        })
        expect(contrast).toBeGreaterThanOrEqual(4.5)
        await app.page.screenshot({
          path: testInfo.outputPath('acquisition-ready-' + theme + '-' + width + '.png'),
          fullPage: true
        })
        expect(
          await app.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
        ).toBe(true)
      }
      await app.page.getByTestId('natural-ask').click()
      await expect(app.page.getByTestId('natural-value-0-0')).toHaveText(/0\.3/)
      const task = await getTask(),
        turn = task.turns[0],
        source = task.sources.at(-1)!
      expect(task.runs[0].values.map((v) => v.value)).toEqual(
        kind === 'mysql' ? ['0.3', '5', '2.5'] : ['0.3']
      )
      expect(turn.retrieval?.steps.map((s) => s.kind)).toEqual(
        kind === 'mysql' ? ['query', 'join'] : ['query']
      )
      expect(source.origin?.acquisition?.question).toBe(question)
      await app.page.getByTestId('retrieval-trace').locator('summary').click()
      await app.page.getByTestId('retrieval-trace').scrollIntoViewIfNeeded()
      await app.page.screenshot({
        path: testInfo.outputPath('acquisition-trace-dark-1280.png'),
        fullPage: true
      })
      await app.page.getByTestId('retrieval-trace').getByRole('button').last().click()
      await expect(app.page.getByTestId('analysis-preview-table')).toContainText(
        '0.10000000000000000000'
      )
      await expect(
        app.page.getByTestId('data-origin').getByTestId('acquisition-origin').first()
      ).toContainText(question)
      await app.page.getByTestId('analysis-tab-analysis').click()
      await app.page.getByTestId('natural-value-0-0').click()
      await expect(app.page.getByTestId('evidence-inputs')).toContainText(
        kind === 'mysql' ? '0.10000000000000000000' : '0.1'
      )
      await app.page.getByTestId('analysis-tab-analysis').click()
      await app.page.getByTestId('natural-publish').click()
      await expect(app.page.getByTestId('natural-published')).toBeVisible()
      for (const file of task.sources) await unlink(file.path)
      await app.page.getByTestId('natural-export-report').click()
      for (const [index, format] of ['a4', 'slides'].entries()) {
        await app.page.getByTestId('report-title').fill('自然语言自动取数报告 · 合成验收')
        await app.page.getByTestId('report-format').selectOption(format)
        await app.page.getByTestId('report-create').click()
        const reports = () =>
          app.page.evaluate(async (taskId) => {
            const result = await window.deepchat.invoke('analysis.reports.list', { taskId })
            if (!result.ok) throw new Error(result.error)
            return result.data
          }, task.id)
        await expect.poll(async () => (await reports()).length).toBe(index + 1)
        const report = (await reports())[0]
        await expect
          .poll(async () => (await reports()).find((r) => r.id === report.id)!.status, {
            timeout: 90000
          })
          .not.toBe('rendering')
        expect((await reports()).find((r) => r.id === report.id)!.status).toBe('ready')
        for (const kind of ['pdf', 'evidence'] as const) {
          const target = testInfo.outputPath(
            'automatic-' + format + (kind === 'pdf' ? '.pdf' : '.json')
          )
          await app.electronApp.evaluate(({ dialog }, filePath) => {
            dialog.showSaveDialog = async () => ({ canceled: false, filePath })
          }, target)
          await app.page
            .getByTestId((kind === 'pdf' ? 'report-save-' : 'report-evidence-') + report.id)
            .click()
          await expect(app.page.getByTestId('report-notice')).toContainText(target)
          const bytes = await readFile(target)
          if (kind === 'pdf') {
            const pdf = await pdfParse(bytes, { verbosityLevel: 0 })
            expect(pdf.text).toContain('0.3')
            expect(pdf.text).toContain(source.sha256)
            expect(pdf.text).toContain('SHA-256')
          } else {
            expect(createHash('sha256').update(bytes).digest('hex')).toBe(report.snapshotHash)
            const frozen = JSON.parse(bytes.toString('utf8'))
            expect(frozen.runs[0].source.origin.acquisition.question).toBe(question)
          }
        }
      }
      for (const secret of ['synthetic-test-secret', 'replica_reader', 'synthetic-key'])
        expect(prompts.join('\n')).not.toContain(secret)
      const id = task.id
      await app.close()
      app = await launchApp()
      await waitForAppReady(app.page)
      const restored = await app.page.evaluate(async (taskId) => {
        const result = await window.deepchat.invoke('analysis.tasks.get', { taskId })
        if (!result.ok) throw new Error(result.error)
        return result.data
      }, id)
      expect(restored.turns[0].retrieval).toEqual(turn.retrieval)
      expect(restored.turns[0].answer.status).toBe('published')
      expect(app.pageErrors).toEqual([])
    } finally {
      await app.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
}
