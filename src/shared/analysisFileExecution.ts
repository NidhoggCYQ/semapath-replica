import { z } from 'zod'

const sha = z.string().regex(/^[a-f0-9]{64}$/)
export const FileExecutionInputSchema = z
  .object({
    sourceId: z.string().min(1).max(200).optional(),
    path: z.string().min(1).max(4096).optional(),
    sheet: z.string().min(1).max(255).optional(),
    range: z
      .string()
      .regex(/^[A-Z]{1,3}[1-9]\d*(?::[A-Z]{1,3}[1-9]\d*)?$/)
      .optional()
  })
  .strict()
  .refine((input) => !!input.sourceId !== !!input.path, 'Choose sourceId or path')
  .refine((input) => !input.range || !!input.sheet, 'A range requires a sheet')
export const FileExecutionInputsSchema = z.array(FileExecutionInputSchema).min(1).max(8)
export type FileExecutionInput = z.infer<typeof FileExecutionInputSchema>
export const FileExecutionCapturedInputSchema = z.object({
  sourceId: z.string(),
  name: z.string(),
  sha256: sha,
  bytes: z.number().int().nonnegative(),
  sheet: z.string().optional(),
  range: z.string().optional()
})
export const FileExecutionTableSchema = z.object({
  title: z.string().trim().min(1).max(200),
  columns: z.array(z.string().trim().min(1).max(500)).min(1).max(256),
  columnTypes: z
    .array(z.enum(['number', 'text', 'boolean', 'date']))
    .min(1)
    .max(256),
  rows: z.array(z.array(z.string().nullable()).max(256)).max(50000),
  excelDates: z
    .array(
      z.object({
        row: z.number().int().nonnegative(),
        column: z.number().int().nonnegative(),
        serial: z.string().max(256),
        format: z.string().max(256),
        date1904: z.boolean()
      })
    )
    .max(500000)
    .optional()
})
export type FileExecutionTable = z.infer<typeof FileExecutionTableSchema>
export const FileExecutionOriginSchema = z.object({
  version: z.literal('file-execution/1'),
  id: z.string().uuid(),
  tableIndex: z.number().int().nonnegative(),
  startedAt: z.string(),
  finishedAt: z.string(),
  command: z.string().max(131072),
  commandSha256: sha,
  resultSha256: sha,
  tableSha256: sha,
  skillStatus: z.enum(['loaded', 'not_loaded']),
  inputs: z.array(FileExecutionCapturedInputSchema).min(1).max(8),
  table: FileExecutionTableSchema,
  verification: z.literal('recorded_result'),
  replay: z.literal('not_captured')
})
export type FileExecutionOrigin = z.infer<typeof FileExecutionOriginSchema>

export type FileExecutionRequest = {
  sessionId: string
  messageId: string
  toolCallId: string
  command: string
  cwd: string
  inputs: FileExecutionInput[]
  activeSkillNames: string[]
}
export type FileExecutionDelivery = {
  executionId: string
  state: 'ready' | 'failed' | 'interrupted'
  issue?: string
  sources: Array<{ id: string; name: string; sha256: string; tableIndex: number }>
  instruction: string
}
export type FileExecutionPreparation = {
  id: string
  env: Record<string, string>
  cached?: FileExecutionDelivery
}
export interface FileExecutionPort {
  prepare(request: FileExecutionRequest, signal?: AbortSignal): Promise<FileExecutionPreparation>
  started(sessionId: string, id: string): void
  finish(
    sessionId: string,
    id: string,
    result: { exitCode: number | null; timedOut: boolean },
    signal?: AbortSignal
  ): Promise<FileExecutionDelivery>
  failed(sessionId: string, id: string, issue: string): FileExecutionDelivery
}
