import { computed, provide, ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { createAnalysisClient } from '@api/AnalysisClient'
import { notifyRenderer } from '@renderer-notifications/rendererNotificationPort'
import { useSpotlightStore } from '@/stores/ui/spotlight'
import { useSidepanelStore } from '@/stores/ui/sidepanel'
import {
  ANALYSIS_INTERACTION_SCOPE,
  ANALYSIS_FOLLOWUP,
  type AnalysisInsertion
} from '@/components/analysis/interactionContext'
import type { AnalysisContext, AnalysisContextViewSchema } from '@shared/analysisInteraction'
import type { z } from 'zod'

export function useAnalysisChatInteraction(options: {
  sessionId: () => string
  taskId: () => string | undefined
  insertion: () => AnalysisInsertion | null | undefined
  preparing: Ref<boolean>
  ready: Ref<boolean>
  readOnly: Ref<boolean>
  insert: (context: AnalysisContext, question: string) => boolean
  inserted: (key: string) => void
  locate: (context: AnalysisContext) => void
}) {
  const { t } = useI18n()
  const client = createAnalysisClient()
  const spotlight = useSpotlightStore()
  const sidepanel = useSidepanelStore()
  const taskId = ref<string | null>(null)
  const detailsOpen = ref(false)
  const detailsLoading = ref(false)
  const detailsError = ref('')
  const detailsView = ref<z.infer<typeof AnalysisContextViewSchema> | null>(null)
  let lookup = 0
  let opening = 0
  let consumed = ''
  watch(
    () => sidepanel.open,
    (open) => {
      if (open && detailsOpen.value) {
        detailsOpen.value = false
        ++opening
      }
    }
  )
  function reportError(error: unknown) {
    const code = error instanceof Error ? error.message : ''
    const known = [
      'ANALYSIS_REFERENCE_STALE',
      'ANALYSIS_REFERENCE_UNAVAILABLE',
      'ANALYSIS_CONTEXT_NOT_FOUND',
      'ANALYSIS_QUOTE_INVALID',
      'ANALYSIS_CONTEXT_LIMIT'
    ]
    notifyRenderer({
      kind: 'error',
      code: 'analysis.interaction.failed',
      title: t('analysis.references.failed'),
      description: t(
        known.includes(code) ? 'analysis.errors.' + code : 'analysis.references.unavailable'
      )
    })
  }
  watch(
    [options.sessionId, options.taskId],
    async ([session, explicit]) => {
      const token = ++lookup
      ++opening
      detailsOpen.value = false
      taskId.value = explicit ?? null
      if (explicit) return
      try {
        const id = await client.workspaceLookup(session)
        if (token === lookup) taskId.value = id
      } catch {
        /* Ordinary conversations need not have an analysis task. */
      }
    },
    { immediate: true }
  )
  async function open(contextId: string) {
    const id = taskId.value
    if (!id) return
    sidepanel.closePanel()
    const token = ++opening
    detailsOpen.value = true
    detailsLoading.value = true
    detailsError.value = ''
    detailsView.value = null
    try {
      const view = await client.context(id, contextId)
      if (token === opening && id === taskId.value) detailsView.value = view
    } catch {
      if (token === opening) detailsError.value = t('analysis.references.unavailable')
    } finally {
      if (token === opening) detailsLoading.value = false
    }
  }
  provide(ANALYSIS_INTERACTION_SCOPE, {
    taskId,
    catalog: (query) => {
      if (!taskId.value) return Promise.resolve({ items: [], total: 0, hasMore: false, issues: [] })
      return client.referenceCatalog(taskId.value, query)
    },
    reference: (reference) => {
      if (!taskId.value || options.readOnly.value) throw new Error('ANALYSIS_REFERENCE_UNAVAILABLE')
      return client.createReference(taskId.value, reference)
    },
    open: (id) => {
      void open(id)
    },
    reportError
  })
  provide(ANALYSIS_FOLLOWUP, {
    async request(origin, text, intent) {
      const id = taskId.value
      const session = options.sessionId()
      if (!id || options.readOnly.value || options.preparing.value) return
      try {
        const context = await client.createQuote(id, origin, text)
        if (id !== taskId.value || session !== options.sessionId()) return
        if (!options.insert(context, t('analysis.followup.questions.' + intent)))
          throw new Error('ANALYSIS_REFERENCE_UNAVAILABLE')
      } catch (error) {
        reportError(error)
      }
    }
  })
  watch(
    [options.insertion, options.preparing, taskId, options.ready, options.readOnly],
    ([insertion, preparing, current, ready]) => {
      if (
        !insertion ||
        !ready ||
        preparing ||
        options.readOnly.value ||
        insertion.key === consumed ||
        insertion.context.taskId !== current
      )
        return
      if (options.insert(insertion.context, insertion.question)) {
        consumed = insertion.key
        options.inserted(insertion.key)
      }
    },
    { flush: 'post', immediate: true }
  )
  function locate(context: AnalysisContext) {
    if (context.quote?.origin.kind === 'message') {
      spotlight.pendingMessageJump = {
        sessionId: options.sessionId(),
        messageId: context.quote.origin.messageId
      }
    } else options.locate(context)
  }
  return {
    detailsOpen,
    detailsLoading,
    detailsError,
    detailsView,
    locate,
    canQuote: computed(() => !!taskId.value && !options.readOnly.value)
  }
}
