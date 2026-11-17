import { createServer } from 'node:http'
import { mkdir, writeFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from '../fixtures/electronApp'
import { waitForAppReady } from '../helpers/wait'
import { createAnalysisWorkbook } from '../../fixtures/analysisWorkbook'
import type { ModelType } from '../../../src/shared/model'

test('Suggestions -> structured edit and retry -> independent branch -> persisted delivery and report @smoke', async ({
  launchApp
}, testInfo) => {
  const read = new Set<string>()
  const outputs: string[] = []
  let serial = 0
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({ object: 'list', data: [{ id: 'fixture-chat', object: 'model' }] })
      )
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const names = (body.tools ?? []).map((tool: any) => tool.function?.name)
    const lastUser = [...(body.messages ?? [])].reverse().find((message) => message.role === 'user')
    const ids = [
      ...JSON.stringify(lastUser?.content ?? '').matchAll(/Analysis context: ([a-f0-9-]{36})/g)
    ].map((match) => match[1])
    const next = ids.find((id) => !read.has(id))
    const last = body.messages?.at(-1)
    if (last?.role === 'tool') outputs.push(JSON.stringify(last.content))
    let tool: string | undefined, args: unknown
    if (next && names.includes('analysis_get')) {
      tool = 'analysis_get'
      args = { contextId: next }
      read.add(next)
    } else if (next && names.includes('tool_search')) {
      tool = 'tool_search'
      args = { query: 'analysis_get', limit: 2 }
    }
    const isPrediction = JSON.stringify(body.messages ?? []).includes(
      'Suggest the single most useful next question'
    )
    const content = isPrediction
      ? JSON.stringify({ suggestion: '可以按月份继续比较各区域销售额吗？' })
      : '已读取所选引用，数据来源为当前任务的销售明细。'
    const id = 'interaction-fixture-' + ++serial
    const delta = tool
      ? {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id,
              type: 'function',
              function: { name: tool, arguments: JSON.stringify(args) }
            }
          ]
        }
      : { role: 'assistant', content }
    if (body.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      for (const [data, finish] of [
        [delta, null],
        [{}, tool ? 'tool_calls' : 'stop']
      ] as const)
        response.write(
          'data: ' +
            JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              model: 'fixture-chat',
              choices: [{ index: 0, delta: data, finish_reason: finish }]
            }) +
            '\n\n'
        )
      response.end('data: [DONE]\n\n')
    } else {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          id,
          object: 'chat.completion',
          model: 'fixture-chat',
          choices: [
            {
              index: 0,
              message: tool ? { ...delta, content: null } : delta,
              finish_reason: tool ? 'tool_calls' : 'stop'
            }
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
        })
      )
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Fixture provider missing')
  let app = await launchApp()
  app.page.setDefaultTimeout(30000)
  const mainOutput: string[] = []
  function observeMain() {
    for (const stream of [app.electronApp.process().stdout, app.electronApp.process().stderr]) {
      stream?.on('data', (chunk: Buffer) => {
        mainOutput.push(chunk.toString())
        if (mainOutput.length > 300) mainOutput.shift()
      })
    }
  }
  observeMain()
  const captures = process.env.SEMAPATH_INTERACTION_CAPTURE_DIR
  async function capture(label: string) {
    if (!captures) return
    await mkdir(captures, { recursive: true })
    for (const [width, height, theme] of [
      [1440, 1000, 'light'],
      [1280, 1000, 'dark'],
      [900, 640, 'light']
    ] as const) {
      await app.electronApp.evaluate(
        ({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows()
            .find((w) => w.webContents.getURL() === size.url)
            ?.setSize(size.width, size.height)
        },
        { width, height, url: app.page.url() }
      )
      await app.page.evaluate(
        (theme) => window.deepchat.invoke('config.setTheme', { theme }),
        theme
      )
      if (label === 'guide')
        await app.page.locator('.analysis-main').evaluate((element) => {
          element.scrollTop = 0
        })
      await expect
        .poll(() =>
          app.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
        )
        .toBe(true)
      expect(
        await app.electronApp.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length
        )
      ).toBe(0)
      const model = (await app.page.getByTestId('app-model-switcher').count())
        ? await app.page.getByTestId('app-model-switcher').boundingBox()
        : null
      const permission = (await app.page.getByTestId('chat-permission-mode').count())
        ? await app.page.getByTestId('chat-permission-mode').boundingBox()
        : null
      if (model && permission) {
        expect(
          model.x < permission.x + permission.width &&
            model.x + model.width > permission.x &&
            model.y < permission.y + permission.height &&
            model.y + model.height > permission.y
        ).toBe(false)
      }
      await app.page.screenshot({
        path: path.join(captures, `${label}-${theme}-${width}.png`),
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
    await app.page.evaluate(async (baseUrl) => {
      await window.deepchat.invoke('providers.add', {
        provider: {
          id: 'interaction-fixture',
          name: '合成引用验收',
          apiType: 'openai-completions',
          apiKey: 'synthetic',
          baseUrl,
          enable: true,
          custom: true
        }
      })
      await window.deepchat.invoke('models.addCustom', {
        providerId: 'interaction-fixture',
        model: {
          id: 'fixture-chat',
          name: 'Interaction fixture',
          type: 'chat' as ModelType,
          contextLength: 131072,
          maxTokens: 8192
        }
      })
      await window.deepchat.invoke('models.setStatus', {
        providerId: 'interaction-fixture',
        modelId: 'fixture-chat',
        enabled: true
      })
      const { config } = await window.deepchat.invoke('models.getConfig', {
        providerId: 'interaction-fixture',
        modelId: 'fixture-chat'
      })
      await window.deepchat.invoke('models.setConfig', {
        providerId: 'interaction-fixture',
        modelId: 'fixture-chat',
        config: { ...config, contextLength: 131072, maxTokens: 8192 }
      })
      await window.deepchat.invoke('config.updateEntries', {
        changes: [
          {
            key: 'defaultModel',
            value: { providerId: 'interaction-fixture', modelId: 'fixture-chat' }
          }
        ]
      })
    }, `http://127.0.0.1:${address.port}/v1`)
    await app.page.getByTestId('analysis-new-task').click()
    const taskId = await app.page.evaluate(async () => {
      const result = await window.deepchat.invoke('analysis.tasks.list', {})
      if (!result.ok) throw Error(result.error)
      return result.data[0].id
    })
    const file = testInfo.outputPath('interaction-sales.xlsx')
    await writeFile(file, createAnalysisWorkbook())
    await app.electronApp.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    }, file)
    await app.page.getByTestId('analysis-add-files').click()
    await expect(app.page.getByTestId('analysis-preview-table')).toContainText('销售额')
    await app.page.getByTestId('analysis-tab-analysis').click()
    await app.page.getByTestId('analysis-mode-manual').click()
    await app.page.getByTestId('analysis-measure').selectOption('C')
    await app.page.getByTestId('analysis-group').selectOption('B')
    await app.page.getByTestId('analysis-question').fill('引用验收：按区域汇总销售额')
    await app.page.getByTestId('analysis-unit').fill('元')
    await app.page.getByTestId('analysis-calculate').click()
    await expect(app.page.getByTestId('analysis-answer-value-0')).toHaveText(/0\.3\s*元/)

    await app.page.getByTestId('analysis-publish').click()
    await expect(app.page.getByTestId('analysis-published')).toBeVisible()
    const parentBefore = await app.page.evaluate(async (taskId) => {
      const result = await window.deepchat.invoke('analysis.tasks.get', { taskId })
      if (!result.ok) throw Error(result.error)
      return result.data
    }, taskId)
    await app.page.getByTestId('analysis-tab-conversation').click()
    const editor = () => app.page.getByTestId('chat-input-contenteditable')
    await expect(editor()).toBeVisible()
    await editor().pressSequentially('请核对 @销售额')
    await app.page
      .getByTestId('analysis-reference-option')
      .filter({ hasText: '销售额' })
      .first()
      .click()
    await expect(editor().locator('[data-analysis-context]')).toHaveCount(1)
    await app.page.getByTestId('chat-send-button').click()
    await expect(app.page.getByTestId('chat-message-assistant').last()).toContainText(
      '已读取所选引用'
    )
    await expect(app.page.getByTestId('composer-prediction')).toContainText('按月份')
    const count = await app.page.getByTestId('chat-message-user').count()
    await capture('suggestion')
    await editor().focus()
    await editor().press('Tab')
    await expect(editor()).toContainText('按月份')
    expect(await app.page.getByTestId('chat-message-user').count()).toBe(count)
    await editor().press('ControlOrMeta+A')
    await editor().press('Backspace')
    await expect(app.page.getByTestId('composer-prediction')).toHaveCount(0)
    const user = () => app.page.getByTestId('chat-message-user').first()
    await user().hover()
    await user().getByRole('button', { name: '编辑消息', exact: true }).click()
    const edit = app.page.getByTestId('message-edit-input').getByRole('textbox')
    await expect(edit.locator('[data-analysis-context]')).toHaveCount(1)
    await edit.press('Home')
    await edit.pressSequentially('请重新检查：')
    await capture('edited-message')
    await user().getByRole('button', { name: '保存', exact: true }).click()
    await expect(user()).toContainText('请重新检查')
    await expect(user().getByTestId('user-message-analysis-context')).toHaveCount(1)
    await expect(app.page.getByTestId('composer-prediction')).toBeVisible()
    await editor().focus()
    await editor().press('Escape')
    await expect(app.page.getByTestId('composer-prediction')).toHaveCount(0)
    const sessionId = await app.page.evaluate(async (taskId) => {
      const r = await window.deepchat.invoke('analysis.workspace.chat', { taskId })
      if (!r.ok) throw Error(r.error)
      return r.data
    }, taskId)
    const beforeRetry = await app.page
      .getByTestId('chat-message-assistant')
      .last()
      .getAttribute('data-message-id')
    await app.page.getByTestId('chat-message-assistant').last().hover()
    await app.page
      .getByTestId('chat-message-assistant')
      .last()
      .getByRole('button', { name: '重新生成', exact: true })
      .click()
    await expect
      .poll(() =>
        app.page.getByTestId('chat-message-assistant').last().getAttribute('data-message-id')
      )
      .not.toBe(beforeRetry)
    await expect(app.page.getByTestId('composer-prediction')).toBeVisible()
    expect(await app.page.getByTestId('chat-message-user').count()).toBe(count)
    await app.page.evaluate(() =>
      window.deepchat.invoke('settings.update', {
        changes: [{ key: 'traceDebugEnabled', value: true }]
      })
    )
    await app.page.getByTestId('chat-message-assistant').last().hover()
    await app.page.getByTestId('message-delivery-action').last().click()
    await expect(app.page.getByTestId('message-delivery-trace')).toContainText('原生端首次更新')
    await expect(app.page.getByTestId('message-delivery-trace')).toContainText('客户端')
    await capture('delivery')
    await app.page.keyboard.press('Escape')
    await app.page.getByTestId('chat-message-assistant').last().hover()
    const parentAtFork = await app.page.evaluate(async (taskId) => {
      const r = await window.deepchat.invoke('analysis.tasks.get', { taskId })
      if (!r.ok) throw Error(r.error)
      return r.data
    }, taskId)
    await app.page
      .getByTestId('chat-message-assistant')
      .last()
      .getByRole('button', { name: '分叉到新会话', exact: true })
      .click()
    await expect(app.page.getByTestId('analysis-branch-notice')).toBeVisible()
    await expect(editor()).toBeVisible()
    const branchTask = await app.page.evaluate(async (parent) => {
      const r = await window.deepchat.invoke('analysis.tasks.list', {})
      if (!r.ok) throw Error(r.error)
      const id = r.data.find((t) => t.id !== parent)!.id
      const full = await window.deepchat.invoke('analysis.tasks.get', { taskId: id })
      if (!full.ok) throw Error(full.error)
      return full.data
    }, taskId)
    expect(branchTask.runs.map((r) => r.id)).toEqual(parentBefore.runs.map((r) => r.id))
    await capture('branch')
    await editor().pressSequentially('继续核对分支数据')
    await app.page.getByTestId('chat-send-button').click()
    await expect(app.page.getByTestId('chat-message-user')).toHaveCount(count + 1)
    await expect(app.page.getByTestId('composer-prediction')).toBeVisible()
    const first = app.page.getByTestId('chat-message-user').first()
    await first.hover()
    await first.getByRole('button', { name: '编辑消息', exact: true }).click()
    await expect(
      app.page.getByTestId('message-edit-input').locator('[data-analysis-context]')
    ).toHaveCount(1)
    await first.getByRole('button', { name: '取消', exact: true }).click()
    await first.getByTestId('user-message-analysis-context').click()
    await expect(app.page.getByTestId('analysis-context-details')).toContainText('销售额')
    await app.page.getByRole('button', { name: '关闭引用详情', exact: true }).click()
    const parentAfter = await app.page.evaluate(async (taskId) => {
      const r = await window.deepchat.invoke('analysis.tasks.get', { taskId })
      if (!r.ok) throw Error(r.error)
      return r.data
    }, taskId)
    expect(parentAfter).toEqual(parentAtFork)
    const parentMessages = await app.page.evaluate(
      async (sessionId) =>
        window.deepchat.invoke('sessions.listMessagesPage', { sessionId, limit: 50 }),
      sessionId
    )
    expect(parentMessages.messages.filter((m) => m.role === 'user')).toHaveLength(count)
    await app.page.getByTestId('analysis-tab-analysis').click()
    await app.page.getByTestId('analysis-export-report').click()
    await app.page.getByTestId('report-create').click()
    await expect
      .poll(
        async () =>
          app.page.evaluate(async (taskId) => {
            const r = await window.deepchat.invoke('analysis.reports.list', { taskId })
            return r.ok ? r.data[0]?.status : ''
          }, branchTask.id),
        { timeout: 90000 }
      )
      .toBe('ready')
    await app.page.getByTestId('analysis-tab-conversation').click()
    await app.page.getByTestId('chat-message-user').last().hover()
    await app.page
      .getByTestId('chat-message-user')
      .last()
      .getByRole('button', { name: '删除消息', exact: true })
      .click()
    await capture('delete-dialog')
    await app.page
      .getByRole('alertdialog')
      .getByRole('button', { name: '取消', exact: true })
      .click()
    expect(await app.page.getByTestId('chat-message-user').count()).toBe(count + 1)
    await app.page
      .getByTestId('chat-message-user')
      .last()
      .getByRole('button', { name: '删除消息', exact: true })
      .click()
    await app.page
      .getByRole('alertdialog')
      .getByRole('button', { name: '删除消息', exact: true })
      .click()
    await expect(app.page.getByTestId('chat-message-user')).toHaveCount(count)
    await app.page.evaluate(() =>
      window.deepchat.invoke('settings.update', {
        changes: [{ key: 'composerPredictionsEnabled', value: false }]
      })
    )
    await expect(app.page.getByTestId('composer-prediction')).toHaveCount(0)
    expect(await app.close()).toBe('graceful')
    app = await launchApp()
    observeMain()
    await waitForAppReady(app.page)
    await app.page.getByTestId('sidebar-analysis-button').click()
    await expect(app.page.getByTestId('analysis-branch-notice')).toBeVisible()
    await expect(app.page.getByTestId('chat-message-user')).toHaveCount(count)
    const settings = await app.page.evaluate(() =>
      window.deepchat.invoke('settings.getSnapshot', { keys: ['composerPredictionsEnabled'] })
    )
    expect(settings.values.composerPredictionsEnabled).toBe(false)
    await capture('branch-restored')
    await unlink(file)
    const oldId = await app.page
      .getByTestId('chat-message-assistant')
      .last()
      .getAttribute('data-message-id')
    await app.page.getByTestId('chat-message-assistant').last().hover()
    await app.page
      .getByTestId('chat-message-assistant')
      .last()
      .getByRole('button', { name: '重新生成', exact: true })
      .click()
    await expect(
      app.page.getByText('消息操作未完成，请重试。', { exact: true }).last()
    ).toBeVisible()
    await expect(app.page.getByTestId('chat-message-assistant').last()).toHaveAttribute(
      'data-message-id',
      oldId!
    )
    await capture('reference-retry-blocked')
    const mainPage = app.page
    const settingsOpened = app.electronApp.waitForEvent('window')
    await mainPage.evaluate(() =>
      window.deepchat.invoke('system.openSettings', { routeName: 'settings-common' })
    )
    const settingsPage = await settingsOpened
    settingsPage.setDefaultTimeout(30000)
    await expect(settingsPage.getByTestId('prediction-settings')).toBeVisible()
    app.page = settingsPage
    await capture('prediction-settings-disabled')
    await settingsPage.locator('#composer-predictions-switch').click()
    await expect(settingsPage.getByTestId('prediction-model')).toBeVisible()
    await mainPage.evaluate(() =>
      window.deepchat.invoke('settings.update', {
        changes: [
          {
            key: 'composerPredictionSettings',
            value: {
              model: { providerId: 'missing-provider', modelId: 'missing-model' },
              reasoning: { mode: 'auto' }
            }
          }
        ]
      })
    )
    const prediction = await mainPage.evaluate(async (taskId) => {
      const w = await window.deepchat.invoke('analysis.workspace.chat', { taskId })
      if (!w.ok) throw Error(w.error)
      const p = await window.deepchat.invoke('sessions.listMessagesPage', {
        sessionId: w.data,
        limit: 10
      })
      return await window.deepchat.invoke('sessions.getComposerPrediction', {
        sessionId: w.data,
        messageId: p.messages.at(-1)!.id
      })
    }, branchTask.id)
    expect(prediction.suggestion).toContain('按月份')
    await expect(settingsPage.getByTestId('prediction-settings')).toContainText(
      '已使用当前会话模型生成建议'
    )
    await capture('prediction-settings-fallback')
    await settingsPage.getByRole('button', { name: '跟随当前会话模型', exact: true }).click()
    await expect(settingsPage.getByTestId('prediction-model')).toHaveText('跟随当前会话模型')
    await settingsPage.locator('#composer-predictions-switch').click()
    await expect(mainPage.getByTestId('composer-prediction')).toHaveCount(0)
    app.page = mainPage
    await settingsPage.close()
    await writeFile(
      testInfo.outputPath('message-verification.json'),
      JSON.stringify(
        { taskId, branchTaskId: branchTask.id, contextsRead: [...read], outputs },
        null,
        2
      )
    )
  } finally {
    await writeFile(testInfo.outputPath('messages-main.log'), mainOutput.join(''))
    await writeFile(
      testInfo.outputPath('messages-dom.html'),
      await app.page.content().catch(() => '')
    )
    await app.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
