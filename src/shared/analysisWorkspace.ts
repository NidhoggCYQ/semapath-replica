import { z } from 'zod'

export const AnalysisWorkspaceEntrySchema = z.object({
  id: z.string(),
  taskId: z.string().uuid().nullable(),
  sessionId: z.string().nullable(),
  title: z.string(),
  projectDir: z.string().nullable(),
  isPinned: z.boolean(),
  sessionMissing: z.boolean(),
  sourceCount: z.number().int().nonnegative(),
  runCount: z.number().int().nonnegative(),
  updatedAt: z.string()
})
export type AnalysisWorkspaceEntry = z.infer<typeof AnalysisWorkspaceEntrySchema>
export const AnalysisToolRecordSchema = z.object({
  id: z.string(),
  tool: z.string(),
  state: z.enum(['running', 'succeeded', 'failed', 'interrupted']),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable()
})
export type AnalysisToolRecord = z.infer<typeof AnalysisToolRecordSchema>

export const ANALYSIS_TOOL_SERVER = 'semapath-analysis'
export const ANALYSIS_TOOL_NAMES = [
  'datasource_context',
  'datasource_schema',
  'datasource_query',
  'analysis_evidence',
  'analysis_get',
  'analysis_frame',
  'analysis_progress',
  'tool_schema',
  'arguments_repair',
  'chart_schema',
  'answer_submit',
  'answer_confirm',
  'answer_resume',
  'report_export'
] as const
export type AnalysisToolName = (typeof ANALYSIS_TOOL_NAMES)[number]
export const isAnalysisToolName = (name: string): name is AnalysisToolName =>
  (ANALYSIS_TOOL_NAMES as readonly string[]).includes(name)
