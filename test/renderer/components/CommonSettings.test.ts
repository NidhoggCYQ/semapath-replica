import { defineComponent } from 'vue'
import { shallowMount } from '@vue/test-utils'
import { beforeAll, describe, expect, it, vi } from 'vitest'

const uiSettingsStore = vi.hoisted(() => ({
  autoScrollEnabled: true,
  copyWithCotEnabled: false,
  traceDebugEnabled: false,
  launchAtLoginEnabled: false,
  setAutoScrollEnabled: vi.fn(),
  setCopyWithCotEnabled: vi.fn(),
  setTraceDebugEnabled: vi.fn(),
  setLaunchAtLoginEnabled: vi.fn()
}))

vi.mock('@/stores/uiSettingsStore', () => ({
  useUiSettingsStore: () => uiSettingsStore
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key
  })
}))

const toggleRowStub = defineComponent({
  name: 'DcToggleRow',
  props: {
    id: { type: String, required: true },
    description: { type: String, default: '' }
  },
  template: '<div :data-testid="id" :data-description="description" />'
})

const settingsPageShellStub = defineComponent({
  name: 'SettingsPageShell',
  template: '<main><slot /></main>'
})

let CommonSettings: (typeof import('../../../src/renderer/settings/components/CommonSettings.vue'))['default']
beforeAll(async () => {
  CommonSettings = (await import('../../../src/renderer/settings/components/CommonSettings.vue'))
    .default
}, 30000)
describe('CommonSettings', () => {
  it('discloses local request-content persistence beside the Trace setting', () => {
    const wrapper = shallowMount(CommonSettings, {
      global: {
        stubs: {
          DcToggleRow: toggleRowStub,
          SettingsPageShell: settingsPageShellStub,
          UploadFileSettingsSection: true,
          ProxySettingsSection: true,
          CommandShellSettingsSection: true,
          LoggingSettingsSection: true
        }
      }
    })

    expect(wrapper.get('[data-testid="trace-debug-switch"]').attributes('data-description')).toBe(
      'settings.common.traceDebugEnabledDesc'
    )
  })
})
