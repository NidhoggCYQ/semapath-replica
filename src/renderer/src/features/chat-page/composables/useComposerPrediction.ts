import { computed, ref, watch, toValue, type MaybeRefOrGetter } from 'vue'

export function useComposerPrediction(options: {
  context: () => { sessionId: string; messageId: string; revision: string } | null
  enabled: MaybeRefOrGetter<boolean>
  hasDraft: MaybeRefOrGetter<boolean>
  fetch: (sessionId: string, messageId: string) => Promise<{ suggestion: string | null }>
}) {
  const suggestion = ref('')
  const context = computed(options.context)
  const key = computed(() => (context.value ? JSON.stringify(context.value) : ''))
  const entries = new Map<
    string,
    { dismissed: boolean; result?: Promise<{ suggestion: string | null }> }
  >()
  function dismiss() {
    suggestion.value = ''
    if (!key.value) return
    const entry = entries.get(key.value)
    if (entry) entry.dismissed = true
    else entries.set(key.value, { dismissed: true })
    if (entries.size > 100) entries.delete(entries.keys().next().value!)
  }
  watch(
    [key, () => toValue(options.enabled), () => toValue(options.hasDraft)] as const,
    ([id, enabled, draft], _, cleanup) => {
      suggestion.value = ''
      if (!id) return
      if (draft) {
        dismiss()
        return
      }
      if (!enabled) return
      let entry = entries.get(id)
      if (entry?.dismissed) return
      if (!entry) {
        entry = { dismissed: false }
        entries.set(id, entry)
        if (entries.size > 100) entries.delete(entries.keys().next().value!)
      }
      const captured = entry
      const target = context.value!
      let stale = false
      const timer = setTimeout(async () => {
        captured.result ??= options
          .fetch(target.sessionId, target.messageId)
          .catch(() => ({ suggestion: null }))
        const result = await captured.result
        if (!stale && !captured.dismissed && key.value === id)
          suggestion.value = result.suggestion ?? ''
      }, 400)
      cleanup(() => {
        stale = true
        clearTimeout(timer)
      })
    },
    { immediate: true, flush: 'sync' }
  )
  return { suggestion, dismiss }
}
