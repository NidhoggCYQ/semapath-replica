import { z } from 'zod'
import { ReasoningEffortSchema } from './types/model-db'

export const ComposerPredictionSettingsSchema = z
  .object({
    model: z
      .object({ providerId: z.string().min(1), modelId: z.string().min(1) })
      .strict()
      .nullable(),
    reasoning: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('auto') }).strict(),
      z.object({ mode: z.literal('effort'), value: ReasoningEffortSchema }).strict(),
      z.object({ mode: z.literal('enabled'), value: z.boolean() }).strict()
    ])
  })
  .strict()
  .refine((value) => value.model !== null || value.reasoning.mode === 'auto')
export type ComposerPredictionSettings = z.infer<typeof ComposerPredictionSettingsSchema>
export const defaultComposerPredictionSettings = (): ComposerPredictionSettings => ({
  model: null,
  reasoning: { mode: 'auto' }
})
export const ComposerPredictionStatusSchema = z
  .object({
    reason: z.enum([
      'provider_unavailable',
      'model_unavailable',
      'reasoning_unavailable',
      'budget_unavailable',
      'call_failed',
      'timeout',
      'invalid_output'
    ]),
    fallback: z.enum(['generated', 'empty', 'failed']).nullable()
  })
  .nullable()
export type ComposerPredictionStatus = z.infer<typeof ComposerPredictionStatusSchema>

/** Accept one short user question, never a tool command or an assistant answer. */
export function parseComposerPrediction(output: string): string | null {
  let value: unknown
  try {
    value = JSON.parse(output.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''))
  } catch {
    throw new Error('invalid_output')
  }
  const parsed = z
    .object({ suggestion: z.string().max(240).nullable() })
    .strict()
    .safeParse(value)
  if (!parsed.success) throw new Error('invalid_output')
  const text = parsed.data.suggestion?.trim()
  if (text && /[\u0000-\u001f<>]/.test(text)) throw new Error('invalid_output')
  return text || null
}
