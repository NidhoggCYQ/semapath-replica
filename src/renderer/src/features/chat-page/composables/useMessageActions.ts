import type { MessageEditPayload } from '@/features/chat-page/model/displayMessage'
import { computed, ref, shallowReactive, type ComputedRef } from 'vue'
import type { useMessageStore } from '@/stores/ui/message'
import type { useSessionStore } from '@/stores/ui/session'
import type {
  UserMessageInlineItem,
  AttachmentFallbackPolicy,
  AttachmentPreparationSummary
} from '@shared/types/agent-interface'
import type { RendererNotificationNotifier } from '@renderer-notifications/rendererNotificationPort'

type MessageStore = ReturnType<typeof useMessageStore>
type SessionStore = ReturnType<typeof useSessionStore>

type SessionClientLike = {
  retryMessage: (
    sessionId: string,
    messageId: string,
    options?: { attachmentFallbackPolicy?: AttachmentFallbackPolicy }
  ) => Promise<
    | {
        accepted?: boolean
        attachmentPreparation?: AttachmentPreparationSummary
      }
    | undefined
  >
  deleteMessage: (sessionId: string, messageId: string) => Promise<unknown>
  editUserMessage: (
    sessionId: string,
    messageId: string,
    text: string,
    inlineItems?: UserMessageInlineItem[]
  ) => Promise<unknown>
  forkSession: (sessionId: string, messageId: string) => Promise<{ id: string }>
}

type ChatClientLike = {
  sendMessage: (sessionId: string, content: string) => Promise<{ accepted?: boolean } | undefined>
}

type UseMessageActionsOptions = {
  sessionId: () => string
  isGenerating?: () => boolean
  forked?: (sessionId: string) => Promise<void>
  isReadOnlySession: ComputedRef<boolean>
  hasBlockingInteraction: () => boolean
  messageStore: MessageStore
  sessionStore: SessionStore
  sessionClient: SessionClientLike
  chatClient: ChatClientLike
  beginPlanTurn: (sessionId: string) => void
  clearPlanSnapshotForDeletedMessage: (sessionId: string, messageId: string) => void
  loadMessagesForSession: (sessionId: string, count?: number) => Promise<unknown>
  applyRestoredSessionSummary: (session: unknown) => void
  currentRestoreRequestId: () => number
  canWriteSessionView: (sessionId: string, requestId: number) => boolean
  openModelPicker: () => void
  notify: RendererNotificationNotifier
  t: (key: string) => string
}

/**
 * Owns message-level user actions while preserving their existing retry,
 * confirmation, and refresh semantics. The page remains responsible for the
 * session-change lifecycle and calls clearForSessionChange at that boundary.
 */
