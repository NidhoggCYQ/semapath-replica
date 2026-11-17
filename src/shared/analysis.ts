import { z } from 'zod'
import {
  AnalysisFrameSchema,
  ContinuationRequestSchema,
  FrameDraftSchema,
  FrameDecisionSchema,
  RowScopeSchema
} from './analysisFramework'
import { ChartKindSchema, StudyPlanSchema, StudyResultSchema } from './analysisStudy'
import { SourceOriginSchema, OriginCellSchema } from './analysisData'
import { RetrievalSelectionSchema, RetrievalTraceSchema } from './analysisAcquisition'

export const AnalysisErrorCodes = [
  'WORKSPACE_SESSION_MISSING',
  'WORKSPACE_CONFLICT',
  'ANALYSIS_TOOL_ARGUMENTS',
  'ANALYSIS_TOOL_REPLAY',
  'ANALYSIS_TOOL_INTERRUPTED',
  'ANALYSIS_REVIEW_REQUIRED',
  'ANALYSIS_REFERENCE_STALE',
  'ANALYSIS_REFERENCE_UNAVAILABLE',
  'ANALYSIS_CONTEXT_NOT_FOUND',
  'ANALYSIS_QUOTE_INVALID',
  'FETCH_TARGET_CHANGED',
  'FETCH_SCOPE_LOCKED',
  'FETCH_QUERY_SCOPE',
  'FETCH_PLAN_LIMIT',
  'FETCH_NOT_CONFIGURED',
  'NOT_FOUND',
  'FILE_UNREADABLE',
  'FILE_TYPE',
  'FILE_LIMIT',
  'INVALID_WORKBOOK',
  'SOURCE_CHANGED',
  'INVALID_COLUMN',
  'INVALID_NUMBER',
  'FORMULA_CACHE_MISSING',
  'NO_ROWS',
  'GROUP_LIMIT',
  'INVALID_DRAFT',
  'BUSY',
  'STORAGE_ERROR',
  'MODEL_NOT_CONFIGURED',
  'MODEL_FAILED',
  'MODEL_TIMEOUT',
  'INVALID_ANALYSIS_PLAN',
  'ANALYSIS_UNSUPPORTED',
  'ANALYSIS_CANCELLED',
  'ANALYSIS_CONTEXT_LIMIT',
  'REPORT_NOT_PUBLISHED',
  'REPORT_INVALID_SNAPSHOT',
  'REPORT_LIMIT',
  'REPORT_LAYOUT',
  'REPORT_RENDER_FAILED',
  'REPORT_CANCELLED',
  'REPORT_TIMEOUT',
  'REPORT_FILE_CHANGED',
  'REPORT_FILE_MISSING',
  'REPORT_INTERRUPTED',
  'REPORT_SAVE_FAILED',
  'METHOD_REQUIREMENTS',
  'METHOD_DATA_LIMIT',
  'CHART_NOT_APPLICABLE',
  'INVALID_ANALYSIS_CONTEXT',
  'ANALYSIS_DEPTH_LIMIT',
  'SQL_READ_ONLY',
  'SQL_CONNECT_FAILED',
  'SQL_AUTH_FAILED',
  'SQL_DATABASE',
  'SQL_QUERY_FAILED',
  'SQL_LIMIT',
  'SQL_TIMEOUT',
  'SQL_CANCELLED',
  'SQL_SECRET_UNAVAILABLE',
  'DATA_SNAPSHOT_IMMUTABLE',
  'JOIN_KEY',
  'JOIN_CARDINALITY',
  'JOIN_LIMIT',
  'PBI_BRIDGE_UNAVAILABLE',
  'PBI_PROTOCOL',
  'PBI_MODEL_CHANGED',
  'PBI_NOT_FOUND',
  'PBI_CONNECT_FAILED',
  'PBI_DAX_READ_ONLY',
  'PBI_QUERY_FAILED',
  'PBI_LIMIT',
  'PBI_TIMEOUT',
  'PBI_CANCELLED',
  'PBI_CLOUD_CANCELLED',
  'PBI_NOT_CONFIGURED',
  'PBI_AUTH_REQUIRED',
  'PBI_AUTH_FAILED',
  'PBI_ACCOUNT_CHANGED',
  'PBI_PERMISSION',
  'PBI_TENANT_DISABLED',
  'PBI_THROTTLED',
  'PBI_METADATA_UNAVAILABLE',
  'PBI_SECRET_UNAVAILABLE'
] as const
export type AnalysisErrorCode = (typeof AnalysisErrorCodes)[number]
export const AnalysisColumnSchema = z.object({ key: z.string(), label: z.string() })
export const AnalysisSheetSchema = z.object({
  name: z.string(),
  firstRow: z.number().int(),
  lastRow: z.number().int(),
  columnCount: z.number().int()
})
export const AnalysisSourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  sha256: z.string(),
  bytes: z.number(),
  modifiedAt: z.string(),
  boundAt: z.string(),
  sheets: z.array(AnalysisSheetSchema),
  origin: SourceOriginSchema.optional()
})
export const AnalysisPlanSchema = z.object({
  sourceId: z.string().min(1),
  sheet: z.string().min(1),
  headerRow: z.number().int().min(1).max(100000),
  operation: z.enum(['sum', 'average', 'count', 'min', 'max']),
  measure: z.string().max(10),
  groupBy: z.string().max(10).default(''),
  filters: z
    .array(
      z.object({
        column: z.string(),
        operator: z.enum(['eq', 'neq', 'contains', 'in', 'gt', 'gte', 'lt', 'lte']),
        kind: z.enum(['text', 'number', 'date']).optional(),
        values: z.array(z.string().max(1000)).min(1).max(30).optional(),
        value: z.string().max(1000)
      })
    )
    .max(10)
    .default([]),
  question: z.string().max(4000).default(''),
  unit: z.string().max(30).default(''),
  period: z.string().max(100).default(''),
  grouping: z.enum(['raw', 'day', 'month']).optional(),
  groupOrder: z.enum(['source', 'ascending', 'descending']).optional(),
  study: StudyPlanSchema.optional(),
  rowScope: RowScopeSchema.optional()
})
export const AnalysisValueSchema = z.object({
  id: z.string(),
  category: z.string(),
  value: z.string(),
  exact: z.string(),
  numerator: z.string(),
  denominator: z.number().int().min(1),
  included: z.number().int(),
  blank: z.number().int(),
  inputs: z.array(
    z.object({
      row: z.number().int(),
      cell: z.string(),
      value: z.string(),
      origin: z.array(OriginCellSchema).optional()
    })
  ),
  formula: z.string().optional(),
  rational: z.object({ numerator: z.string(), denominator: z.string() }).optional(),
  unit: z.string().optional(),
  approximate: z.boolean().optional()
})
export const AnalysisRunSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  source: AnalysisSourceSchema,
  plan: AnalysisPlanSchema,
  measureLabel: z.string(),
  groupLabel: z.string(),
  evidenceId: z.string(),
  scannedRows: z.number().int(),
  matchedRows: z.number().int(),
  emptyRows: z.number().int(),
  values: z.array(AnalysisValueSchema),
  warnings: z.array(
    z.enum(['CACHED_FORMULAS', 'DATE_SYSTEM_1904', 'ROUNDING_12_DP', 'TEXT_NUMBERS'])
  ),
  execution: z.object({
    engine: z.literal('semapath-excel/1'),
    durationMs: z.number(),
    plan: z.string(),
    stdout: z.string()
  }),
  chart: z.object({ kind: ChartKindSchema, evidenceId: z.string() }),
  study: StudyResultSchema.optional(),
  answer: z.object({
    status: z.enum(['draft', 'published']),
    candidateHash: z.string(),
    publishedAt: z.string().nullable()
  })
})
export const AnalysisModelSchema = z.object({
  providerId: z.string(),
  modelId: z.string(),
  providerName: z.string(),
  modelName: z.string(),
  isDefault: z.boolean()
})
export const WorkbookCatalogSchema = z.object({
  sourceId: z.string(),
  fileExecution: z
    .object({
      id: z.string().uuid(),
      verification: z.literal('recorded_result'),
      replay: z.literal('not_captured')
    })
    .optional(),
  name: z.string(),
  sha256: z.string(),
  sheets: z.array(
    z.object({
      name: z.string(),
      firstRow: z.number().int(),
      lastRow: z.number().int(),
      columnCount: z.number().int(),
      sampleRows: z.array(
        z.object({
          row: z.number().int(),
          cells: z.array(
            z.object({
              column: z.string(),
              text: z.string(),
              type: z.string(),
              numberFormat: z.string().nullable(),
              formulaCached: z.boolean().nullable()
            })
          )
        })
      )
    })
  )
})
export const NaturalQuerySchema = AnalysisPlanSchema.omit({
  question: true,
  unit: true,
  period: true,
  rowScope: true
})
  .extend({
    key: z.string().regex(/^q[1-6]$/),
    filters: z
      .array(
        z
          .object({
            column: z.string(),
            operator: z.enum(['eq', 'neq', 'contains', 'in', 'gt', 'gte', 'lt', 'lte']),
            kind: z.enum(['text', 'number', 'date']).optional(),
            values: z.array(z.string().max(1000)).min(1).max(30).optional(),
            value: z.string().max(1000)
          })
          .strict()
      )
      .max(10)
      .default([])
  })
  .strict()
