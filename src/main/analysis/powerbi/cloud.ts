import { z } from 'zod'
import {
  PbiSchemaSchema,
  PbiTableSchema,
  type PbiCloudModel,
  type PbiSchema
} from '@shared/analysisPowerBi'
import { AnalysisError } from '../errors'
import type { PbiAuth } from './auth'
import type { PbiBridge } from './bridge'
import { PBI_CLOUDS } from './clouds'
import { parseDaxResult } from './rest'
import { readOnlyDax } from './dax'

const Workspace = z.object({
  id: z.string().uuid(),
  name: z.string(),
  isOnDedicatedCapacity: z.boolean().optional()
})
const Dataset = z.object({ id: z.string().uuid(), name: z.string() })
export const NativeQuerySchema = z.object({
  data: PbiTableSchema,
  schema: PbiSchemaSchema,
  schemaSha256: z.string().regex(/^[a-f0-9]{64}$/)
})
export class PbiCloud {
  constructor(
    private readonly auth: PbiAuth,
    private readonly bridge: PbiBridge,
    private readonly fetcher: typeof fetch = (input, options) => fetch(input, options)
  ) {}
  private async request(account: string, endpoint: string, signal: AbortSignal, body?: object) {
    const epoch = this.auth.epoch,
      app = this.auth.application(),
      cloud = PBI_CLOUDS[app.environment]
    const base = cloud.rest
    const token = await this.auth.token(account, signal)
    this.auth.assertCurrent(account, epoch)
    signal.throwIfAborted()
    let response: Response
    try {
      response = await this.fetcher(base + endpoint, {
        method: body ? 'POST' : 'GET',
        redirect: 'error',
        signal,
        headers: {
          Authorization: 'Bearer ' + token.accessToken,
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      })
    } catch {
      if (signal.aborted) throw signal.reason
      throw new AnalysisError('PBI_CONNECT_FAILED')
    }
    this.auth.assertCurrent(account, epoch)
    if (!response.ok) {
      await response.body?.cancel()
      throw new AnalysisError(
        response.status === 401
          ? 'PBI_AUTH_REQUIRED'
          : response.status === 403
            ? 'PBI_PERMISSION'
            : response.status === 429
              ? 'PBI_THROTTLED'
              : response.status === 404
                ? 'PBI_NOT_FOUND'
                : 'PBI_QUERY_FAILED'
      )
    }
    const reader = response.body?.getReader()
    if (!reader) throw new AnalysisError('PBI_PROTOCOL')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        if (size > 8 * 1024 * 1024) throw new AnalysisError('PBI_LIMIT')
        chunks.push(part.value)
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    signal.throwIfAborted()
    this.auth.assertCurrent(account, epoch)
    return {
      text: Buffer.concat(chunks).toString('utf8'),
      status: response.status,
      requestId: response.headers.get('requestid')?.slice(0, 200)
    }
  }
  async workspaces(account: string, signal: AbortSignal) {
    const all: z.infer<typeof Workspace>[] = []
    for (let skip = 0; skip <= 5000; skip += 100) {
      const response = await this.request(account, '/groups?$top=100&$skip=' + skip, signal)
      const page = z.object({ value: z.array(Workspace) }).parse(JSON.parse(response.text)).value
      all.push(...page)
      if (all.length > 5000) throw new AnalysisError('PBI_LIMIT')
      if (page.length < 100)
        return all.map((w) => ({
          id: w.id,
          name: w.name,
          dedicated: w.isOnDedicatedCapacity ?? null
        }))
    }
    throw new AnalysisError('PBI_LIMIT')
  }
  async models(account: string, workspaceId: string | null, signal: AbortSignal) {
    if (workspaceId) z.string().uuid().parse(workspaceId)
    const response = await this.request(
      account,
      (workspaceId ? '/groups/' + workspaceId : '') + '/datasets',
      signal
    )
    const page = z
      .object({ value: z.array(Dataset).max(5000) })
      .parse(JSON.parse(response.text)).value
    return page.map((m) => ({ accountId: account, workspaceId, datasetId: m.id, name: m.name }))
  }
  async resolve(model: PbiCloudModel, signal: AbortSignal, xmla = false) {
    const workspace = model.workspaceId
      ? (await this.workspaces(model.accountId, signal)).find(
          (w) => w.id.toLowerCase() === model.workspaceId!.toLowerCase()
        )
      : undefined
    if (model.workspaceId && !workspace) throw new AnalysisError('PBI_NOT_FOUND')
    if (xmla) {
      if (!workspace) throw new AnalysisError('PBI_METADATA_UNAVAILABLE')
      const same = (await this.workspaces(model.accountId, signal)).filter(
        (w) => w.name.toLowerCase() === workspace.name.toLowerCase()
      )
      if (same.length !== 1) throw new AnalysisError('PBI_METADATA_UNAVAILABLE')
    }
    const current = (await this.models(model.accountId, model.workspaceId, signal)).find(
      (m) => m.datasetId.toLowerCase() === model.datasetId.toLowerCase()
    )
    if (!current) throw new AnalysisError('PBI_MODEL_CHANGED')
    return { model: current, workspaceName: workspace?.name }
  }
  private async xmlaModel(model: PbiCloudModel, signal: AbortSignal) {
    const resolved = await this.resolve(model, signal, true),
      application = this.auth.application(),
      token = await this.auth.token(model.accountId, signal)
    return {
      ...resolved,
      privateTarget: {
        ...resolved.model,
        workspaceName: resolved.workspaceName,
        environment: application.environment,
        tenantId: application.tenantId,
        ...token
      }
    }
  }
  async schema(model: PbiCloudModel, signal: AbortSignal): Promise<PbiSchema> {
    const target = await this.xmlaModel(model, signal)
    return this.bridge.request(
      'cloud.schema',
      { model: target.privateTarget },
      PbiSchemaSchema,
      signal
    )
  }
  async query(model: PbiCloudModel, dax: string, transport: 'rest' | 'xmla', signal: AbortSignal) {
    readOnlyDax(dax)
    if (transport === 'xmla') {
      const target = await this.xmlaModel(model, signal)
      const result = await this.bridge.request(
        'cloud.query',
        { model: target.privateTarget, dax },
        NativeQuerySchema,
        signal
      )
      return { ...result, model: target.model, workspaceName: target.workspaceName }
    }
    const resolved = await this.resolve(model, signal)
    const response = await this.request(
      model.accountId,
      (model.workspaceId ? '/groups/' + model.workspaceId : '') +
        '/datasets/' +
        model.datasetId +
        '/executeQueries',
      signal,
      { queries: [{ query: dax }], serializerSettings: { includeNulls: true } }
    )
    return {
      data: parseDaxResult(response.text),
      model: resolved.model,
      workspaceName: resolved.workspaceName,
      requestId: response.requestId
    }
  }
}
