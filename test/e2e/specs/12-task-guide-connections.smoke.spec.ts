import { createServer } from 'node:net'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from '../fixtures/electronApp'
import { waitForAppReady } from '../helpers/wait'

test('Guide distinguishes a reachable MySQL binding from files and an unavailable connection @smoke', async ({
  launchApp
}) => {
  const port = Number(process.env.SEMAPATH_GUIDE_MYSQL_PORT)
  test.skip(!port, 'Requires the owned loopback MySQL fixture; no user database is used.')
  const app = await launchApp()
  const captureRoot = process.env.SEMAPATH_GUIDE_CAPTURE_DIR
  const status = (topic: string) =>
    app.page.getByTestId('getting-started-topic-' + topic).locator('.topic-state')
  async function capture(state: string) {
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
            .find((window) => window.webContents.getURL().includes('/renderer/'))
            ?.setSize(size[0], size[1])
        },
        [width, height]
      )
      await app.page.evaluate(
        (theme) => window.deepchat.invoke('config.setTheme', { theme }),
        theme
      )
      await app.page.locator('.analysis-main').evaluate((element) => {
        element.scrollTop = 0
      })
      expect(
        await app.electronApp.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().filter((window) => window.isVisible()).length
        )
      ).toBe(0)
      expect(
        await app.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
      ).toBe(true)
      await app.page.screenshot({
        path: path.join(captureRoot, `${state}-${theme}-${width}.png`),
        fullPage: true,
        animations: 'disabled'
      })
    }
  }
  try {
    await waitForAppReady(app.page)
    await app.page.getByTestId('sidebar-analysis-button').click()
    await app.page.getByTestId('analysis-new-task').click()
    const ids = await app.page.evaluate(async (port) => {
      const tasks = await window.deepchat.invoke('analysis.tasks.list', {})
      if (!tasks.ok) throw Error(tasks.error)
      const taskId = tasks.data[0].id
      const saved = await window.deepchat.invoke('analysis.sql.save', {
        taskId,
        config: {
          name: '仅结构读取的合成 MySQL',
          host: '127.0.0.1',
          port,
          database: 'replica_fixture',
          user: 'replica_reader',
          password: 'synthetic-test-secret',
          tls: false
        }
      })
      if (!saved.ok) throw Error(saved.error)
      const connections = await window.deepchat.invoke('analysis.sql.list', { taskId })
      if (!connections.ok) throw Error(connections.error)
      return { taskId, connectionId: connections.data[0].id }
    }, port)
    await app.page.getByTestId('analysis-guide-open').click()
    await app.page.getByTestId('getting-started-topic-data').getByRole('button').first().click()
    await expect(status('data')).toHaveText('已就绪')
    await expect(status('file')).toHaveText('待完成')
    const sources = await app.page.evaluate(async (taskId) => {
      const task = await window.deepchat.invoke('analysis.tasks.get', { taskId })
      if (!task.ok) throw Error(task.error)
      return task.data.sources.length
    }, ids.taskId)
    expect(sources).toBe(0)
    await capture('guide-mysql-ready')
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const address = closed.address()
    if (!address || typeof address === 'string') throw Error('Closed port fixture unavailable')
    const closedPort = address.port
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    await app.page.evaluate(
      async ({ taskId, connectionId, port }) => {
        const result = await window.deepchat.invoke('analysis.sql.save', {
          taskId,
          config: {
            id: connectionId,
            name: '仅结构读取的合成 MySQL',
            host: '127.0.0.1',
            port,
            database: 'replica_fixture',
            user: 'replica_reader',
            password: 'synthetic-test-secret',
            tls: false
          }
        })
        if (!result.ok) throw Error(result.error)
      },
      { ...ids, port: closedPort }
    )
    await app.page.getByTestId('guide-recheck-data').click()
    await expect(status('data')).toHaveText('暂不可用')
    await expect(status('file')).toHaveText('待完成')
    await expect(app.page.getByTestId('getting-started-topic-data')).toContainText('检查连接或文件')
    await capture('guide-mysql-unavailable')
  } finally {
    await app.close()
  }
})
