import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  PRODUCT_APP_ID,
  PRODUCT_NAME,
  PRODUCT_PROTOCOL,
  PRODUCT_UPDATES_ENABLED
} from '@shared/productIdentity'
import { getProductHomePath, getProductUserDataPath } from '@/app/productPaths'
import { isDeepLinkUrl } from '@/lib/startupDeepLink'
import type { UpdateSettings } from '@/upgrade/settings'

vi.mock('electron-updater', () => ({
  default: {
    autoUpdater: {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      on: vi.fn(),
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(),
      quitAndInstall: vi.fn()
    }
  }
}))

import electronUpdater from 'electron-updater'
import { UpgradeService } from '@/upgrade'

describe('replica product isolation', () => {
  it('uses independent product and profile namespaces', () => {
    expect(PRODUCT_NAME).toBe('SemaPath Replica')
    expect(PRODUCT_APP_ID).not.toBe('com.wefonk.deepchat')
    expect(getProductUserDataPath(path.resolve('app-data'))).toBe(
      path.resolve('app-data', 'SemaPathReplicaDev')
    )
    expect(getProductHomePath(path.resolve('test-home'), {})).toBe(
      path.resolve('test-home', '.semapath-replica')
    )
  })

  it('supports absolute external development profiles and rejects ambiguous relative overrides', () => {
    const profile = path.resolve('external-cache', 'profile')
    const home = path.join(profile, 'home')
    expect(getProductUserDataPath(path.resolve('app-data'), profile)).toBe(profile)
    expect(getProductHomePath(path.resolve('test-home'), { SEMAPATH_REPLICA_HOME: home })).toBe(
      home
    )
    expect(() => getProductUserDataPath(path.resolve('app-data'), '../other-profile')).toThrow(
      'absolute'
    )
    expect(() =>
      getProductHomePath(path.resolve('test-home'), { SEMAPATH_REPLICA_HOME: 'relative' })
    ).toThrow('absolute')
  })

  it('recognizes its own deep links without mistaking an embedded URL for a launch request', () => {
    expect(isDeepLinkUrl(PRODUCT_PROTOCOL + '://start?msg=hello')).toBe(true)
    expect(isDeepLinkUrl('https://example.com/?next=' + PRODUCT_PROTOCOL + '://start')).toBe(false)
    expect(isDeepLinkUrl('deepchat://start')).toBe(true)
  })

  it('cannot check, download, open upstream releases or install an upstream update', async () => {
    expect(PRODUCT_UPDATES_ENABLED).toBe(false)
    const publish = vi.fn()
    const install = vi.fn()
    const settings = {
      getChannel: () => 'stable',
      setChannel: vi.fn()
    } as unknown as UpdateSettings
    const service = new UpgradeService(settings, () => false, install, publish)
    service.handleAppFocus()
    await service.checkUpdate('manualCheck')
    await service.goDownloadUpgrade('github')
    expect(service.startDownloadUpdate()).toBe(false)
    expect(service.restartToUpdate()).toBe(false)
    expect(electronUpdater.autoUpdater.autoInstallOnAppQuit).toBe(false)
    expect(electronUpdater.autoUpdater.on).not.toHaveBeenCalled()
    expect(electronUpdater.autoUpdater.checkForUpdates).not.toHaveBeenCalled()
    expect(electronUpdater.autoUpdater.downloadUpdate).not.toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()
    expect(service.getUpdateStatus().status).toBe('not-available')
  })
})
