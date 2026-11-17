import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { z } from 'zod'
import {
  PbiBindingSchema,
  PbiLocalModelSchema,
  PbiSchemaSchema,
  type PbiApplication,
  type PbiProgress,
  type PbiQuery,
  type PbiTarget,
  type PbiProvenance
} from '@shared/analysisPowerBi'
import type { PbiBinding, PbiSchema } from '@shared/analysisPowerBi'
import type { SnapshotPayload, RawDataSession } from '../retrieval/types'
import type { AnalysisService } from '../service'
import { AnalysisError } from '../errors'
import { PbiAuth } from './auth'
import { PbiBridge } from './bridge'
import { PbiCloud, NativeQuerySchema } from './cloud'
import { daxTableName, readOnlyDax } from './dax'

type Job = { owner: number; cloud: boolean; controller: AbortController; progress: PbiProgress }
const State = z.object({
  version: z.literal(1),
  bindings: z.record(z.string().uuid(), PbiBindingSchema)
})
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
export class PbiService {
  private readonly active = new Map<string, Job>()
  private state: z.infer<typeof State> | undefined
  constructor(
    private readonly analysis: Pick<AnalysisService, 'get' | 'addSnapshot'>,
    private readonly file: string,
    readonly auth: PbiAuth,
    private readonly bridge: PbiBridge = new PbiBridge(),
    private readonly cloud: PbiCloud = new PbiCloud(auth, bridge)
  ) {
    auth.onChange = () => {
      for (const job of this.active.values())
        if (job.cloud && job.progress.stage !== 'saving')
          job.controller.abort(new AnalysisError('PBI_ACCOUNT_CHANGED'))
    }
  }
  private load() {
    if (this.state) return this.state
    try {
      const bytes = readFileSync(this.file)
      if (bytes.length > 1024 * 1024) throw new Error()
      this.state = State.parse(JSON.parse(bytes.toString('utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        this.state = { version: 1, bindings: {} }
      else throw new AnalysisError('STORAGE_ERROR')
    }
    return this.state!
  }
  private save() {
    mkdirSync(path.dirname(this.file), { recursive: true })
    writeFileSync(this.file + '.tmp', JSON.stringify(this.load()), { mode: 0o600 })
    renameSync(this.file + '.tmp', this.file)
  }
  binding(taskId: string) {
    this.analysis.get(taskId)
    return this.load().bindings[taskId] ?? null
  }
  bind(taskId: string, target: PbiTarget) {
    this.analysis.get(taskId)
    if (this.active.has(taskId)) throw new AnalysisError('BUSY')
    if (target.kind === 'cloud') this.auth.assertCurrent(target.model.accountId)
    const binding = PbiBindingSchema.parse({
      id: randomUUID(),
      target,
      createdAt: new Date().toISOString()
    })
    this.load().bindings[taskId] = binding
    this.save()
    return binding
  }
  private selected(taskId: string, bindingId: string) {
    const binding = this.binding(taskId)
    if (!binding || binding.id !== bindingId) throw new AnalysisError('PBI_MODEL_CHANGED')
    return binding
  }
  private guardCloudChange() {
    if ([...this.active.values()].some((job) => job.cloud && job.progress.stage === 'saving'))
      throw new AnalysisError('BUSY')
  }
  configure(input: PbiApplication) {
    this.guardCloudChange()
    return this.auth.configure(input)
  }
  logout() {
    this.guardCloudChange()
    return this.auth.logout()
  }
  status(taskId: string) {
    this.analysis.get(taskId)
    return this.active.get(taskId)?.progress ?? null
  }
  cancel(taskId: string, requestId: string, owner: number) {
    const job = this.active.get(taskId)
    if (
      !job ||
      job.owner !== owner ||
      job.progress.requestId !== requestId ||
      job.progress.stage === 'saving'
    )
      return false
    job.controller.abort(new AnalysisError(job.cloud ? 'PBI_CLOUD_CANCELLED' : 'PBI_CANCELLED'))
    return true
  }
  cancelOwner(owner: number) {
    for (const [id, job] of this.active)
      if (job.owner === owner) this.cancel(id, job.progress.requestId, owner)
  }
  dispose() {
    for (const job of this.active.values())
      if (job.progress.stage !== 'saving') job.controller.abort(new AnalysisError('PBI_CANCELLED'))
    this.bridge.dispose()
  }
  private async run<T>(
    taskId: string,
    requestId: string,
    owner: number,
    cloud: boolean,
    action: (job: Job) => Promise<T>,
    timeout = 120000,
    external?: AbortSignal
  ) {
    this.analysis.get(taskId)
    if (this.active.has(taskId) || this.active.size >= 4) throw new AnalysisError('BUSY')
    const job: Job = {
      owner,
      cloud,
      controller: new AbortController(),
      progress: { requestId, stage: 'connecting', startedAt: new Date().toISOString() }
    }
    const epoch = this.auth.epoch
    this.active.set(taskId, job)
    const abort = () => job.controller.abort(external?.reason ?? new AnalysisError('PBI_CANCELLED'))
    external?.addEventListener('abort', abort, { once: true })
    if (external?.aborted) abort()
    const timer = setTimeout(() => {
      if (job.progress.stage !== 'saving') job.controller.abort(new AnalysisError('PBI_TIMEOUT'))
    }, timeout)
    try {
      const result = await action(job)
      job.controller.signal.throwIfAborted()
      if (cloud && epoch !== this.auth.epoch) throw new AnalysisError('PBI_ACCOUNT_CHANGED')
      return result
    } finally {
      external?.removeEventListener('abort', abort)
      clearTimeout(timer)
      if (this.active.get(taskId) === job) this.active.delete(taskId)
    }
  }
  login(taskId: string, requestId: string, owner: number) {
    this.guardCloudChange()
    return this.run(
      taskId,
      requestId,
      owner,
      false,
      async (job) => {
        job.progress.stage = 'authenticating'
        return this.auth.login(job.controller.signal)
      },
      300000
    )
  }
  discover(taskId: string, requestId: string, owner: number, port?: number) {
    return this.run(taskId, requestId, owner, false, (job) =>
      this.bridge.request(
        port ? 'local.connect' : 'local.discover',
        port ? { port } : {},
        z.array(PbiLocalModelSchema).max(100),
        job.controller.signal
      )
    )
  }
  workspaces(taskId: string, requestId: string, accountId: string, owner: number) {
    return this.run(taskId, requestId, owner, true, (job) =>
      this.cloud.workspaces(accountId, job.controller.signal)
    )
  }
  models(
    taskId: string,
    requestId: string,
    accountId: string,
    workspaceId: string | null,
    owner: number
  ) {
    return this.run(taskId, requestId, owner, true, (job) =>
      this.cloud.models(accountId, workspaceId, job.controller.signal)
    )
  }
  schema(taskId: string, requestId: string, bindingId: string, owner: number) {
    const binding = this.selected(taskId, bindingId),
      target = binding.target
    return this.run(taskId, requestId, owner, target.kind === 'cloud', async (job) => {
      job.progress.stage = 'metadata'
      const result =
        target.kind === 'local'
          ? await this.bridge.request(
              'local.schema',
              { model: target.model },
              PbiSchemaSchema,
              job.controller.signal
            )
          : await this.cloud.schema(target.model, job.controller.signal)
      this.selected(taskId, binding.id)
      return result
    })
  }
  preview(
    taskId: string,
    requestId: string,
    bindingId: string,
    table: string,
    transport: 'rest' | 'xmla',
    owner: number
  ) {
    const binding = this.selected(taskId, bindingId),
      target = binding.target
    return this.run(taskId, requestId, owner, target.kind === 'cloud', async (job) => {
      job.progress.stage = 'querying'
      const dax = 'EVALUATE TOPN(50, ' + daxTableName(table) + ')'
      const result =
        target.kind === 'local'
          ? await this.bridge.request(
              'local.query',
              { model: target.model, dax },
              NativeQuerySchema,
              job.controller.signal
            )
          : await this.cloud.query(target.model, dax, transport, job.controller.signal)
      this.selected(taskId, binding.id)
      return result.data
    })
  }
  private async snapshot(
    taskId: string,
    binding: PbiBinding,
    input: PbiQuery,
    job: Job
  ): Promise<SnapshotPayload> {
    const target = binding.target,
      dax = readOnlyDax(input.dax)
    job.progress.stage = 'querying'
    const result =
      target.kind === 'local'
        ? await this.bridge.request(
            'local.query',
            { model: target.model, dax },
            NativeQuerySchema,
            job.controller.signal
          )
        : await this.cloud.query(target.model, dax, input.transport, job.controller.signal)
    job.controller.signal.throwIfAborted()
    this.selected(taskId, binding.id)
    const ordinal = '结果行号'
    if (
      result.data.columns.some((c) => c.name === ordinal) ||
      result.data.rows.some((row) => row.length !== result.data.columns.length)
    )
      throw new AnalysisError('PBI_QUERY_FAILED')
    const provenance: PbiProvenance = {
      kind: target.kind,
      transport: target.kind === 'local' ? 'adomd' : input.transport,
      modelId: target.kind === 'local' ? target.model.databaseId : target.model.datasetId,
      modelName: 'model' in result ? result.model.name : target.model.name,
      workspaceId: target.kind === 'cloud' ? target.model.workspaceId : null,
      querySha256: sha(dax),
      complete: true,
      precision:
        target.kind === 'local' || input.transport === 'xmla' ? 'native_strings' : 'lossless_json',
      ...('schema' in result
        ? {
            schema: result.schema,
            schemaSha256: sha(
              JSON.stringify({
                tables: result.schema.tables,
                relationships: result.schema.relationships
              })
            )
          }
        : {}),
      ...(target.kind === 'local'
        ? {
            local: {
              processId: target.model.processId,
              startedAt: target.model.startedAt,
              port: target.model.port,
              identity: target.model.id
            }
          }
        : {
            environment: this.auth.application().environment,
            tenantId: this.auth.application().tenantId,
            accountId: target.model.accountId,
            ...('workspaceName' in result && result.workspaceName
              ? { workspaceName: result.workspaceName }
              : {}),
            ...('requestId' in result && result.requestId ? { requestId: result.requestId } : {})
          })
    }
    const data = {
      columns: [ordinal, ...result.data.columns.map((c) => c.name)],
      rows: result.data.rows.map((row, i) => [String(i + 1), ...row])
    }
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([data.columns, ...data.rows]),
      '数据'
    )
    const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer
    job.controller.signal.throwIfAborted()
    this.selected(taskId, binding.id)
    if (target.kind === 'cloud') this.auth.assertCurrent(target.model.accountId)
    return {
      bytes,
      origin: {
        version: 'dataset/1',
        kind: 'powerbi',
        title: input.title,
        createdAt: new Date().toISOString(),
        rows: data.rows.length,
        query: dax,
        database: provenance.modelId,
        connectionName: provenance.modelName,
        result: data,
        powerBi: provenance,
        types: [
          { column: 'A', type: 'RESULT_ROW_ORDINAL' },
          ...result.data.columns.map((c, i) => ({
            column: XLSX.utils.encode_col(i + 1),
            type: c.type
          }))
        ]
      }
    }
  }
  query(taskId: string, input: PbiQuery, owner: number) {
    const binding = this.selected(taskId, input.bindingId)
    return this.run(
      taskId,
      input.requestId,
      owner,
      binding.target.kind === 'cloud',
      async (job) => {
        const payload = await this.snapshot(taskId, binding, input, job)
        job.progress.stage = 'saving'
        return this.analysis.addSnapshot(taskId, payload.bytes, payload.origin)
      }
    )
  }
  withNatural<T>(
    taskId: string,
    bindingId: string,
    transport: 'rest' | 'xmla',
    requestId: string,
    owner: number,
    signal: AbortSignal,
    action: (session: RawDataSession<PbiSchema>) => Promise<T>
  ) {
    const binding = this.selected(taskId, bindingId),
      epoch = this.auth.epoch,
      target = binding.target
    return this.run(
      taskId,
      requestId,
      owner,
      target.kind === 'cloud',
      async (job) => {
        const validate = () => {
          job.controller.signal.throwIfAborted()
          this.selected(taskId, bindingId)
          if (target.kind === 'cloud') this.auth.assertCurrent(target.model.accountId, epoch)
        }
        return action({
          signal: job.controller.signal,
          schema: async () => {
            validate()
            job.progress.stage = 'metadata'
            const result =
              target.kind === 'local'
                ? await this.bridge.request(
                    'local.schema',
                    { model: target.model },
                    PbiSchemaSchema,
                    job.controller.signal
                  )
                : await this.cloud.schema(target.model, job.controller.signal)
            validate()
            return result
          },
          query: async (dax, title) => {
            validate()
            const payload = await this.snapshot(
              taskId,
              binding,
              { requestId, bindingId, title, dax, transport },
              job
            )
            validate()
            return payload
          },
          validate,
          seal: () => {
            validate()
            job.progress.stage = 'saving'
          }
        })
      },
      300000,
      signal
    )
  }
}
