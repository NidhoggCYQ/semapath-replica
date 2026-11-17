import { describe, it, expect, vi } from 'vitest'
import { ComposerPrediction } from '@/session/composerPrediction'
import {
  defaultComposerPredictionSettings,
  parseComposerPrediction,
  type ComposerPredictionSettings
} from '@shared/composerPrediction'

function harness() {
  let enabled = true
  let config: ComposerPredictionSettings = defaultComposerPredictionSettings()
  const messages = [
    {
      id: 'u',
      sessionId: 's',
      role: 'user',
      status: 'sent',
      content: JSON.stringify({ text: '按区域分析销售额' }),
      metadata: '{}',
      updatedAt: 1
    },
    {
      id: 'a',
      sessionId: 's',
      role: 'assistant',
      status: 'sent',
      content: JSON.stringify([
        { type: 'reasoning_content', content: 'PRIVATE' },
        { type: 'content', content: '销售额合计为 1.3 元。' }
      ]),
      metadata: '{}',
      updatedAt: 2
    }
  ]
  const changed = vi.fn()
  const stream = vi.fn(async function* (_provider, _messages, _model, _config, _temp, _max, tools) {
    expect(tools).toEqual([])
    yield { type: 'text', content: JSON.stringify({ suggestion: '各区域销售额分别是多少？' }) }
  })
  const deps = {
    sessions: {
      getSession: vi.fn(async () => ({
        id: 's',
        status: 'idle',
        sessionKind: 'regular',
        providerId: 'p',
        modelId: 'm'
      })),
      listMessagesPage: vi.fn(async () => ({ messages }))
    },
    models: {
      getProviderById: vi.fn((id) => ({ id, enable: id === 'p', apiType: 'openai-completions' })),
      getModelConfig: vi.fn(() => ({
        type: 'chat',
        maxTokens: 4096,
        contextLength: 32768,
        vision: false,
        functionCall: true,
        reasoning: false
      })),
      getAllEnabledModels: vi.fn(async () => [{ providerId: 'p', models: [{ id: 'm' }] }])
    },
    provider: { streamChat: stream, executeWithRateLimit: vi.fn(async () => {}) },
    enabled: () => enabled,
    settings: () => config,
    changed
  }
  const service = new ComposerPrediction(deps as never)
  return {
    service,
    deps,
    messages,
    stream,
    changed,
    setEnabled: (v: boolean) => {
      enabled = v
    },
    setConfig: (v: ComposerPredictionSettings) => {
      config = v
    }
  }
}
describe('composer follow-up prediction', () => {
  it('makes one bounded tool-free call per answer, shares concurrent requests, excludes private reasoning', async () => {
    const h = harness()
    expect(await Promise.all([h.service.get('s', 'a'), h.service.get('s', 'a')])).toEqual([
      '各区域销售额分别是多少？',
      '各区域销售额分别是多少？'
    ])
    expect(h.stream).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(h.stream.mock.calls)).not.toContain('PRIVATE')
    expect(h.stream.mock.calls[0][3]).toMatchObject({ enableSearch: false, forcedSearch: false })
    expect(h.messages).toHaveLength(2)
  })
  it('falls back from an unavailable selected model and persists failure status', async () => {
    const h = harness()
    h.setConfig({ model: { providerId: 'missing', modelId: 'x' }, reasoning: { mode: 'auto' } })
    expect(await h.service.get('s', 'a')).toBe('各区域销售额分别是多少？')
    expect(h.service.getStatus()).toEqual({ reason: 'provider_unavailable', fallback: 'generated' })
    h.service.invalidate()
    expect(h.service.getStatus()).toBeNull()
  })
  it('rejects stale, stopped, error, disabled and foreign answer requests without a model call', async () => {
    const h = harness()
    expect(await h.service.get('s', 'foreign')).toBeNull()
    h.messages[1].metadata = JSON.stringify({ runOutcome: 'aborted', runStopReason: 'user_stop' })
    expect(await h.service.get('s', 'a')).toBeNull()
    h.messages[1].metadata = '{}'
    h.messages[1].status = 'error'
    expect(await h.service.get('s', 'a')).toBeNull()
    h.setEnabled(false)
    expect(await h.service.get('s', 'a')).toBeNull()
    expect(h.stream).not.toHaveBeenCalled()
  })
  it('drops an in-flight answer after a new turn and after settings invalidation', async () => {
    const h = harness()
    let finish!: () => void
    let start!: () => void
    const started = new Promise<void>((r) => {
      start = r
    })
    h.stream.mockImplementation(async function* () {
      start()
      await new Promise<void>((r) => {
        finish = r
      })
      yield { type: 'text', content: '{"suggestion":"旧建议"}' }
    })
    const pending = h.service.get('s', 'a')
    await started
    h.messages.push({ ...h.messages[0], id: 'new', updatedAt: 3 })
    h.service.invalidate()
    finish()
    expect(await pending).toBeNull()
  })
  it('treats invalid model output as optional failure and never accepts long or multiline commands', () => {
    expect(parseComposerPrediction('{"suggestion":null}')).toBeNull()
    expect(() => parseComposerPrediction('回答已经执行完毕')).toThrow('invalid_output')
    expect(() => parseComposerPrediction(JSON.stringify({ suggestion: 'x'.repeat(241) }))).toThrow(
      'invalid_output'
    )
    expect(() => parseComposerPrediction(JSON.stringify({ suggestion: 'first\nsecond' }))).toThrow(
      'invalid_output'
    )
  })
})
