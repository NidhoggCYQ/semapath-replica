import path from 'node:path'
import { test, expect } from '../fixtures/electronApp'
import { waitForAppReady } from '../helpers/wait'

test('replica launches with isolated identity and storage @smoke', async ({ app }, testInfo) => {
  await waitForAppReady(app.page)
  const identity = await app.electronApp.evaluate(({ app }) => ({
    name: app.getName(),
    userData: app.getPath('userData'),
    chromium: app.getPath('sessionData'),
    version: app.getVersion(),
    commandSearchPath: process.env.PATH,
    home: process.env.SEMAPATH_REPLICA_HOME
  }))
  expect(identity.name).toBe('SemaPath Replica')
  expect(identity.version).toBe('0.1.0-beta.1')
  expect(identity.commandSearchPath?.split(path.delimiter)).toContain(
    path.join(app.userDataDir, 'bin')
  )
  expect(identity.userData).toBe(app.userDataDir)
  expect(identity.chromium).toBe(path.join(app.userDataDir, 'chromium'))
  expect(identity.home).toBe(path.join(app.userDataDir, 'replica-home'))
  await expect(app.page.getByTestId('app-main')).toBeVisible()
  await expect(app.page.getByTestId('analysis-workbench')).toBeVisible()
  await expect(app.page.getByTestId('window-sidebar')).toBeVisible()
  await app.page.screenshot({ path: testInfo.outputPath('replica-launch.png'), fullPage: true })
  expect(await app.close()).toBe('graceful')
})
