import { z } from 'zod'
import { PbiProvenanceSchema } from './analysisPowerBi'
import { AcquisitionOriginSchema } from './analysisAcquisition'
import { FileExecutionOriginSchema } from './analysisFileExecution'

export const SqlConnectionInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(100),
    host: z.string().trim().min(1).max(255),
    port: z.number().int().min(1).max(65535),
    database: z.string().trim().min(1).max(100),
    user: z.string().trim().min(1).max(100),
    password: z.string().max(4096).optional(),
    tls: z.boolean()
  })
  .strict()
export const SqlConnectionSchema = SqlConnectionInputSchema.omit({
  password: true,
  id: true
}).extend({
  id: z.string().uuid(),
  hasPassword: z.boolean()
})
export const SqlTableSchema = z.object({
  name: z.string(),
  columns: z.array(z.object({ name: z.string(), type: z.string(), nullable: z.boolean() }))
})
export const SqlQueryInputSchema = z
  .object({
    requestId: z.string().uuid(),
    connectionId: z.string().uuid(),
    query: z.string().trim().min(1).max(20000),
    title: z.string().trim().min(1).max(100)
  })
  .strict()
export const SqlProgressSchema = z.object({
  requestId: z.string(),
  stage: z.enum(['connecting', 'querying', 'saving']),
  startedAt: z.string()
})
export const JoinInputSchema = z
  .object({
    title: z.string().trim().min(1).max(100),
    left: z
      .object({
        sourceId: z.string(),
        sheet: z.string(),
        headerRow: z.number().int().min(1),
        key: z.string()
      })
      .strict(),
    right: z
      .object({
        sourceId: z.string(),
        sheet: z.string(),
        headerRow: z.number().int().min(1),
        key: z.string()
      })
      .strict(),
    kind: z.enum(['left', 'inner']),
    cardinality: z.enum(['many_to_one', 'one_to_one']),
    keyKind: z.enum(['text', 'number'])
  })
  .strict()
export const SqlResultDataSchema = z.object({
  columns: z.array(z.string()).max(41),
  rows: z.array(z.array(z.string().nullable()).max(41)).max(5000)
})
export const OriginParentSchema = z
  .object({
    acquisition: AcquisitionOriginSchema.optional(),
    id: z.string(),
    name: z.string(),
    sha256: z.string(),
    sheet: z.string(),
    kind: z.enum(['file', 'mysql', 'join', 'powerbi', 'file_execution']),
    fileExecution: FileExecutionOriginSchema.optional(),
    query: z.string().optional(),
    database: z.string().optional(),
    result: SqlResultDataSchema.optional(),
    createdAt: z.string().optional(),
    types: z.array(z.object({ column: z.string(), type: z.string() })).optional(),
    serverVersion: z.string().optional(),
    powerBi: PbiProvenanceSchema.optional()
  })
  .refine(
    (origin) => origin.kind !== 'file_execution' || !!origin.fileExecution,
    'A file execution parent requires captured provenance'
  )
export const SourceOriginSchema = z
  .object({
    acquisition: AcquisitionOriginSchema.optional(),
    version: z.literal('dataset/1'),
    kind: z.enum(['mysql', 'join', 'powerbi', 'file_execution']),
    fileExecution: FileExecutionOriginSchema.optional(),
    title: z.string(),
    createdAt: z.string(),
    rows: z.number().int().nonnegative(),
    query: z.string().optional(),
    database: z.string().optional(),
    connectionName: z.string().optional(),
    serverVersion: z.string().optional(),
    powerBi: PbiProvenanceSchema.optional(),
    result: SqlResultDataSchema.optional(),
    types: z.array(z.object({ column: z.string(), type: z.string() })).optional(),
    join: JoinInputSchema.omit({ title: true }).optional(),
    parents: z.array(OriginParentSchema).max(8).optional(),
    columns: z
      .array(z.object({ output: z.string(), parent: z.number().int(), input: z.string() }))
      .optional(),
    rowMap: z
      .array(
        z.object({
          output: z.number().int().min(2),
          sources: z
            .array(
              z.object({
                parent: z.number().int().nonnegative(),
                row: z.number().int().min(2),
                cells: z.record(z.string(), z.string().nullable()).optional()
              })
            )
            .max(8)
        })
      )
      .max(2000)
      .optional(),
    steps: z
      .array(z.object({ input: JoinInputSchema, leftSha: z.string(), rightSha: z.string() }))
      .max(12)
      .optional(),
    matched: z.number().int().optional(),
    unmatched: z.number().int().optional(),
    missingLeftKeys: z.number().int().optional(),
    missingRightKeys: z.number().int().optional()
  })
  .refine(
    (origin) => origin.kind !== 'file_execution' || !!origin.fileExecution,
    'A file execution result requires captured provenance'
  )
export const OriginCellSchema = z.object({
  sourceId: z.string(),
  source: z.string(),
  sha256: z.string(),
  sheet: z.string(),
  cell: z.string(),
  value: z.string()
})
export const DatasetBuildSchema = z.object({ base64: z.string(), origin: SourceOriginSchema })
export type SqlConnectionInput = z.infer<typeof SqlConnectionInputSchema>
export type SqlConnection = z.infer<typeof SqlConnectionSchema>
export type SqlQueryInput = z.infer<typeof SqlQueryInputSchema>
export type JoinInput = z.infer<typeof JoinInputSchema>
export type SourceOrigin = z.infer<typeof SourceOriginSchema>