export function useMessageActions(options: UseMessageActionsOptions) {
  const pendingDeleteMessageId = ref<string | null>(null)
  let pendingDeleteSessionId: string | null = null
  const isForking = ref(false)
  const blockedRetryAttempt = ref<{ sessionId: string; messageId: string } | null>(null)
  const retryAttachmentPreparationSummary = ref<AttachmentPreparationSummary | null>(null)
  const activeRetrySessionIds = shallowReactive(new Set<string>())
  const isRetryingAttachments = computed(() => activeRetrySessionIds.has(options.sessionId()))
  const showDeleteMessageDialog = computed(() => Boolean(pendingDeleteMessageId.value))

  function reportFailure(code: string, error?: unknown) {
    const message = error instanceof Error ? error.message : ''
    const analysisCode = [
      'ANALYSIS_CONTEXT_NOT_FOUND',
      'ANALYSIS_CONTEXT_LIMIT',
      'ANALYSIS_REFERENCE_STALE',
      'ANALYSIS_REFERENCE_UNAVAILABLE'
    ].find((c) => message.includes(c))
    options.notify({
      kind: 'error',
      code,
      title: options.t('chat.messageActions.failed'),
      description: options.t(
        analysisCode ? 'analysis.errors.' + analysisCode : 'common.error.requestFailed'
      )
    })
  }
  function ownsMessage(messageId: string, sessionId = options.sessionId()) {
    const target = options.messageStore.messageCache.get(messageId)
    return !target || target.sessionId === sessionId
  }
  function mutationBlocked() {
    if (options.isReadOnlySession.value || options.hasBlockingInteraction()) return true
    if (options.isGenerating?.()) {
      options.notify({
        kind: 'warning',
        code: 'chat.message.busy',
        title: options.t('chat.messageActions.busy')
      })
      return true
    }
    return false
  }

  async function refreshAfterRetryFailure(sessionId: string, requestId: number) {
    const restoredSession = await options.loadMessagesForSession(sessionId)
    if (!options.canWriteSessionView(sessionId, requestId)) return
    options.applyRestoredSessionSummary(restoredSession)
  }

  async function retryMessage(
    messageId: string,
    errorMessage: string,
    blocksInteraction: boolean,
    sessionId = options.sessionId(),
    attachmentFallbackPolicy?: AttachmentFallbackPolicy
  ) {
    if (
      (sessionId === options.sessionId() && mutationBlocked()) ||
      !messageId ||
      !ownsMessage(messageId, sessionId)
    )
      return
    if (blocksInteraction && options.hasBlockingInteraction()) return
    if (activeRetrySessionIds.has(sessionId)) return

    const requestId = options.currentRestoreRequestId()
    try {
      activeRetrySessionIds.add(sessionId)
      if (options.canWriteSessionView(sessionId, requestId))
        options.messageStore.clearStreamingState()
      // The main process truncates from the retried message onward (the user
      // prompt survives) and re-streams with fresh ids. Mirror that in the UI
      // BEFORE the IPC: the main starts streaming before the retry IPC resolves,
      // so an after-await truncation would leave the stale rows visible under
      // the new stream. When the retried message IS the user prompt, keep it in
      // place and truncate from the next order sequence instead. The blocked/
      // failure paths below restore via a reload.
      const target = options.messageStore.messageCache.get(messageId)
      // Optimistic truncation shortens messageIds; remember the pre-truncation
      // window so a blocked retry can restore the full loaded view.
      const priorMessageCount = options.messageStore.messageIds.length
      if (target) {
        const fromOrderSeq = target.role === 'user' ? target.orderSeq + 1 : target.orderSeq
        options.messageStore.truncateMessagesFromOrderSeq(sessionId, fromOrderSeq)
      }

      const result = attachmentFallbackPolicy
        ? await options.sessionClient.retryMessage(sessionId, messageId, {
            attachmentFallbackPolicy
          })
        : await options.sessionClient.retryMessage(sessionId, messageId)
      if (result?.accepted === false) {
        if (options.canWriteSessionView(sessionId, requestId)) {
          blockedRetryAttempt.value = { sessionId, messageId }
          retryAttachmentPreparationSummary.value =
            result.attachmentPreparation ?? fallbackPreparationSummary()
          // A blocked retry did not delete anything; bring the optimistically
          // removed rows back with the same window that was visible before.
          await options.loadMessagesForSession(sessionId, priorMessageCount)
        }
        return
      }
      options.beginPlanTurn(sessionId)
      if (blockedRetryAttempt.value?.sessionId === sessionId) {
        blockedRetryAttempt.value = null
        retryAttachmentPreparationSummary.value = null
      }
    } catch (error) {
      console.error(errorMessage, error)
      if (!options.canWriteSessionView(sessionId, requestId)) return
      reportFailure('chat.message.retryFailed', error)
      await refreshAfterRetryFailure(sessionId, requestId)
    } finally {
      activeRetrySessionIds.delete(sessionId)
    }
  }

  function fallbackPreparationSummary(): AttachmentPreparationSummary {
    return {
      status: 'needs_user_action',
      issues: [],
      suggestedActions: ['retry', 'send_without_image_content']
    }
  }

  async function onMessageRetry(messageId: string, sessionId = options.sessionId()) {
    await retryMessage(messageId, '[ChatPage] retry message failed:', true, sessionId)
  }

  async function retryBlockedMessage(): Promise<void> {
    const attempt = blockedRetryAttempt.value
    if (
      !attempt ||
      !options.canWriteSessionView(attempt.sessionId, options.currentRestoreRequestId())
    ) {
      cancelBlockedMessageRetry()
      return
    }
    await retryMessage(
      attempt.messageId,
      '[ChatPage] retry message failed:',
      true,
      attempt.sessionId
    )
  }

  async function retryBlockedMessageWithoutImageContent(): Promise<void> {
    const attempt = blockedRetryAttempt.value
    if (
      !attempt ||
      !options.canWriteSessionView(attempt.sessionId, options.currentRestoreRequestId())
    ) {
      cancelBlockedMessageRetry()
      return
    }
    await retryMessage(
      attempt.messageId,
      '[ChatPage] retry message without image content failed:',
      true,
      attempt.sessionId,
      'send_without_image_content'
    )
  }

  function cancelBlockedMessageRetry(): void {
    if (isRetryingAttachments.value) return
    blockedRetryAttempt.value = null
    retryAttachmentPreparationSummary.value = null
  }

  function switchRetryToVisionModel(): void {
    cancelBlockedMessageRetry()
    options.openModelPicker()
  }

  async function onMessageDelete(messageId: string) {
    if (options.isReadOnlySession.value || !messageId) return
    if (mutationBlocked() || !ownsMessage(messageId)) return
    pendingDeleteSessionId = options.sessionId()
    pendingDeleteMessageId.value = messageId
  }

  async function confirmMessageDelete() {
    const messageId = pendingDeleteMessageId.value
    if (!messageId || options.isReadOnlySession.value) return

    const sessionId = pendingDeleteSessionId
    if (!sessionId || sessionId !== options.sessionId() || mutationBlocked()) return
    const requestId = options.currentRestoreRequestId()
    pendingDeleteMessageId.value = null
    pendingDeleteSessionId = null
    try {
      options.messageStore.clearStreamingState()
      await options.sessionClient.deleteMessage(sessionId, messageId)
      // Plan snapshots are stored per session id, not per view; clean up even
      // when the user switched sessions while the confirm dialog was open.
      options.clearPlanSnapshotForDeletedMessage(sessionId, messageId)
      if (!options.canWriteSessionView(sessionId, requestId)) return
      const restoredSession = await options.loadMessagesForSession(sessionId)
      if (!options.canWriteSessionView(sessionId, requestId)) return
      options.applyRestoredSessionSummary(restoredSession)
    } catch (error) {
      console.error('[ChatPage] delete message failed:', error)
      if (options.canWriteSessionView(sessionId, requestId)) {
        options.notify({
          kind: 'error',
          code: 'chat.message.deleteFailed',
          title: options.t('dialog.deleteMessage.title'),
          description: options.t('common.error.requestFailed')
        })
      }
    }
  }

  function cancelMessageDelete() {
    pendingDeleteMessageId.value = null
    pendingDeleteSessionId = null
  }

  function onDeleteMessageDialogOpenChange(open: boolean) {
    if (!open) {
      cancelMessageDelete()
    }
  }

  async function onMessageEditSave(payload: MessageEditPayload) {
    if (mutationBlocked()) {
      payload.onSettled?.(false)
      return
    }
    const messageId = payload?.messageId
    const text = payload?.text?.trim()
    if (!messageId || !text || !ownsMessage(messageId)) {
      payload.onSettled?.(false)
      return
    }

    const sessionId = options.sessionId()
    try {
      if (payload.inlineItems === undefined)
        await options.sessionClient.editUserMessage(sessionId, messageId, text)
      else
        await options.sessionClient.editUserMessage(sessionId, messageId, text, payload.inlineItems)
      payload.onSettled?.(true)
      await onMessageRetry(messageId, sessionId)
    } catch (error) {
      payload.onSettled?.(false)
      console.error('[ChatPage] edit message failed:', error)
      if (sessionId === options.sessionId()) reportFailure('chat.message.editFailed', error)
    }
  }

  async function onMessageFork(messageId: string) {
    if (options.isReadOnlySession.value || !messageId) return

    if (mutationBlocked() || isForking.value || !ownsMessage(messageId)) return
    const sourceSessionId = options.sessionId()
    const requestId = options.currentRestoreRequestId()
    isForking.value = true
    try {
      const forked = await options.sessionClient.forkSession(sourceSessionId, messageId)
      await options.sessionStore.fetchSessions()
      if (!options.canWriteSessionView(sourceSessionId, requestId)) return
      if (options.forked) await options.forked(forked.id)
      else await options.sessionStore.selectSession(forked.id)
    } catch (error) {
      console.error('[ChatPage] fork session failed:', error)
      if (sourceSessionId === options.sessionId()) reportFailure('chat.message.forkFailed', error)
    } finally {
      isForking.value = false
    }
  }

  async function onMessageContinue(_conversationId: string, messageId: string) {
    // Signature stays for the emit chain. Legacy needContinue actions now send a
    // follow-up turn instead of retrying and rewriting the historical run.
    if (options.isReadOnlySession.value || !messageId) return
    if (mutationBlocked() || !ownsMessage(messageId)) return
    const latest = options.messageStore.messageIds.at(-1)
    if (latest && latest !== messageId) return
    const sessionId = options.sessionId()
    if (activeRetrySessionIds.has(sessionId)) return
    try {
      activeRetrySessionIds.add(sessionId)
      const result = await options.chatClient.sendMessage(
        sessionId,
        options.t('chat.guardStop.continueMessage')
      )
      if (result?.accepted === false) return
      options.beginPlanTurn(sessionId)
    } catch (error) {
      console.error('[ChatPage] continue message failed:', error)
      if (sessionId === options.sessionId()) reportFailure('chat.message.continueFailed', error)
    } finally {
      activeRetrySessionIds.delete(sessionId)
    }
  }

  function clearForSessionChange(): void {
    cancelMessageDelete()
    blockedRetryAttempt.value = null
    retryAttachmentPreparationSummary.value = null
  }

  return {
    isForking,
    showDeleteMessageDialog,
    retryAttachmentPreparationSummary,
    isRetryingAttachments,
    onMessageRetry,
    onMessageDelete,
    confirmMessageDelete,
    cancelMessageDelete,
    onDeleteMessageDialogOpenChange,
    onMessageEditSave,
    onMessageFork,
    onMessageContinue,
    retryBlockedMessage,
    retryBlockedMessageWithoutImageContent,
    cancelBlockedMessageRetry,
    switchRetryToVisionModel,
    clearForSessionChange
  }
}
