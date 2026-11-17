import { z } from 'zod'

export const PbiEnvironmentSchema = z.enum(['global', 'china'])
export const PbiApplicationSchema = z
  .object({
    clientId: z.string().uuid().toLowerCase(),
    tenantId: z.string().uuid().toLowerCase(),
    environment: PbiEnvironmentSchema
  })
  .strict()
export const PbiAccountSchema = z.object({
  id: z.string(),
  username: z.string(),
  name: z.string(),
  tenantId: z.string()
})
export const PbiAuthStatusSchema = z.object({
  application: PbiApplicationSchema.nullable(),
  account: PbiAccountSchema.nullable()
})
export const PbiLocalModelSchema = z
  .object({
    id: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    databaseId: z.string().min(1).max(512),
    name: z.string(),
    processId: z.number().int().positive(),
    startedAt: z.string()
  })
  .strict()
export const PbiWorkspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  dedicated: z.boolean().nullable()
})
export const PbiCloudModelSchema = z
  .object({
    accountId: z.string().min(1),
    workspaceId: z.string().uuid().nullable(),
    datasetId: z.string().uuid(),
    name: z.string()
  })
  .strict()
export const PbiTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local'), model: PbiLocalModelSchema }).strict(),
  z.object({ kind: z.literal('cloud'), model: PbiCloudModelSchema }).strict()
])
export const PbiBindingSchema = z.object({
  id: z.string().uuid(),
  target: PbiTargetSchema,
  createdAt: z.string()
})
const coverage = z.enum(['available', 'partial', 'unavailable'])
export const PbiSchemaSchema = z.object({
  fetchedAt: z.string(),
  source: z.enum(['local_tom', 'cloud_xmla', 'fabric_tmsl', 'rest_visible']),
  coverage: z.object({
    tables: coverage,
    columns: coverage,
    measures: coverage,
    relationships: coverage
  }),
  tables: z.array(
    z.object({
      name: z.string(),
      hidden: z.boolean(),
      description: z.string(),
      columns: z.array(
        z.object({
          name: z.string(),
          type: z.string(),
          hidden: z.boolean(),
          formatString: z.string(),
          expression: z.string()
        })
      ),
      measures: z.array(
        z.object({
          name: z.string(),
          expression: z.string(),
          formatString: z.string(),
          description: z.string(),
          hidden: z.boolean()
        })
      )
    })
  ),
  relationships: z.array(
    z.object({
      name: z.string(),
      fromTable: z.string(),
      fromColumn: z.string(),
      toTable: z.string(),
      toColumn: z.string(),
      active: z.boolean(),
      crossFilter: z.string()
    })
  ),
  issues: z.array(
    z.object({
      area: z.enum(['tables', 'columns', 'measures', 'relationships', 'model']),
      code: z.string()
    })
  )
})
export const PbiTableSchema = z.object({
  columns: z.array(z.object({ name: z.string(), type: z.string() })).max(40),
  rows: z.array(z.array(z.string().nullable()).max(40)).max(5000),
  complete: z.literal(true)
})
export const PbiQuerySchema = z
  .object({
    requestId: z.string().uuid(),
    bindingId: z.string().uuid(),
    title: z.string().trim().min(1).max(100),
    dax: z.string().trim().min(1).max(20000),
    transport: z.enum(['rest', 'xmla']).default('rest')
  })
  .strict()
export const PbiProgressSchema = z.object({
  requestId: z.string(),
  stage: z.enum(['connecting', 'authenticating', 'metadata', 'querying', 'saving']),
  startedAt: z.string()
})
export const PbiProvenanceSchema = z
  .object({
    kind: z.enum(['local', 'cloud']),
    transport: z.enum(['adomd', 'rest', 'xmla']),
    modelId: z.string(),
    modelName: z.string(),
    workspaceId: z.string().nullable(),
    workspaceName: z.string().optional(),
    environment: PbiEnvironmentSchema.optional(),
    tenantId: z.string().optional(),
    accountId: z.string().optional(),
    local: z
      .object({
        processId: z.number().int(),
        startedAt: z.string(),
        port: z.number().int(),
        identity: z.string()
      })
      .optional(),
    querySha256: z.string().regex(/^[a-f0-9]{64}$/),
    complete: z.literal(true),
    precision: z.enum(['native_strings', 'lossless_json']),
    requestId: z.string().optional(),
    schema: PbiSchemaSchema.optional(),
    schemaSha256: z.string().optional()
  })
  .strict()
export type PbiApplication = z.infer<typeof PbiApplicationSchema>
export type PbiAccount = z.infer<typeof PbiAccountSchema>
export type PbiAuthStatus = z.infer<typeof PbiAuthStatusSchema>
export type PbiLocalModel = z.infer<typeof PbiLocalModelSchema>
export type PbiCloudModel = z.infer<typeof PbiCloudModelSchema>
export type PbiTarget = z.infer<typeof PbiTargetSchema>
export type PbiBinding = z.infer<typeof PbiBindingSchema>
export type PbiSchema = z.infer<typeof PbiSchemaSchema>
export type PbiTable = z.infer<typeof PbiTableSchema>
export type PbiQuery = z.infer<typeof PbiQuerySchema>
export type PbiProgress = z.infer<typeof PbiProgressSchema>
export type PbiProvenance = z.infer<typeof PbiProvenanceSchema>
