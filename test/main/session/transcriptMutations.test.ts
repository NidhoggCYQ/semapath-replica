import { describe, expect, it, vi } from 'vitest'
import { SessionTranscriptMutations } from '@/session/transcriptMutations'

describe('SessionTranscriptMutations', () => {
  it('preserves failed edits and atomically replaces the old reply only after reference validation', async () => {
    let content = JSON.stringify({
      text: '旧问题',
      files: [{ name: 'evidence.xlsx', path: '/fixture.xlsx' }],
      inlineItems: [],
      content: [
        { type: 'text', content: '旧文本一' },
        { type: 'text', content: '旧文本二' }
      ]
    })
    let laterReplies = 1
    const runtime = {
      assertNoActivePendingInputs: vi.fn(),
      cancelForTranscriptMutation: vi.fn(async () => {}),
      invalidateTranscriptFrom: vi.fn(),
      finishTranscriptTruncate: vi.fn()
    }
    const validateInput = vi.fn(async (_session, input) => {
      input.inlineItems[0].label = '规范字段'
    })
    validateInput.mockRejectedValueOnce(new Error('ANALYSIS_REFERENCE_STALE'))
    const transcript = {
      getMessage: vi.fn(() => ({ id: 'u', sessionId: 's', role: 'user', orderSeq: 1, content })),
      updateMessageContent: vi.fn((_id, next) => {
        content = next
      }),
      deleteFromOrderSeq: vi.fn(() => {
        laterReplies = 0
      })
    }
    const service = new SessionTranscriptMutations({
      transcript,
      runtime,
      validateInput,
      runInTransaction: (fn) => fn()
    } as any)
    const inlineItems = [
      { type: 'analysis', contextId: 'context', label: '伪造标签', offset: 0 }
    ] as any
    await expect(service.editUserMessage('s', 'u', '新问题', inlineItems)).rejects.toThrow(
      'ANALYSIS_REFERENCE_STALE'
    )
    expect(laterReplies).toBe(1)
    expect(JSON.parse(content).text).toBe('旧问题')
    expect(runtime.cancelForTranscriptMutation).not.toHaveBeenCalled()
    await service.editUserMessage('s', 'u', '新问题', inlineItems)
    expect(laterReplies).toBe(0)
    const saved = JSON.parse(content)
    expect(saved.text).toBe('新问题')
    expect(saved.content.filter((b) => b.type === 'text')).toEqual([
      { type: 'text', content: '新问题' }
    ])
    expect(saved.inlineItems[0].label).toBe('规范字段')
    expect(saved.files).toHaveLength(1)
  })
  it('allows a failed Steer retry to coexist with restart-held Queue drafts', async () => {
    const message = {
      id: 'steer-1',
      sessionId: 's1',
      orderSeq: 3,
      role: 'user',
      content: JSON.stringify({ text: 'Retry steer', files: [] }),
      status: 'error',
      metadata: JSON.stringify({ inputReceipt: { mode: 'steer', readAt: null } })
    }
    const runtime = {
      prepareRetry: vi.fn().mockResolvedValue({ projectDir: '/repo' })
    }
    const transcript = {
      getMessage: vi.fn(() => message),
      updateMessageStatus: vi.fn()
    }
    const mutations = new SessionTranscriptMutations({
      transcript,
      runtime
    } as any)

    await expect(mutations.prepareRetryMessage('s1', 'steer-1')).resolves.toEqual({
      content: { text: 'Retry steer', files: [], search: false },
      projectDir: '/repo',
      sourceOrderSeq: 3,
      retryFromOrderSeq: 4,
      sourceMessageId: 'steer-1'
    })
    expect(runtime.prepareRetry).toHaveBeenCalledWith('s1', {
      allowRestartHeldQueue: true
    })
    // The failed Steer prompt is kept as the pre-stream anchor, so it must be
    // restored to 'sent' to remain visible to context history filtering.
    expect(transcript.updateMessageStatus).toHaveBeenCalledWith('steer-1', 'sent')
  })

  it('keeps the user prompt in place when retrying a user message directly', async () => {
    const message = {
      id: 'user-1',
      sessionId: 's1',
      orderSeq: 3,
      role: 'user',
      content: JSON.stringify({ text: 'Retry prompt', files: [] }),
      status: 'sent',
      metadata: '{}'
    }
    const runtime = {
      prepareRetry: vi.fn().mockResolvedValue({ projectDir: '/repo' })
    }
    const mutations = new SessionTranscriptMutations({
      transcript: { getMessage: vi.fn(() => message) },
      runtime
    } as any)

    await expect(mutations.prepareRetryMessage('s1', 'user-1')).resolves.toEqual({
      content: { text: 'Retry prompt', files: [], search: false },
      projectDir: '/repo',
      sourceOrderSeq: 3,
      // Truncate from the message after the prompt so the prompt survives, and
      // anchor it so the same record is re-sent instead of a fresh duplicate.
      retryFromOrderSeq: 4,
      sourceMessageId: 'user-1'
    })
    expect(runtime.prepareRetry).toHaveBeenCalledWith('s1', {
      allowRestartHeldQueue: false
    })
  })

  it('rolls pending inputs and transcript deletion back when Tape reset fails', async () => {
    const state = { pendingInputs: 1, transcriptMessages: 2, tapeEntries: 3 }
    const runtime = {
      prepareClearMessages: vi.fn().mockResolvedValue(undefined),
      finishClearMessages: vi.fn()
    }
    const mutations = new SessionTranscriptMutations({
      pendingInputs: {
        deleteBySession: vi.fn(() => {
          state.pendingInputs = 0
        })
      },
      transcript: {
        deleteBySession: vi.fn(() => {
          state.transcriptMessages = 0
        })
      },
      settings: {
        resetTape: vi.fn(() => {
          state.tapeEntries = 0
          throw new Error('Tape reset failed')
        })
      },
      runtime,
      runInTransaction: (operation) => {
        const snapshot = { ...state }
        try {
          return operation()
        } catch (error) {
          Object.assign(state, snapshot)
          throw error
        }
      }
    } as any)

    await expect(mutations.clearMessages('s1')).rejects.toThrow('Tape reset failed')

    expect(state).toEqual({ pendingInputs: 1, transcriptMessages: 2, tapeEntries: 3 })
    expect(runtime.prepareClearMessages).toHaveBeenCalledWith('s1')
    expect(runtime.finishClearMessages).not.toHaveBeenCalled()
  })

  it('finishes runtime cleanup only after the shared transaction commits', async () => {
    const calls: string[] = []
    const mutations = new SessionTranscriptMutations({
      pendingInputs: { deleteBySession: vi.fn(() => calls.push('pending')) },
      transcript: { deleteBySession: vi.fn(() => calls.push('transcript')) },
      settings: { resetTape: vi.fn(() => calls.push('tape')) },
      runtime: {
        prepareClearMessages: vi.fn(async () => {
          calls.push('prepare')
        }),
        finishClearMessages: vi.fn(() => calls.push('finish'))
      },
      runInTransaction: (operation) => {
        calls.push('transaction:start')
        const result = operation()
        calls.push('transaction:commit')
        return result
      }
    } as any)

    await mutations.clearMessages('s1')

    expect(calls).toEqual([
      'prepare',
      'transaction:start',
      'pending',
      'transcript',
      'tape',
      'transaction:commit',
      'finish'
    ])
  })

  it('invalidates retry projections only after transcript deletion commits', () => {
    const calls: string[] = []
    const runtime = {
      invalidateTranscriptFrom: vi.fn(() => calls.push('invalidate'))
    }
    const mutations = new SessionTranscriptMutations({
      transcript: {
        deleteFromOrderSeq: vi.fn(() => {
          calls.push('delete')
        })
      },
      runtime,
      runInTransaction: (operation) => {
        calls.push('transaction:start')
        const result = operation()
        calls.push('transaction:commit')
        return result
      }
    } as any)

    mutations.commitRetryMessage('s1', 7)

    expect(calls).toEqual(['transaction:start', 'delete', 'transaction:commit', 'invalidate'])
  })

  it('does not invalidate retry projections when transcript deletion rolls back', () => {
    const runtime = { invalidateTranscriptFrom: vi.fn() }
    const mutations = new SessionTranscriptMutations({
      transcript: {
        deleteFromOrderSeq: vi.fn(() => {
          throw new Error('delete failed')
        })
      },
      runtime,
      runInTransaction: (operation) => operation()
    } as any)

    expect(() => mutations.commitRetryMessage('s1', 7)).toThrow('delete failed')
    expect(runtime.invalidateTranscriptFrom).not.toHaveBeenCalled()
  })

  it('cancels the active Run before editing transcript history', async () => {
    const calls: string[] = []
    const message = {
      id: 'message-1',
      sessionId: 's1',
      orderSeq: 7,
      role: 'user',
      content: JSON.stringify({ text: 'old text' })
    }
    const runtime = {
      assertNoActivePendingInputs: vi.fn(),
      cancelForTranscriptMutation: vi.fn(async () => calls.push('cancel')),
      invalidateTranscriptFrom: vi.fn(() => calls.push('invalidate')),
      finishTranscriptTruncate: vi.fn(() => calls.push('finish'))
    }
    const mutations = new SessionTranscriptMutations({
      transcript: {
        getMessage: vi.fn(() => message),
        updateMessageContent: vi.fn(() => calls.push('update')),
        deleteFromOrderSeq: vi.fn(() => calls.push('truncate'))
      },
      runtime,
      runInTransaction: (operation: () => unknown) => operation()
    } as any)

    await mutations.editUserMessage('s1', 'message-1', 'new text')

    expect(calls).toEqual(['cancel', 'invalidate', 'update', 'truncate', 'finish'])
  })

  it('does not edit transcript history when active Run cancellation fails', async () => {
    const cancellationError = new Error('cancellation failed')
    const runtime = {
      assertNoActivePendingInputs: vi.fn(),
      cancelForTranscriptMutation: vi.fn().mockRejectedValue(cancellationError),
      invalidateTranscriptFrom: vi.fn()
    }
    const transcript = {
      getMessage: vi.fn(() => ({
        id: 'message-1',
        sessionId: 's1',
        orderSeq: 7,
        role: 'user',
        content: JSON.stringify({ text: 'old text' })
      })),
      updateMessageContent: vi.fn()
    }
    const mutations = new SessionTranscriptMutations({ transcript, runtime } as any)

    await expect(mutations.editUserMessage('s1', 'message-1', 'new text')).rejects.toBe(
      cancellationError
    )
    expect(runtime.invalidateTranscriptFrom).not.toHaveBeenCalled()
    expect(transcript.updateMessageContent).not.toHaveBeenCalled()
  })
})
