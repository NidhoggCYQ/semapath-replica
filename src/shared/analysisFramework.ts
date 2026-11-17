import { z } from 'zod'

export const FrameworkQuestionKeySchema = z.string().regex(/^h[1-8]$/)
export const FrameworkQueryKeySchema = z.string().regex(/^q[1-6]$/)
export const WorkflowRefsSchema = z
  .array(
    z.enum([
      'decision-context',
      'data-quality',
      'metric-diagnostics',
      'kpi-workflows',
      'claim-validation'
    ])
  )
  .max(5)
export const FrameDraftSchema = z
  .object({
    objective: z.string().trim().min(1).max(800),
    workflowRefs: WorkflowRefsSchema.optional(),
    questions: z
      .array(
        z
          .object({
            key: FrameworkQuestionKeySchema,
            kind: z.enum(['question', 'hypothesis']),
            text: z.string().trim().min(1).max(800),
            queryKeys: z.array(FrameworkQueryKeySchema).max(6)
          })
          .strict()
      )
      .min(1)
      .max(8)
  })
  .strict()
export const FrameDecisionSchema = z
  .object({
    questionKey: FrameworkQuestionKeySchema,
    judgment: z.enum(['supported', 'not_supported', 'refuted', 'unverified']),
    next: z.enum(['continue', 'replace_method', 'stop', 'needs_data']),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(1200)
      .regex(/^[^0-9０-９]*$/u),
    evidence: z
      .array(
        z
          .object({
            queryKey: FrameworkQueryKeySchema,
            valueId: z.string().min(1).max(200)
          })
          .strict()
      )
      .max(24)
  })
  .strict()
export const AnalysisFrameSchema = z.object({
  version: z.literal('analysis-frame/1'),
  objective: z.string(),
  workflowRefs: WorkflowRefsSchema,
  questions: z
    .array(
      z.object({
        id: z.string().uuid(),
        key: FrameworkQuestionKeySchema,
        kind: z.enum(['question', 'hypothesis']),
        text: z.string(),
        queryKeys: z.array(FrameworkQueryKeySchema),
        judgment: z.enum(['supported', 'not_supported', 'refuted', 'unverified']),
        next: z.enum(['continue', 'replace_method', 'stop', 'needs_data']),
        reason: z.string(),
        evidence: z.array(z.object({ runId: z.string(), valueId: z.string() }))
      })
    )
    .min(1)
    .max(8)
})
export const ContinuationRequestSchema = z
  .object({
    parentTurnId: z.string().uuid(),
    parentCandidateHash: z.string().regex(/^[a-f0-9]{64}$/),
    questionId: z.string().uuid().optional(),
    scope: z
      .object({
        queryKey: FrameworkQueryKeySchema,
        valueId: z.string().min(1).max(200).optional()
      })
      .strict()
      .optional()
  })
  .strict()
export const RowScopeSchema = z
  .object({
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    rows: z.array(z.number().int().min(2).max(100000)).min(1).max(50000)
  })
  .strict()
export type FrameDraft = z.infer<typeof FrameDraftSchema>
export type FrameDecision = z.infer<typeof FrameDecisionSchema>
export type AnalysisFrame = z.infer<typeof AnalysisFrameSchema>
