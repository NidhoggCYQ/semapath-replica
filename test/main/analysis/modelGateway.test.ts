import { describe, expect, it, vi } from 'vitest'
import { AnalysisModelGateway } from '@/analysis/modelGateway'
import type { ProviderSettingsPort } from '@/provider/settings'
import { ApiEndpointType, ModelType } from '@shared/model'
import type { AnalysisModel } from '@shared/analysis'
const model: AnalysisModel = {
  providerId: 'local',
  modelId: 'chat',
  providerName: 'Local',
  modelName: 'Chat',
  isDefault: true
}
function setup(contextLength = 32768) {
  const settings = {
    getAllEnabledModels: vi.fn(async () => [
      {
        providerId: 'local',
        models: [
          { id: 'chat', name: 'Chat', type: ModelType.Chat },
          { id: 'embed', type: ModelType.Embedding }
        ]
      },
      { providerId: 'disabled', models: [{ id: 'hidden' }] },
      { providerId: 'acp', models: [{ id: 'agent' }] }
    ]),
    getProviderById: vi.fn((id) => ({
      id,
      name: 'Local',
      enable: id !== 'disabled',
      apiType: id === 'acp' ? 'acp' : 'openai-completions',
      apiKey: 'synthetic-key-never-exposed',
      baseUrl: 'http://127.0.0.1/v1'
    })),
    getModelConfig: vi.fn(() => ({
      apiEndpoint: ApiEndpointType.Chat,
      contextLength,
      maxTokens: 4096
    }))
  }
  const runtime = {
    executeWithRateLimit: vi.fn(async () => {}),
    generateText: vi.fn(async () => ({ content: '{"decision":"confirm"}' }))
  }
  return {
    settings,
    runtime,
    gateway: new AnalysisModelGateway(
      settings as unknown as ProviderSettingsPort,
      runtime as never,
      () => ({ providerId: 'local', modelId: 'chat' })
    )
  }
}
describe('Analysis provider integration boundary', () => {
  it('offers only enabled chat models and never returns credentials or service URLs to the analysis UI', async () => {
    const { gateway } = setup()
    const models = await gateway.models()
    expect(models).toEqual([model])
    expect(JSON.stringify(models)).not.toContain('synthetic-key')
    expect(JSON.stringify(models)).not.toContain('127.0.0.1')
  })
  it('uses the existing runtime with rate limits, deterministic settings and transport cancellation', async () => {
    const { gateway, runtime } = setup()
    const signal = new AbortController().signal
    expect(await gateway.generate(model, 'bounded prompt', signal)).toBe('{"decision":"confirm"}')
    expect(runtime.executeWithRateLimit).toHaveBeenCalledWith('local', { signal })
    expect(runtime.generateText).toHaveBeenCalledWith('local', 'bounded prompt', 'chat', 0, 4096, {
      signal
    })
  })
  it('stops an oversized prompt before any model request', async () => {
    const { gateway, runtime } = setup(2048)
    await expect(
      gateway.generate(model, '大'.repeat(3000), new AbortController().signal)
    ).rejects.toThrow('ANALYSIS_CONTEXT_LIMIT')
    expect(runtime.generateText).not.toHaveBeenCalled()
  })
})
