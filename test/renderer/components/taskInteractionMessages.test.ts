import { describe, expect, it, vi } from 'vitest'
const { createI18n } = await vi.importActual<typeof import('vue-i18n')>('vue-i18n')
import zh from '@/i18n/zh-CN/analysis.json'
import en from '@/i18n/en-US/analysis.json'

describe('Task interaction messages', () => {
  it.each([
    ['zh-CN', zh],
    ['en-US', en]
  ] as const)('renders the literal @ in %s guide and recovery messages', (locale, messages) => {
    const i18n = createI18n({ legacy: false, locale, messages: { [locale]: messages } })
    expect(i18n.global.t('guide.dataBody')).toContain('@')
    expect(i18n.global.t('errors.ANALYSIS_REFERENCE_STALE')).toContain('@')
    for (const key of Object.keys(messages.references)) {
      if (key !== 'kinds')
        expect(() => i18n.global.t('references.' + key, { label: '销售额' })).not.toThrow()
    }
  })
})
