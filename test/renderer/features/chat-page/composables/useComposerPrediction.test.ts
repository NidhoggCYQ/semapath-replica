import { describe, it, expect, vi, afterEach } from 'vitest'
import { effectScope, ref, nextTick } from 'vue'
import { useComposerPrediction } from '@/features/chat-page/composables/useComposerPrediction'

afterEach(() => vi.useRealTimers())
describe('follow-up suggestion lifecycle', () => {
  it('debounces, suppresses drafts, ignores late responses, and remembers Esc dismissal per answer', async () => {
    vi.useFakeTimers()
    const context = ref({ sessionId: 's1', messageId: 'a1', revision: '1' })
    const draft = ref(false)
    const enabled = ref(true)
    let finish!: (value: { suggestion: string }) => void
    const fetch = vi.fn(
      () =>
        new Promise<{ suggestion: string }>((r) => {
          finish = r
        })
    )
    const scope = effectScope()
    const state = scope.run(() =>
      useComposerPrediction({ context: () => context.value, hasDraft: draft, enabled, fetch })
    )!
    await vi.advanceTimersByTimeAsync(399)
    expect(fetch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    draft.value = true
    finish({ suggestion: '旧建议' })
    await nextTick()
    expect(state.suggestion.value).toBe('')
    draft.value = false
    await vi.advanceTimersByTimeAsync(500)
    expect(fetch).toHaveBeenCalledTimes(1)
    context.value = { sessionId: 's2', messageId: 'a2', revision: '1' }
    await vi.advanceTimersByTimeAsync(400)
    finish({ suggestion: '新建议' })
    await vi.advanceTimersByTimeAsync(1)
    expect(state.suggestion.value).toBe('新建议')
    state.dismiss()
    enabled.value = false
    enabled.value = true
    await vi.advanceTimersByTimeAsync(500)
    expect(state.suggestion.value).toBe('')
    expect(fetch).toHaveBeenCalledTimes(2)
    scope.stop()
  })
})