export const NaturalViewSchema = z
  .object({
    kind: z.enum(['summary', 'ranking', 'share', 'comparison', 'method']),
    queryKey: z.string().regex(/^q[1-6]$/),
    baselineQueryKey: z
      .string()
      .regex(/^q[1-6]$/)
      .optional(),
    chart: ChartKindSchema,
    limit: z.number().int().min(1).max(20).optional(),
    direction: z.enum(['ascending', 'descending']).optional()
  })
  .strict()
export const NaturalReadyPlanSchema = z
  .object({
    status: z.literal('ready'),
    queries: z.array(NaturalQuerySchema).min(1).max(6),
    views: z.array(NaturalViewSchema).min(1).max(8),
    frame: FrameDraftSchema.optional()
  })
  .strict()
export const NaturalDecisionSchema = z.discriminatedUnion('status', [
  NaturalReadyPlanSchema,
  z.object({ status: z.literal('clarify'), message: z.string().trim().min(1).max(800) }).strict(),
  z
    .object({ status: z.literal('unsupported'), message: z.string().trim().min(1).max(800) })
    .strict()
])
export const NaturalReviewSchema = z.discriminatedUnion('decision', [
  z
    .object({
      decision: z.literal('confirm'),
      decisions: z.array(FrameDecisionSchema).max(8).optional()
    })
    .strict(),
  z.object({ decision: z.literal('clarify'), message: z.string().trim().min(1).max(800) }).strict(),
  z.object({ decision: z.literal('revise'), plan: NaturalReadyPlanSchema }).strict()
])
export const NaturalDerivedSchema = z.object({
  id: z.string(),
  kind: z.enum(['share', 'difference', 'percent_change']),
  viewIndex: z.number().int(),
  category: z.string(),
  value: z.string().nullable(),
  exact: z.string(),
  formula: z.string(),
  numerator: z.string(),
  denominator: z.string(),
  unit: z.string(),
  reason: z.literal('ZERO_DENOMINATOR').nullable(),
  inputs: z.array(
    z.object({ runId: z.string(), valueId: z.string(), category: z.string(), value: z.string() })
  )
})
export const NaturalContextSchema = z.object({
  parentTurnId: z.string().uuid(),
  parentCandidateHash: z.string(),
  questionId: z.string().uuid().optional(),
  depth: z.number().int().min(1).max(12),
  scope: z
    .object({
      queryKey: z.string().regex(/^q[1-6]$/),
      sourceSha256: z.string(),
      plan: AnalysisPlanSchema,
      selected: z
        .object({ valueId: z.string(), category: z.string(), value: z.string(), exact: z.string() })
        .optional()
    })
    .optional()
})
export const NaturalTurnSchema = z.object({
  retrieval: RetrievalTraceSchema.optional(),
  id: z.string(),
  createdAt: z.string(),
  question: z.string(),
  model: AnalysisModelSchema,
  state: z.enum(['answered', 'clarify', 'unsupported']),
  message: z.string(),
  framework: AnalysisFrameSchema.optional(),
  context: NaturalContextSchema.optional(),
  plan: NaturalReadyPlanSchema.nullable(),
  queryRuns: z.array(z.object({ key: z.string(), runId: z.string() })),
  derived: z.array(NaturalDerivedSchema),
  review: z.object({
    version: z.literal('natural/1'),
    modelCalls: z.number().int(),
    confirmed: z.boolean()
  }),
  answer: z.object({
    status: z.enum(['draft', 'published']),
    candidateHash: z.string(),
    publishedAt: z.string().nullable()
  })
})
export const NaturalAskSchema = z.object({
  retrieval: RetrievalSelectionSchema.optional(),
  requestId: z.string().uuid(),
  question: z.string().trim().min(1).max(4000),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  continuation: ContinuationRequestSchema.optional(),
  newRoot: z.boolean().optional()
})
export const NaturalProgressSchema = z.object({
  requestId: z.string(),
  stage: z.enum([
    'preparing',
    'planning',
    'calculating',
    'reviewing',
    'saving',
    'reading_structure',
    'planning_fetch',
    'fetching'
  ]),
  startedAt: z.string()
})
export type AnalysisModel = z.infer<typeof AnalysisModelSchema>
export type WorkbookCatalog = z.infer<typeof WorkbookCatalogSchema>
export type NaturalReadyPlan = z.infer<typeof NaturalReadyPlanSchema>
export type NaturalDecision = z.infer<typeof NaturalDecisionSchema>
export type NaturalTurn = z.infer<typeof NaturalTurnSchema>
export type NaturalDerived = z.infer<typeof NaturalDerivedSchema>
export type NaturalContext = z.infer<typeof NaturalContextSchema>
export type NaturalAsk = z.infer<typeof NaturalAskSchema>
export type NaturalProgress = z.infer<typeof NaturalProgressSchema>

