import { z } from 'zod'
import { StudyPlanSchema } from './analysisStudy'

const uuid = z.string().uuid()
const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const DataReferenceSelectorSchema = z
  .object({
    kind: z.enum(['source', 'table', 'column', 'measure']),
    sourceId: uuid.optional(),
    targetId: z.string().min(1).max(200).optional(),
    sheet: z.string().max(200).optional(),
    headerRow: z.number().int().min(1).max(1000000).optional(),
    table: z.string().max(500).optional(),
    column: z.string().max(500).optional(),
    measure: z.string().max(500).optional(),
    transport: z.enum(['rest', 'xmla']).optional()
  })
  .strict()
export type DataReferenceSelector = z.infer<typeof DataReferenceSelectorSchema>
export const DataReferenceSchema = z.object({
  id: hash,
  kind: z.enum(['source', 'table', 'column', 'measure']),
  label: z.string(),
  description: z.string(),
  version: hash,
  selector: DataReferenceSelectorSchema
})
export type DataReference = z.infer<typeof DataReferenceSchema>
export const ReferenceCatalogSchema = z.object({
  items: z.array(DataReferenceSchema),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  issues: z.array(z.object({ source: z.string(), code: z.string() }))
})

export const QuoteOriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message'), messageId: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('turn'), turnId: uuid, candidateHash: hash }).strict(),
  z.object({ kind: z.literal('run'), runId: uuid, candidateHash: hash }).strict()
])
export type QuoteOrigin = z.infer<typeof QuoteOriginSchema>
export const AnalysisContextSchema = z.object({
  id: uuid,
  taskId: uuid,
  kind: z.enum(['data', 'quote']),
  label: z.string(),
  createdAt: z.string(),
  reference: DataReferenceSchema.optional(),
  quote: z
    .object({
      text: z.string().min(1).max(2000),
      origin: QuoteOriginSchema,
      sourceHash: hash,
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative()
    })
    .optional()
})
export type AnalysisContext = z.infer<typeof AnalysisContextSchema>
export const AnalysisContextViewSchema = z.object({
  context: AnalysisContextSchema,
  status: z.enum(['current', 'changed', 'missing', 'unavailable']),
  source: z.record(z.string(), z.unknown()).optional()
})

const nullableId = z.string().max(200).nullable()
export const TaskPanelStateSchema = z
  .object({
    version: z.literal(1).default(1),
    tab: z.enum(['conversation', 'analysis', 'evidence', 'files', 'reports']).default('analysis'),
    mode: z.enum(['natural', 'manual']).default('natural'),
    connector: z.enum(['excel', 'file', 'sql', 'localPbi', 'cloudPbi']).default('excel'),
    connectionsOpen: z.boolean().default(false),
    calculationOpen: z.boolean().default(true),
    toolsOpen: z.boolean().default(false),
    sourceId: nullableId.default(null),
    sheet: z.string().max(200).default(''),
    headerRow: z.number().int().min(1).max(1000000).default(1),
    runId: nullableId.default(null),
    valueIndex: z.number().int().min(0).max(1000000).default(0),
    turnId: nullableId.default(null),
    reportTarget: z
      .object({ kind: z.enum(['run', 'turn']), id: uuid })
      .nullable()
      .default(null),
    scroll: z.record(z.string(), z.number().min(0).max(10000000)).default({}),
    sidepanel: z
      .object({
        open: z.boolean(),
        tab: z.enum(['workspace', 'browser']),
        width: z.number().min(240).max(960),
        navWidth: z.number().min(160).max(360),
        navCollapsed: z.boolean()
      })
      .optional(),
    manual: z
      .object({
        question: z.string().max(10000),
        unit: z.string().max(500),
        period: z.string().max(1000),
        measure: z.string().max(500),
        groupBy: z.string().max(500),
        operation: z.enum(['sum', 'average', 'count', 'min', 'max']),
        filterColumn: z.string().max(500),
        filterOperator: z.enum(['eq', 'neq', 'in', 'contains', 'gt', 'gte', 'lt', 'lte']),
        filterValue: z.string().max(1000),
        study: StudyPlanSchema.optional()
      })
      .optional(),
    selectedDerived: z
      .object({ turnId: uuid, factId: z.string().max(200) })
      .nullable()
      .optional()
  })
  .strict()
export type TaskPanelState = z.infer<typeof TaskPanelStateSchema>
// Zod 4 keeps inner defaults in partial objects; updates must omit unspecified fields.
const panelFields = TaskPanelStateSchema.shape
export const TaskPanelStatePatchSchema = z
  .object({
    ...panelFields,
    version: panelFields.version.removeDefault(),
    tab: panelFields.tab.removeDefault(),
    mode: panelFields.mode.removeDefault(),
    connector: panelFields.connector.removeDefault(),
    connectionsOpen: panelFields.connectionsOpen.removeDefault(),
    calculationOpen: panelFields.calculationOpen.removeDefault(),
    toolsOpen: panelFields.toolsOpen.removeDefault(),
    sourceId: panelFields.sourceId.removeDefault(),
    sheet: panelFields.sheet.removeDefault(),
    headerRow: panelFields.headerRow.removeDefault(),
    runId: panelFields.runId.removeDefault(),
    valueIndex: panelFields.valueIndex.removeDefault(),
    turnId: panelFields.turnId.removeDefault(),
    reportTarget: panelFields.reportTarget.removeDefault(),
    scroll: panelFields.scroll.removeDefault()
  })
  .partial()
  .strict()
export const GuideStateSchema = z
  .object({
    version: z.literal(1).default(1),
    seen: z.boolean().default(false),
    topics: z
      .array(z.enum(['model', 'task', 'data', 'file', 'advanced']))
      .max(5)
      .default([]),
    exampleOpen: z.boolean().default(false)
  })
  .strict()
export type GuideState = z.infer<typeof GuideStateSchema>
const guideFields = GuideStateSchema.shape
export const GuideStatePatchSchema = z
  .object({
    version: guideFields.version.removeDefault(),
    seen: guideFields.seen.removeDefault(),
    topics: guideFields.topics.removeDefault(),
    exampleOpen: guideFields.exampleOpen.removeDefault()
  })
  .partial()
  .strict()

export const FOLLOWUP_INTENTS = ['why', 'expand', 'correct'] as const

/** Markdown formatting is not provenance. Positions refer to this normalized, saved text. */
export function normalizeQuoteText(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/[*_`#>~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
