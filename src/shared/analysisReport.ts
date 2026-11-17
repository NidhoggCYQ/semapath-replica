import { z } from 'zod'
import { ChartKindSchema } from './analysisStudy'
import { AnalysisFrameSchema } from './analysisFramework'
import {
  AnalysisErrorCodes,
  AnalysisModelSchema,
  AnalysisRunSchema,
  AnalysisSourceSchema,
  NaturalDerivedSchema,
  NaturalContextSchema
} from './analysis'

export const REPORT_RENDERER_VERSION = 'analysis-report/7' as const
export const ReportOptionsSchema = z
  .object({
    format: z.enum(['a4', 'slides']),
    locale: z.enum(['zh-CN', 'en-US']),
    title: z.string().trim().min(1).max(160)
  })
  .strict()
export const ReportAnswerSchema = z
  .object({
    kind: z.enum(['run', 'turn']),
    id: z.string().uuid(),
    candidateHash: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()
export const ReportCreateSchema = z
  .object({
    requestId: z.string().uuid(),
    answer: ReportAnswerSchema,
    options: ReportOptionsSchema
  })
  .strict()
export const ReportStatusSchema = z.enum([
  'rendering',
  'ready',
  'failed',
  'cancelled',
  'interrupted'
])
export const ReportAttemptSchema = z.object({
  number: z.number().int().min(1),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  status: ReportStatusSchema,
  error: z.enum(AnalysisErrorCodes).nullable(),
  bytes: z.number().int().nonnegative().nullable(),
  pages: z.number().int().min(1).nullable(),
  sha256: z.string().nullable()
})
export const ReportRecordSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
  answer: ReportAnswerSchema,
  options: ReportOptionsSchema,
  rendererVersion: z.enum([
    'analysis-report/1',
    'analysis-report/2',
    'analysis-report/3',
    'analysis-report/4',
    'analysis-report/5',
    'analysis-report/6',
    REPORT_RENDERER_VERSION
  ]),
  cacheKey: z.string(),
  snapshotHash: z.string(),
  htmlHash: z.string(),
  status: ReportStatusSchema,
  stage: z.enum(['preparing', 'rendering', 'verifying', 'saving', 'finished']),
  attempts: z.array(ReportAttemptSchema).min(1)
})
export const ReportViewSchema = z.object({
  kind: z.enum(['summary', 'ranking', 'share', 'comparison', 'method']),
  runId: z.string(),
  baselineRunId: z.string().optional(),
  chart: ChartKindSchema,
  limit: z.number().int().min(1).max(20).optional(),
  direction: z.enum(['ascending', 'descending']).optional()
})
export const ReportRunSchema = AnalysisRunSchema.extend({
  source: AnalysisSourceSchema.omit({ path: true, boundAt: true })
})
export const ReportSnapshotSchema = z.object({
  version: z.literal(1),
  frozenAt: z.string(),
  task: z.object({ id: z.string().uuid(), title: z.string() }),
  answer: ReportAnswerSchema.extend({
    question: z.string(),
    publishedAt: z.string(),
    model: AnalysisModelSchema.optional()
  }),
  runs: z.array(ReportRunSchema).min(1).max(6),
  views: z.array(ReportViewSchema).min(1).max(8),
  derived: z.array(NaturalDerivedSchema),
  framework: AnalysisFrameSchema.optional(),
  queryRuns: z
    .array(z.object({ key: z.string(), runId: z.string() }))
    .max(6)
    .optional(),
  context: NaturalContextSchema.optional(),
  lineage: z
    .array(
      z.object({
        id: z.string().uuid(),
        question: z.string(),
        candidateHash: z.string(),
        status: z.enum(['draft', 'published']),
        context: NaturalContextSchema.optional()
      })
    )
    .max(12)
    .optional()
})
export type ReportOptions = z.infer<typeof ReportOptionsSchema>
export type ReportAnswer = z.infer<typeof ReportAnswerSchema>
export type ReportCreate = z.infer<typeof ReportCreateSchema>
export type ReportRecord = z.infer<typeof ReportRecordSchema>
export type ReportSnapshot = z.infer<typeof ReportSnapshotSchema>
export type ReportRun = z.infer<typeof ReportRunSchema>
export type ReportView = z.infer<typeof ReportViewSchema>
