import type { ProviderSettingsPort } from '@/provider/settings'
import type { ProviderRuntime } from '@/provider'
import { ModelType } from '@shared/model'
import type { AnalysisModel } from '@shared/analysis'
import type { NaturalModelGateway } from './naturalAnalyzer'
import { AnalysisError } from './errors'

export class AnalysisModelGateway implements NaturalModelGateway {
  constructor(
    private readonly settings: ProviderSettingsPort,
    private readonly runtime: Pick<ProviderRuntime, 'generateText' | 'executeWithRateLimit'>,
    private readonly getDefault: () => { providerId: string; modelId: string } | undefined
  ) {}
  async models(): Promise<AnalysisModel[]> {
    const selected = this.getDefault()
    const result = new Map<string, AnalysisModel>()
    for (const group of await this.settings.getAllEnabledModels()) {
      const provider = this.settings.getProviderById(group.providerId)
      if (!provider?.enable || provider.apiType === 'acp' || provider.id === 'acp') continue
      for (const model of group.models) {
        if (model.type && model.type !== ModelType.Chat) continue
        const config = this.settings.getModelConfig(model.id, provider.id)
        if (config.apiEndpoint && config.apiEndpoint !== 'chat') continue
        result.set(`${provider.id}\0${model.id}`, {
          providerId: provider.id,
          modelId: model.id,
          providerName: provider.name,
          modelName: model.name || model.id,
          isDefault: selected?.providerId === provider.id && selected.modelId === model.id
        })
      }
    }
    return [...result.values()]
  }
  async generate(model: AnalysisModel, prompt: string, signal: AbortSignal): Promise<string> {
    const config = this.settings.getModelConfig(model.modelId, model.providerId)
    const context = config.contextLength ?? 32768
    const maxTokens = Math.min(config.maxTokens ?? 4096, 8192, Math.floor(context / 4))
    if (context < 2048 || Math.ceil(Buffer.byteLength(prompt, 'utf8') / 2) + maxTokens > context)
      throw new AnalysisError('ANALYSIS_CONTEXT_LIMIT')
    await this.runtime.executeWithRateLimit(model.providerId, { signal })
    const response = await this.runtime.generateText(
      model.providerId,
      prompt,
      model.modelId,
      0,
      maxTokens,
      { signal }
    )
    return response.content
  }
}
