import { beforeEach, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { GuideStateSchema } from '@shared/analysisInteraction'
import TaskGettingStarted from '@/components/analysis/TaskGettingStarted.vue'
const mocks = vi.hoisted(() => ({
  catalog: vi.fn(),
  guide: vi.fn(),
  models: vi.fn(),
  save: vi.fn()
}))
vi.mock('@api/AnalysisClient', () => ({
  createAnalysisClient: () => ({
    referenceCatalog: mocks.catalog,
    guide: mocks.guide,
    models: mocks.models,
    saveGuide: mocks.save
  })
}))
beforeEach(() => {
  mocks.guide.mockResolvedValue(GuideStateSchema.parse({}))
  mocks.models.mockResolvedValue([])
  mocks.save.mockResolvedValue(GuideStateSchema.parse({}))
})
const status = (wrapper: ReturnType<typeof mount>, topic: string) =>
  wrapper.get(`[data-testid="getting-started-topic-${topic}"] .topic-state`).text()
it.each(['mysql', 'powerbi'])(
  'counts an available %s binding without claiming a local file exists',
  async (kind) => {
    mocks.catalog.mockResolvedValue({
      items: [{ kind: 'source', selector: { targetId: kind + ':fixture' } }],
      issues: [],
      hasMore: false,
      total: 1
    })
    const wrapper = mount(TaskGettingStarted, {
      props: { taskId: 'task', hasTask: true, hasFiles: false, hasResults: false }
    })
    await flushPromises()
    expect(status(wrapper, 'data')).toBe('analysis.guide.ready')
    expect(status(wrapper, 'file')).toBe('analysis.guide.pending')
    wrapper.unmount()
  }
)
it('shows an unavailable connection and allows a fresh check without changing file status', async () => {
  mocks.catalog.mockResolvedValueOnce({
    items: [],
    issues: [{ source: 'SQL', code: 'SQL_CONNECTION_FAILED' }],
    hasMore: false,
    total: 0
  })
  const wrapper = mount(TaskGettingStarted, {
    props: { taskId: 'task', hasTask: true, hasFiles: false, hasResults: false }
  })
  await flushPromises()
  expect(status(wrapper, 'data')).toBe('analysis.guide.unavailable')
  expect(status(wrapper, 'file')).toBe('analysis.guide.pending')
  await wrapper.get('[data-testid="getting-started-topic-data"] button').trigger('click')
  mocks.catalog.mockResolvedValueOnce({
    items: [{ selector: { targetId: 'mysql:fixture' } }],
    issues: [],
    hasMore: false,
    total: 1
  })
  await wrapper.get('[data-testid="guide-recheck-data"]').trigger('click')
  await flushPromises()
  expect(status(wrapper, 'data')).toBe('analysis.guide.ready')
  wrapper.unmount()
})
it('keeps valid local files usable when another connection is unavailable', async () => {
  mocks.catalog.mockResolvedValue({
    items: [{ selector: { sourceId: 'file' } }],
    issues: [{ source: 'SQL', code: 'SQL_CONNECTION_FAILED' }],
    hasMore: false,
    total: 1
  })
  const wrapper = mount(TaskGettingStarted, {
    props: { taskId: 'task', hasTask: true, hasFiles: true, hasResults: false }
  })
  await flushPromises()
  expect(status(wrapper, 'data')).toBe('analysis.guide.partial')
  expect(status(wrapper, 'file')).toBe('analysis.guide.ready')
  wrapper.unmount()
})
