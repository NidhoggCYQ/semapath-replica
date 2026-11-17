import { createServer } from 'node:http'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import * as XLSX from 'xlsx'
import pdfParse from 'pdf-parse-new'
import { test, expect, type ElectronAppInstance } from '../fixtures/electronApp'
import { waitForAppReady } from '../helpers/wait'
import type { WorkbookCatalog, NaturalReadyPlan } from '../../../src/shared/analysis'
import type { ModelType } from '../../../src/shared/model'
import { REPORT_RENDERER_VERSION } from '../../../src/shared/analysisReport'

// Only the Microsoft SDK/HTTP boundary is synthetic. UI, typed IPC, loopback callback, DPAPI,
// the native discovery process, workbook workers, publication and PDF rendering execute for real.
async function installMicrosoftProtocol(app: ElectronAppInstance) {
  await app.electronApp.evaluate(async ({ app, shell }) => {
    const { createRequire } = process.getBuiltinModule(
        'node:module'
      ) as typeof import('node:module'),
      path = process.getBuiltinModule('node:path') as typeof import('node:path'),
      crypto = process.getBuiltinModule('node:crypto') as typeof import('node:crypto')
    const require = createRequire(path.join(app.getAppPath(), 'package.json'))
    const { PublicClientApplication } = require(
      path.join(path.dirname(require.resolve('@azure/msal-node/package.json')), 'dist', 'index.mjs')
    )
    const tenant = '22222222-2222-4222-8222-222222222222',
      workspace = '44444444-4444-4444-8444-444444444444',
      dataset = '33333333-3333-4333-8333-333333333333'
    const account = {
      homeAccountId: 'synthetic-home',
      tenantId: tenant,
      username: 'powerbi-fixture@example.invalid',
      name: 'Power BI 合成验收账号'
    }
    let authorization: Record<string, string> = {}
    const status = {
      calls: [] as string[],
      codeReceived: false,
      pkceVerified: false,
      queryStarted: false,
      cancelled: false
    }
    Object.assign(globalThis, { __powerbiProtocol: status })
    PublicClientApplication.prototype.getTokenCache = function () {
      return {
        getAllAccounts: async () => [account],
        serialize: () => 'synthetic-token-cache-for-dpapi',
        deserialize: () => {}
      }
    }
    PublicClientApplication.prototype.getAuthCodeUrl = async function (
      input: Record<string, string>
    ) {
      authorization = input
      return (
        'https://login.microsoftonline.com/' +
        tenant +
        '/oauth2/v2.0/authorize?state=' +
        input.state
      )
    }
    PublicClientApplication.prototype.acquireTokenByCode = async function (
      input: Record<string, string>
    ) {
      status.codeReceived = input.code === 'synthetic-code'
      status.pkceVerified =
        crypto.createHash('sha256').update(input.codeVerifier).digest('base64url') ===
        authorization.codeChallenge
      if (!status.codeReceived || !status.pkceVerified) throw new Error('Invalid PKCE')
      return {
        account,
        accessToken: 'synthetic-powerbi-access-token',
        expiresOn: new Date(Date.now() + 3600000)
      }
    }
    PublicClientApplication.prototype.acquireTokenSilent = async function () {
      return {
        account,
        accessToken: 'synthetic-powerbi-access-token',
        expiresOn: new Date(Date.now() + 3600000)
      }
    }
    const originalFetch = globalThis.fetch.bind(globalThis)
    shell.openExternal = async (url: string) => {
      const target = new URL(url)
      if (target.hostname !== 'login.microsoftonline.com') throw new Error('Unexpected login host')
      const callback = new URL(authorization.redirectUri)
      callback.hostname = '127.0.0.1'
      callback.searchParams.set('state', authorization.state)
      callback.searchParams.set('code', 'synthetic-code')
      const response = await originalFetch(callback)
      if (response.status !== 200) throw new Error('Callback failed')
    }
    globalThis.fetch = async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
      const url = String(input)
      if (!url.startsWith('https://api.powerbi.com/v1.0/myorg/'))
        return originalFetch(input, options)
      if (
        options?.redirect !== 'error' ||
        new Headers(options.headers).get('Authorization') !==
          'Bearer synthetic-powerbi-access-token'
      )
        throw new Error('Credential boundary failed')
      status.calls.push(url)
      if (url.includes('/executeQueries')) {
        const body = JSON.parse(String(options.body)),
          dax = body.queries[0].query
        if (!body.serializerSettings.includeNulls) throw new Error('Missing null contract')
        if (dax.includes('SLOW')) {
          status.queryStarted = true
          return new Promise<Response>((_resolve, reject) => {
            options.signal!.addEventListener(
              'abort',
              () => {
                status.cancelled = true
                reject(options.signal!.reason)
              },
              { once: true }
            )
          })
        }
        if (dax.includes('ERROR'))
          return new Response(
            '{"results":[{"tables":[{"rows":[],"error":{"code":"MoreRowsThanAllowed"}}]}]}'
          )
        return new Response(
          '{"results":[{"tables":[{"rows":[{"[id]":9007199254740993001,"[customer]":"001","[amount]":0.10000000000000000000},{"[id]":9007199254740993002,"[customer]":"001","[amount]":0.20000000000000000000},{"[id]":9007199254740993003,"[customer]":"002","[amount]":5.00000000000000000000},{"[id]":9007199254740993004,"[customer]":"003","[amount]":2.50000000000000000000}]}]}]}',
          { headers: { requestid: 'synthetic-request-id' } }
        )
      }
      if (url.endsWith('/datasets'))
        return new Response(JSON.stringify({ value: [{ id: dataset, name: '合成云端订单模型' }] }))
      if (url.includes('/groups?'))
        return new Response(
          JSON.stringify({
            value: [{ id: workspace, name: '合成验收工作区', isOnDedicatedCapacity: true }]
          })
        )
      throw new Error('Unexpected Power BI path')
    }
  })
}
async function assertPowerBiAlertContrast(app: ElectronAppInstance) {
  const contrast = await app.page
    .getByTestId('pbi-panel')
    .getByRole('alert')
    .evaluate((el) => {
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
      return {
        ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
        color: style.color,
        background: style.getPropertyValue('--background')
      }
    })
  expect(contrast.ratio, JSON.stringify(contrast)).toBeGreaterThanOrEqual(4.5)
}
test('Power BI protocol -> exact snapshot -> Excel join -> natural evidence -> frozen reports and restart @smoke', async ({
  launchApp
}, testInfo) => {
  test.setTimeout(300000)
  const prompts: string[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')),
        prompt = body.messages.map((m: { content: string }) => m.content).join('\n')
      prompts.push(prompt)
      let answer: unknown = { decision: 'confirm' }
      if (!prompt.includes('EXECUTED_EVIDENCE_DATA\n')) {
        const catalogs = JSON.parse(
            prompt.split('WORKBOOK_CATALOG_DATA\n')[1]
          ) as WorkbookCatalog[],
          source = catalogs.find((c) => c.name === 'PowerBI订单区域关联.xlsx')
        if (!source) throw new Error('PBI join missing')
        answer = {
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
        } satisfies NaturalReadyPlan
      }
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          id: 'synthetic-powerbi-analysis',
          object: 'chat.completion',
          created: 1,
          model: 'powerbi-fixture',
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
    } catch {
      response.statusCode = 500
      response.end('Synthetic protocol failed')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture unavailable')
  const mappingBook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(
    mappingBook,
    XLSX.utils.aoa_to_sheet([
      ['客户', '区域'],
      ['001', '华东'],
      ['002', '华南'],
      ['004', '华西']
    ]),
    '客户区域'
  )
  const mappingFile = testInfo.outputPath('powerbi-regions.xlsx')
  await writeFile(mappingFile, XLSX.write(mappingBook, { type: 'buffer', bookType: 'xlsx' }))
  let app = await launchApp()
  const getTask = () =>
    app.page.evaluate(async () => {
      const list = await window.deepchat.invoke('analysis.tasks.list', {})
      if (!list.ok) throw new Error(list.error)
      const result = await window.deepchat.invoke('analysis.tasks.get', { taskId: list.data[0].id })
      if (!result.ok) throw new Error(result.error)
      return result.data
    })
  try {
    await waitForAppReady(app.page)
    await installMicrosoftProtocol(app)
    await app.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes('/renderer/'))
        ?.setSize(1440, 1000)
    )
    await app.page.evaluate(() => window.deepchat.invoke('config.setTheme', { theme: 'light' }))
    await app.page.getByTestId('sidebar-analysis-button').click()
    await app.page.getByTestId('analysis-new-task').click()
    await app.page.getByTestId('analysis-connector-localPbi').click()
    await app.page.getByTestId('pbi-discover').click()
    await expect(app.page.getByTestId('pbi-discover')).toBeEnabled()
    await expect(app.page.getByTestId('pbi-panel')).toContainText('Power BI Desktop')
    await app.page.screenshot({
      path: testInfo.outputPath('powerbi-local-light-1440.png'),
      fullPage: true
    })
    await app.page.getByTestId('analysis-connector-cloudPbi').click()
    await expect(app.page.getByTestId('pbi-login')).toBeDisabled()
    await app.page.getByTestId('pbi-client-id').fill('11111111-1111-4111-8111-111111111111')
    await app.page.getByTestId('pbi-tenant-id').fill('22222222-2222-4222-8222-222222222222')
    await app.page.getByTestId('pbi-client-id').scrollIntoViewIfNeeded()
    await app.page.screenshot({
      path: testInfo.outputPath('powerbi-cloud-application-light-1440.png'),
      fullPage: true
    })
    await app.page.getByTestId('pbi-configure').click()
    await expect(app.page.getByTestId('pbi-login')).toBeEnabled()
    await app.page.getByTestId('pbi-login').click()
    await expect(app.page.getByTestId('pbi-account')).toContainText(
      'powerbi-fixture@example.invalid'
    )
    expect(
      await app.electronApp.evaluate(
        () =>
          (globalThis as unknown as { __powerbiProtocol: { pkceVerified: boolean } })
            .__powerbiProtocol.pkceVerified
      )
    ).toBe(true)
    const userData = await app.electronApp.evaluate(({ app }) => app.getPath('userData')),
      sealed = await readFile(path.join(userData, 'analysis-powerbi-auth.bin'))
    for (const secret of [
      'synthetic-token-cache',
      'synthetic-powerbi-access-token',
      'powerbi-fixture@example.invalid'
    ])
      expect(sealed.toString()).not.toContain(secret)
    await app.page.getByTestId('pbi-workspaces').click()
    await expect(app.page.getByTestId('pbi-workspace')).toContainText('合成验收工作区')
    await app.page.getByTestId('pbi-workspace').selectOption('44444444-4444-4444-8444-444444444444')
    await app.page.getByTestId('pbi-load-models').click()
    await expect(app.page.getByTestId('pbi-cloud-model')).toContainText('合成云端订单模型')
    await app.page
      .getByTestId('pbi-cloud-model')
      .selectOption('33333333-3333-4333-8333-333333333333')
    await app.page.getByTestId('pbi-bind').click()
    await expect(app.page.getByTestId('pbi-bound')).toContainText('合成云端订单模型')
    await app.page.getByTestId('pbi-account').scrollIntoViewIfNeeded()
    await app.page.screenshot({
      path: testInfo.outputPath('powerbi-cloud-connected-light-1440.png'),
      fullPage: true
    })
    await app.page.getByTestId('pbi-title').fill('PowerBI订单')
    await app.page.getByTestId('pbi-dax').fill('EVALUATE ERROR')
    await app.page.getByTestId('pbi-query').click()
    await expect(app.page.getByTestId('pbi-query-feedback')).toContainText('不完整')
    await expect(app.page.getByTestId('analysis-empty')).toContainText('尚未创建分析快照')
    await expect(app.page.getByTestId('analysis-empty').getByRole('button')).toHaveCount(0)
    await assertPowerBiAlertContrast(app)
    await expect(app.page.getByTestId('pbi-query-feedback')).toBeInViewport({ ratio: 1 })
    expect((await getTask()).sources).toHaveLength(0)
    await app.page.screenshot({
      path: testInfo.outputPath('powerbi-query-error-light-1440.png'),
      fullPage: true
    })
    await app.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes('/renderer/'))
        ?.setSize(1280, 1000)
    )
    await app.page.evaluate(() => window.deepchat.invoke('config.setTheme', { theme: 'dark' }))
    await app.page.getByTestId('pbi-dax').fill('EVALUATE SLOW')
    await app.page.getByTestId('pbi-query').click()
    await expect(app.page.getByTestId('pbi-cancel')).toBeVisible()
    await expect
      .poll(() =>
        app.electronApp.evaluate(
          () =>
            (globalThis as unknown as { __powerbiProtocol: { queryStarted: boolean } })
              .__powerbiProtocol.queryStarted
        )
      )
      .toBe(true)
    await expect(app.page.getByTestId('pbi-cancel')).toBeInViewport({ ratio: 1 })
    await expect(app.page.getByTestId('pbi-query-feedback')).toContainText('正在执行 DAX')
    await app.page.screenshot({
      path: testInfo.outputPath('powerbi-query-running-dark-1280.png'),
      fullPage: true
    })
    await app.page.getByTestId('pbi-cancel').click()
    await expect(app.page.getByTestId('pbi-query-feedback')).toContainText(
      '远端 Power BI 查询可能仍在运行'
    )
    expect((await getTask()).sources).toHaveLength(0)
    await app.page.getByTestId('pbi-dax').fill("EVALUATE 'Orders'")
    await app.page.getByTestId('pbi-query').click()
    await expect(app.page.getByTestId('analysis-preview-table')).toContainText(
      '9007199254740993001'
    )
    const taskId = (await getTask()).id,
      source = (await getTask()).sources[0]
    expect(source.origin).toMatchObject({
      kind: 'powerbi',
      rows: 4,
      powerBi: {
        transport: 'rest',
        precision: 'lossless_json',
        complete: true,
        modelId: '33333333-3333-4333-8333-333333333333'
      }
    })
    expect(source.origin!.result!.rows[0]).toEqual([
      '1',
      '9007199254740993001',
      '001',
      '0.10000000000000000000'
    ])
    await app.page.getByTestId('analysis-manage-data').click()
    await app.page.getByTestId('analysis-connector-excel').click()
    await app.electronApp.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] })
    }, mappingFile)
    await app.page.getByTestId('analysis-add-files').click()
    await expect(app.page.getByTestId('analysis-source')).toContainText('powerbi-regions.xlsx')
    const mapping = (await getTask()).sources.find((s) => s.path === mappingFile)!
    await app.page.getByTestId('analysis-source').selectOption(mapping.id)
    await expect(app.page.getByTestId('analysis-preview-table')).toContainText('华东')
    await app.page.getByTestId('analysis-manage-data').click()
    await app.page.getByTestId('join-panel').locator('summary').click()
    await app.page.getByTestId('join-left-source').selectOption(source.id)
    await app.page.getByTestId('join-left-key').selectOption('C')
    await app.page.getByTestId('join-right-source').selectOption(mapping.id)
    await app.page.getByTestId('join-right-key').selectOption('A')
    await app.page.getByTestId('join-name').fill('PowerBI订单区域关联')
    await app.page.getByTestId('join-create').click()
    await expect(app.page.getByTestId('analysis-preview-table')).toContainText('R.区域')
    const joined = (await getTask()).sources.at(-1)!
    expect(joined.origin!.parents![0].powerBi).toEqual(source.origin!.powerBi)
    await app.page.evaluate(
      async (baseUrl) => {
        await window.deepchat.invoke('providers.add', {
          provider: {
            id: 'powerbi-fixture-provider',
            name: 'Power BI 合成分析验收',
            apiType: 'openai-completions',
            apiKey: 'synthetic-analysis-key',
            baseUrl,
            enable: true,
            custom: true
          }
        })
        await window.deepchat.invoke('models.addCustom', {
          providerId: 'powerbi-fixture-provider',
          model: {
            id: 'powerbi-fixture',
            name: 'PBI fixture',
            type: 'chat' as ModelType,
            contextLength: 32768,
            maxTokens: 8192
          }
        })
        await window.deepchat.invoke('models.setStatus', {
          providerId: 'powerbi-fixture-provider',
          modelId: 'powerbi-fixture',
          enabled: true
        })
      },
      'http://127.0.0.1:' + address.port + '/v1'
    )
    await app.page.getByTestId('analysis-tab-analysis').click()
    await app.page.getByTestId('natural-refresh-models').click()
    await app.page.getByTestId('natural-question').fill('对 PowerBI订单区域关联 按区域汇总金额')
    await app.page.getByTestId('natural-ask').click()
    await expect(app.page.getByTestId('natural-value-0-0')).toHaveText(/0\.3/)
    const calculated = await getTask()
    expect(calculated.runs[0].values.map((v) => [v.category, v.value])).toEqual([
      ['华东', '0.3'],
      ['华南', '5'],
      ['', '2.5']
    ])
    expect(calculated.runs[0].values[0].inputs[0].origin![0]).toMatchObject({
      sourceId: source.id,
      cell: 'D2',
      value: '0.10000000000000000000'
    })
    expect(prompts).toHaveLength(2)
    for (const secret of [
      'synthetic-powerbi-access-token',
      'synthetic-token-cache',
      "EVALUATE 'Orders'"
    ])
      expect(prompts.join('\n')).not.toContain(secret)
    await app.page.getByTestId('natural-value-0-0').click()
    await app.page
      .getByTestId('analysis-evidence')
      .getByTestId('data-origin')
      .locator('summary')
      .first()
      .click()
    await expect(app.page.getByTestId('analysis-evidence').getByTestId('pbi-origin')).toContainText(
      '合成云端订单模型'
    )
    await app.page.screenshot({
      path: testInfo.outputPath('powerbi-origin-dark-1280.png'),
      fullPage: true
    })
    await app.page.getByTestId('analysis-tab-analysis').click()
    await app.page.getByTestId('natural-publish').click()
    await expect(app.page.getByTestId('natural-published')).toBeVisible()
    await unlink(source.path)
    await unlink(joined.path)
    await unlink(mappingFile)
    await app.page.getByTestId('natural-export-report').click()
    const reports = () =>
      app.page.evaluate(async (taskId) => {
        const result = await window.deepchat.invoke('analysis.reports.list', { taskId })
        if (!result.ok) throw new Error(result.error)
        return result.data
      }, taskId)
    for (const [index, format] of ['a4', 'slides'].entries()) {
      await app.page.getByTestId('report-title').fill('Power BI 订单分析-合成验收')
      await app.page.getByTestId('report-format').selectOption(format)
      await app.page.getByTestId('report-create').click()
      await expect.poll(async () => (await reports()).length).toBe(index + 1)
      const report = (await reports())[0]
      await expect
        .poll(async () => (await reports()).find((r) => r.id === report.id)!.status, {
          timeout: 90000
        })
        .not.toBe('rendering')
      const ready = (await reports()).find((r) => r.id === report.id)!
      expect(ready.status, JSON.stringify(ready.attempts)).toBe('ready')
      expect(ready.rendererVersion).toBe(REPORT_RENDERER_VERSION)
      for (const kind of ['pdf', 'evidence'] as const) {
        const target = testInfo.outputPath(
          'powerbi-' + format + (kind === 'pdf' ? '.pdf' : '.json')
        )
        await app.electronApp.evaluate(({ dialog }, filePath) => {
          dialog.showSaveDialog = async () => ({ canceled: false, filePath })
        }, target)
        await app.page
          .getByTestId((kind === 'pdf' ? 'report-save-' : 'report-evidence-') + ready.id)
          .click()
        await expect(app.page.getByTestId('report-notice')).toContainText(target)
        const bytes = await readFile(target)
        if (kind === 'pdf') {
          const parsed = await pdfParse(bytes, { verbosityLevel: 0 })
          expect(parsed.text.replace(/\s/g, '')).toContain("EVALUATE'Orders'")
          expect(parsed.text).toContain('0.3')
          expect(parsed.text).toContain(source.sha256)
        } else {
          expect(createHash('sha256').update(bytes).digest('hex')).toBe(ready.snapshotHash)
          const frozen = JSON.parse(bytes.toString('utf8'))
          expect(frozen.runs[0].source.origin.parents[0].powerBi).toEqual(source.origin!.powerBi)
          expect(bytes.toString()).not.toContain('synthetic-powerbi-access-token')
        }
      }
    }
    await app.close()
    app = await launchApp()
    await waitForAppReady(app.page)
    await installMicrosoftProtocol(app)
    await app.page.getByTestId('sidebar-analysis-button').click()
    const restored = await app.page.evaluate(
      async (taskId) => ({
        auth: await window.deepchat.invoke('analysis.pbi.auth', {}),
        binding: await window.deepchat.invoke('analysis.pbi.binding', { taskId })
      }),
      taskId
    )
    expect(restored.auth.ok && restored.auth.data.account?.username).toBe(
      'powerbi-fixture@example.invalid'
    )
    expect(restored.binding.ok && restored.binding.data?.target.kind).toBe('cloud')
    expect((await getTask()).turns[0].answer.status).toBe('published')
    expect((await reports()).filter((r) => r.status === 'ready')).toHaveLength(2)
    expect(app.pageErrors).toEqual([])
  } finally {
    await app.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('Local native contract -> model choice, schema, preview, lifecycle and exact snapshot @smoke', async ({
  launchApp
}, testInfo) => {
  const app = await launchApp()
  try {
    await waitForAppReady(app.page)
    await app.electronApp.evaluate(({ app }) => {
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
              [path.join(app.getAppPath(), 'test', 'fixtures', 'powerbiBridgeProtocol.cjs')],
              { ...options, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
            )
          : spawn(command, args, options)) as typeof cp.spawn
      module.syncBuiltinESMExports()
    })
    await app.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes('/renderer/'))
        ?.setSize(1440, 1000)
    )
    await app.page.evaluate(() => window.deepchat.invoke('config.setTheme', { theme: 'light' }))
    await app.page.getByTestId('sidebar-analysis-button').click()
    await app.page.getByTestId('analysis-new-task').click()
    await app.page.getByTestId('analysis-connector-localPbi').click()
    await app.page.getByTestId('pbi-discover').click()
    await expect(app.page.getByTestId('pbi-local-model')).toContainText('第二个合成模型')
    await expect(app.page.getByTestId('pbi-bind')).toBeDisabled()
    await app.page.getByTestId('pbi-local-model').selectOption('synthetic-native-model')
    await app.page.getByTestId('pbi-bind').click()
    await app.page.getByTestId('pbi-schema').click()
    await expect(app.page.getByTestId('pbi-schema-result')).toContainText('Orders')
    await app.page.getByTestId('pbi-schema-result').locator('summary').first().click()
    await expect(app.page.getByTestId('pbi-schema-result')).toContainText("SUM('Orders'[Amount])")
    await app.page.getByTestId('pbi-schema-result').locator('select').selectOption('Orders')
    await app.page.getByTestId('pbi-preview').click()
    await expect(app.page.getByTestId('pbi-panel').locator('table')).toContainText(
      '0.10000000000000000000'
    )
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
      await app.page.getByTestId('pbi-dax').focus()
      await app.page.keyboard.press('Tab')
      await app.page.keyboard.press('Shift+Tab')
      const focus = await app.page.getByTestId('pbi-dax').evaluate((el) => ({
        visible: el.matches(':focus-visible'),
        style: getComputedStyle(el).outlineStyle,
        width: getComputedStyle(el).outlineWidth,
        dpr: devicePixelRatio
      }))
      expect(focus.visible).toBe(true)
      expect(focus.style).toBe('solid')
      expect(Math.abs(parseFloat(focus.width) - 2)).toBeLessThanOrEqual(1 / focus.dpr)
      await app.page.getByTestId('pbi-schema-result').scrollIntoViewIfNeeded()
      await app.page.screenshot({
        path: testInfo.outputPath('powerbi-schema-' + theme + '-' + width + '.png'),
        fullPage: true
      })
      expect(
        await app.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
      ).toBe(true)
    }
    await app.page.getByTestId('pbi-dax').fill('EVALUATE DELETED')
    await app.page.getByTestId('pbi-query').click()
    await expect(app.page.getByTestId('pbi-query-feedback')).toContainText('重新发现并连接')
    await assertPowerBiAlertContrast(app)
    await app.page.getByTestId('pbi-dax').fill('EVALUATE SLOW')
    await app.page.getByTestId('pbi-query').click()
    await app.page.getByTestId('pbi-cancel').click()
    await expect(app.page.getByTestId('pbi-query-feedback')).toContainText('本地 Power BI')
    await app.page.getByTestId('pbi-title').fill('本地模型快照')
    await app.page.getByTestId('pbi-dax').fill("EVALUATE 'Orders'")
    await app.page.getByTestId('pbi-query').click()
    await expect(app.page.getByTestId('analysis-preview-table')).toContainText(
      '0.20000000000000000000'
    )
    const task = await app.page.evaluate(async () => {
      const list = await window.deepchat.invoke('analysis.tasks.list', {})
      if (!list.ok) throw new Error(list.error)
      const result = await window.deepchat.invoke('analysis.tasks.get', { taskId: list.data[0].id })
      if (!result.ok) throw new Error(result.error)
      return result.data
    })
    expect(task.sources[0].origin).toMatchObject({
      kind: 'powerbi',
      powerBi: {
        kind: 'local',
        transport: 'adomd',
        precision: 'native_strings',
        schema: { coverage: { measures: 'available' } }
      }
    })
    await writeFile(
      testInfo.outputPath('local-powerbi-contract.json'),
      JSON.stringify(task, null, 2)
    )
    expect(app.pageErrors).toEqual([])
  } finally {
    await app.close()
  }
})
