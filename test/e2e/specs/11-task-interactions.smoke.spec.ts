import { createServer } from 'node:http'
import { mkdir, writeFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from '../fixtures/electronApp'
import { waitForAppReady } from '../helpers/wait'
import { createAnalysisWorkbook } from '../../fixtures/analysisWorkbook'
import type { ModelType } from '../../../src/shared/model'

test('Guide -> real Excel references and text follow-up -> saved drafts and task panel restoration @smoke', async ({
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
    const content = '已读取所选引用，数据来源为当前任务的销售明细。'
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
            .find((w) => w.webContents.getURL().includes('/renderer/'))
            ?.setSize(size[0], size[1])
        },
        [width, height]
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
    await expect(app.page.getByTestId('getting-started-page')).toBeVisible()
    await app.page.getByTestId('getting-started-topic-data').getByRole('button').first().click()
    await app.page.getByTestId('getting-started-source-trigger').click()
    await capture('guide')
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
    await app.page.getByTestId('analysis-answer-value-0').evaluate((element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
    })
    await expect(app.page.getByTestId('analysis-selection-toolbar')).toBeVisible()
    await app.page.getByTestId('analysis-followup-expand').click()
    const editor = () => app.page.getByTestId('chat-input-contenteditable')
    await expect(editor().locator('[data-analysis-context]')).toHaveCount(1)
    await expect(editor()).toContainText('请进一步拆解')
    await editor().press('End')
    await editor().pressSequentially(' @销售额')
    await expect(
      app.page.getByTestId('analysis-reference-option').filter({ hasText: '销售额' }).first()
    ).toBeVisible()
    await capture('reference-menu')
    await app.page
      .getByTestId('analysis-reference-option')
      .filter({ hasText: '销售额' })
      .first()
      .click()
    await expect(editor().locator('[data-analysis-context]')).toHaveCount(2)
    await capture('composer-references')
    await app.page
      .getByTestId('chat-page-shell')
      .getByRole('button', { name: '工作区', exact: true })
      .click()
    await expect
      .poll(() =>
        app.page
          .getByTestId('chat-side-panel-shell')
          .evaluate((element) => element.getBoundingClientRect().width)
      )
      .toBeGreaterThan(0)
    await app.page.getByTestId('analysis-new-task').click()
    await app.page.getByTestId('analysis-tab-files').click()
    const entryId = await app.page.evaluate(async (id) => {
      const result = await window.deepchat.invoke('analysis.workspace.list', {})
      if (!result.ok) throw Error(result.error)
      return result.data.find((entry) => entry.taskId === id)!.id
    }, taskId)
    await app.page.getByTestId('workspace-task-' + entryId).click()
    await expect(editor().locator('[data-analysis-context]')).toHaveCount(2)
    await expect
      .poll(() =>
        app.page
          .getByTestId('chat-side-panel-shell')
          .evaluate((element) => element.getBoundingClientRect().width)
      )
      .toBeGreaterThan(0)
    await capture('restored-panels')
    await app.page.getByTestId('chat-send-button').click()
    await expect(app.page.getByTestId('chat-page')).toContainText('已读取所选引用', {
      timeout: 120000
    })
    expect(read.size).toBe(2)
    expect(outputs.join('\n')).toContain('reference')
    expect(outputs.join('\n')).toContain('quote')
    await app.page.getByTestId('user-message-analysis-context').last().click()
    await expect(app.page.getByTestId('analysis-context-details')).toContainText('销售额')
    await expect
      .poll(() =>
        app.page
          .getByTestId('chat-side-panel-shell')
          .evaluate((element) => element.getBoundingClientRect().width)
      )
      .toBe(0)
    await capture('reference-details')
    await app.page.getByRole('button', { name: '关闭引用详情', exact: true }).click()
    const answer = app.page
      .locator('[data-analysis-quote-origin]')
      .filter({ hasText: '已读取所选引用' })
      .last()
    await answer.evaluate((element) => {
      const paragraph = element.querySelector('p') ?? element
      const range = document.createRange()
      range.selectNodeContents(paragraph)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
    })
    await expect(app.page.getByTestId('analysis-selection-toolbar')).toBeVisible()
    await capture('selection-toolbar')
    await app.page.getByTestId('analysis-followup-why').click()
    await expect(editor()).toContainText('请解释这段结论的依据')
    await expect(editor().locator('[data-analysis-context]')).toHaveCount(1)
    await expect
      .poll(async () =>
        app.page.evaluate(async (taskId) => {
          const result = await window.deepchat.invoke('analysis.panels.get', { taskId })
          return result.ok ? result.data.tab : ''
        }, taskId)
      )
      .toBe('conversation')
    expect(await app.close()).toBe('graceful')
    app = await launchApp()
    observeMain()
    await waitForAppReady(app.page)
    await app.page.getByTestId('sidebar-analysis-button').click()
    await expect(editor()).toContainText('请解释这段结论的依据')
    await expect(editor().locator('[data-analysis-context]')).toHaveCount(1)
    await app.page.getByTestId('analysis-tab-analysis').click()
    await expect(app.page.getByTestId('analysis-mode-manual')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await expect(app.page.getByTestId('analysis-question')).toHaveValue(
      '引用验收：按区域汇总销售额'
    )
    await app.page.getByTestId('analysis-guide-open').click()
    await expect(
      app.page.getByTestId('getting-started-topic-data').getByRole('button').first()
    ).toHaveAttribute('aria-expanded', 'true')
    const guide = await app.page.evaluate(() => window.deepchat.invoke('analysis.guide.get', {}))
    expect(guide.ok && guide.data.exampleOpen).toBe(true)
    await app.page.getByRole('button', { name: '返回工作台', exact: true }).click()
    await app.page.getByTestId('analysis-tab-conversation').click()
    await unlink(file)
    await app.page.getByTestId('user-message-analysis-context').last().click()
    await expect(app.page.getByTestId('analysis-context-details')).toContainText(
      '暂时无法读取此来源'
    )
    await capture('reference-unavailable')
    await writeFile(
      testInfo.outputPath('interaction-native-outputs.json'),
      JSON.stringify({ contextsRead: [...read], outputs }, null, 2)
    )
  } finally {
    await writeFile(testInfo.outputPath('interaction-main-output.log'), mainOutput.join(''))
    await writeFile(
      testInfo.outputPath('last-interaction-dom.html'),
      await app.page
        .getByTestId('analysis-workbench')
        .evaluate((element) => element.outerHTML)
        .catch(() => 'Workbench unmounted')
    )
    await app.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
