import type { InjectionKey, Ref } from 'vue'
import type {
  AnalysisContext,
  DataReference,
  QuoteOrigin,
  ReferenceCatalogSchema,
  FOLLOWUP_INTENTS
} from '@shared/analysisInteraction'
import type { z } from 'zod'

export type FollowupIntent = (typeof FOLLOWUP_INTENTS)[number]
export type AnalysisInsertion = { key: string; context: AnalysisContext; question: string }
export interface AnalysisInteractionScope {
  taskId: Ref<string | null>
  catalog: (query: string) => Promise<z.infer<typeof ReferenceCatalogSchema>>
  reference: (reference: DataReference) => Promise<AnalysisContext>
  open: (contextId: string) => void
  reportError: (error: unknown) => void
}
export const ANALYSIS_INTERACTION_SCOPE: InjectionKey<AnalysisInteractionScope> =
  Symbol('analysis-interaction')
export const ANALYSIS_FOLLOWUP: InjectionKey<{
  request: (origin: QuoteOrigin, text: string, intent: FollowupIntent) => Promise<void>
}> = Symbol('analysis-followup')