export const AnalysisTaskSchema = z.object({
  projectDir: z.string().nullable().optional(),
  isPinned: z.boolean().optional(),
  branch: z
    .object({
      taskId: z.string(),
      sessionId: z.string(),
      messageId: z.string(),
      createdAt: z.string(),
      requiresReconnection: z.boolean()
    })
    .optional(),
  version: z.literal(1),
  id: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  sources: z.array(AnalysisSourceSchema),
  runs: z.array(AnalysisRunSchema),
  turns: z.array(NaturalTurnSchema).default([])
})
export const AnalysisTaskSummarySchema = AnalysisTaskSchema.pick({
  id: true,
  title: true,
  createdAt: true,
  updatedAt: true
}).extend({
  sourceCount: z.number().int(),
  runCount: z.number().int(),
  projectDir: z.string().nullable().optional(),
  isPinned: z.boolean().optional()
})
export const AnalysisPreviewSchema = z.object({
  sourceId: z.string(),
  sha256: z.string(),
  changed: z.boolean(),
  sheet: z.string(),
  headerRow: z.number().int(),
  page: z.number().int(),
  pageCount: z.number().int(),
  totalRows: z.number().int(),
  columns: z.array(AnalysisColumnSchema),
  rows: z.array(
    z.object({
      rowNumber: z.number().int(),
      cells: z.array(
        z.object({
          address: z.string(),
          display: z.string(),
          formula: z.string().nullable(),
          error: z.boolean()
        })
      )
    })
  )
})
export type AnalysisPlan = z.infer<typeof AnalysisPlanSchema>
export type AnalysisSource = z.infer<typeof AnalysisSourceSchema>
export type AnalysisRun = z.infer<typeof AnalysisRunSchema>
export type AnalysisTask = z.infer<typeof AnalysisTaskSchema>
export type AnalysisTaskSummary = z.infer<typeof AnalysisTaskSummarySchema>
export type AnalysisPreview = z.infer<typeof AnalysisPreviewSchema>
