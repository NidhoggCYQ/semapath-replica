import { z } from 'zod'

export const AcquisitionOriginSchema = z
  .object({
    version: z.literal('retrieval/1'),
    requestId: z.string().uuid(),
    question: z.string().max(4000),
    providerId: z.string(),
    modelId: z.string(),
    modelName: z.string(),
    structureSha256: z.string().regex(/^[a-f0-9]{64}$/),
    generatedAt: z.string().datetime(),
    querySha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
  })
  .strict()
export const RetrievalSelectionSchema = z
  .object({
    targetIds: z.array(z.string().min(1).max(100)).min(1).max(4),
    sourceIds: z.array(z.string().min(1)).max(6),
    transport: z.enum(['rest', 'xmla'])
  })
  .strict()
const targetFields = { id: z.string(), label: z.string(), detail: z.string() }
export const RetrievalTargetSchema = z.discriminatedUnion('kind', [
  z.object({ ...targetFields, kind: z.literal('mysql') }).strict(),
  z
    .object({
      ...targetFields,
      kind: z.literal('powerbi'),
      powerBiKind: z.enum(['local', 'cloud'])
    })
    .strict()
])
export const RetrievalTargetsSchema = z.object({
  targets: z.array(RetrievalTargetSchema),
  issues: z.array(z.string())
})
export const RetrievalTraceSchema = z.object({
  version: z.literal('retrieval/1'),
  createdAt: z.string().datetime(),
  steps: z
    .array(
      z.object({
        kind: z.enum(['query', 'join']),
        title: z.string(),
        sourceId: z.string(),
        sourceSha256: z.string(),
        targetId: z.string().optional(),
        query: z.string().optional(),
        rows: z.number().int().nonnegative()
      })
    )
    .max(4)
})
export type AcquisitionOrigin = z.infer<typeof AcquisitionOriginSchema>
export type RetrievalSelection = z.infer<typeof RetrievalSelectionSchema>
export type RetrievalTarget = z.infer<typeof RetrievalTargetSchema>
export type RetrievalTargets = z.infer<typeof RetrievalTargetsSchema>
export type RetrievalTrace = z.infer<typeof RetrievalTraceSchema>
