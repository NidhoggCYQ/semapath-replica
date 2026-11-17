import { z } from 'zod'
import { AnalysisPlanSchema, NaturalViewSchema } from './analysis'
import { FrameDraftSchema, FrameDecisionSchema } from './analysisFramework'
import { JoinInputSchema } from './analysisData'
import { ReportOptionsSchema } from './analysisReport'
import { ANALYSIS_TOOL_NAMES } from './analysisWorkspace'

const uuid = z.string().uuid()
const queryKey = z.string().regex(/^q[1-6]$/)
const empty = z.object({}).strict()
export const AnalysisToolInputSchemas = {
  datasource_context: empty,
  datasource_schema: z
    .object({
      sourceId: uuid.optional(),
      targetId: z.string().min(1).max(200).optional(),
      transport: z.enum(['rest', 'xmla']).default('rest')
    })
    .strict(),
  datasource_query: z
    .object({
      kind: z.enum(['file', 'connection', 'join']),
      plan: AnalysisPlanSchema.omit({ rowScope: true }).strict().optional(),
      targetId: z.string().min(1).max(200).optional(),
      query: z.string().min(1).max(30000).optional(),
      title: z.string().trim().min(1).max(120).optional(),
      purpose: z.string().trim().min(1).max(4000).optional(),
      transport: z.enum(['rest', 'xmla']).default('rest'),
      join: JoinInputSchema.optional()
    })
    .strict(),
  analysis_evidence: z
    .object({
      runId: uuid,
      valueId: z.string().min(1).max(200).optional(),
      inputOffset: z.number().int().min(0).default(0),
      inputLimit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(20)
    })
    .strict(),
  analysis_get: z
    .object({
      turnId: uuid.optional(),
      runId: uuid.optional(),
      contextId: uuid.optional(),
      executionId: uuid.optional(),
      tableIndex: z.number().int().min(0).max(99).optional(),
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(100).optional()
    })
    .strict()
    .refine(
      (input) =>
        [input.turnId, input.runId, input.contextId, input.executionId].filter(Boolean).length <=
          1 &&
        (input.executionId ||
          [input.tableIndex, input.offset, input.limit].every((value) => value === undefined)),
      'Choose one reference; table pagination requires executionId'
    ),
  analysis_frame: FrameDraftSchema,
  analysis_progress: z.object({ message: z.string().trim().min(1).max(1000) }).strict(),
  tool_schema: z.object({ name: z.enum(ANALYSIS_TOOL_NAMES).optional() }).strict(),
  arguments_repair: z
    .object({ name: z.enum(ANALYSIS_TOOL_NAMES), arguments: z.record(z.string(), z.unknown()) })
    .strict(),
  chart_schema: empty,
  answer_submit: z
    .object({
      question: z.string().trim().min(1).max(4000),
      runs: z
        .array(z.object({ key: queryKey, runId: uuid }).strict())
        .min(1)
        .max(6),
      views: z.array(NaturalViewSchema).min(1).max(8),
      frame: FrameDraftSchema.optional(),
      decisions: z.array(FrameDecisionSchema).max(8).optional()
    })
    .strict(),
  answer_confirm: z
    .object({
      turnId: uuid,
      candidateHash: z.string().regex(/^[a-f0-9]{64}$/),
      reviewReceiptId: uuid
    })
    .strict(),
  answer_resume: z.object({ turnId: uuid }).strict(),
  report_export: z.object({ turnId: uuid, options: ReportOptionsSchema }).strict()
} as const
