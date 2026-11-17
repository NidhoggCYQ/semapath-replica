import { createHash } from 'node:crypto'
import type { PbiSchema } from '@shared/analysisPowerBi'
import type { RetrievalSelection, RetrievalTargets } from '@shared/analysisAcquisition'
import type { SqlService } from '../sqlService'
import type { PbiService } from '../powerbi/service'
import { AnalysisError } from '../errors'
import type { RawDataSession, RemoteCatalog, RetrievalGateway, RetrievalSession } from './types'
import { automaticSql, automaticDax } from './queryScope'

type SqlStructure = { name: string; columns: { name: string; type: string; nullable: boolean }[] }[]
const structure = (value: unknown) =>
  value && typeof value === 'object' && 'tables' in value
    ? {
        tables: (value as PbiSchema).tables,
        relationships: (value as PbiSchema).relationships,
        coverage: (value as PbiSchema).coverage
      }
    : value
export const structureHash = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(structure(value)))
    .digest('hex')
export class ConnectedDataGateway implements RetrievalGateway {
  constructor(
    private readonly sql: SqlService,
    private readonly pbi: PbiService
  ) {}
  targets(taskId: string): RetrievalTargets {
    const targets: RetrievalTargets['targets'] = [],
      issues: string[] = []
    try {
      for (const c of this.sql.list(taskId))
        targets.push({ id: 'mysql:' + c.id, kind: 'mysql', label: c.name, detail: c.database })
    } catch (error) {
      issues.push(error instanceof AnalysisError ? error.code : 'STORAGE_ERROR')
    }
    try {
      const binding = this.pbi.binding(taskId)
      if (binding)
        targets.push({
          id: 'powerbi:' + binding.id,
          kind: 'powerbi',
          powerBiKind: binding.target.kind,
          label: binding.target.model.name,
          detail:
            binding.target.kind === 'local'
              ? binding.target.model.databaseId
              : binding.target.model.datasetId
        })
    } catch (error) {
      issues.push(error instanceof AnalysisError ? error.code : 'STORAGE_ERROR')
    }
    return { targets, issues }
  }
  async use<T>(
    taskId: string,
    selection: RetrievalSelection,
    requestId: string,
    owner: number,
    signal: AbortSignal,
    action: (session: RetrievalSession) => Promise<T>
  ) {
    const available = this.targets(taskId),
      chosen = selection.targetIds.map((id) => available.targets.find((t) => t.id === id))
    if (chosen.some((t) => !t) || new Set(selection.targetIds).size !== chosen.length)
      throw new AnalysisError('FETCH_TARGET_CHANGED')
    if (chosen.filter((t) => t!.kind === 'mysql').length > 3)
      throw new AnalysisError('ANALYSIS_CONTEXT_LIMIT')
    const controller = new AbortController(),
      listeners: (() => void)[] = []
    const relay = (source: AbortSignal) => {
      const stop = () => controller.abort(source.reason)
      source.addEventListener('abort', stop, { once: true })
      if (source.aborted) stop()
      listeners.push(() => source.removeEventListener('abort', stop))
    }
    relay(signal)
    type Raw = RawDataSession<unknown>
    const sessions = new Map<string, Raw>()
    const ready = async () => {
      const catalogs: RemoteCatalog[] = []
      for (const target of chosen) {
        const raw = sessions.get(target!.id)!
        relay(raw.signal)
        try {
          const schema = await raw.schema()
          controller.signal.throwIfAborted()
          catalogs.push({
            id: target!.id,
            kind: target!.kind,
            label: target!.label,
            database: target!.detail,
            structure: schema,
            structureSha256: structureHash(schema)
          })
        } catch (error) {
          controller.signal.throwIfAborted()
          catalogs.push({
            id: target!.id,
            kind: target!.kind,
            label: target!.label,
            database: target!.detail,
            structure: null,
            structureSha256: structureHash(null),
            issue: error instanceof AnalysisError ? error.code : 'PBI_METADATA_UNAVAILABLE'
          })
        }
      }
      if (Buffer.byteLength(JSON.stringify(catalogs)) > 55000)
        throw new AnalysisError('ANALYSIS_CONTEXT_LIMIT')
      const used = new Set<string>()
      const validate = () => {
        controller.signal.throwIfAborted()
        for (const id of used) sessions.get(id)!.validate()
      }
      return action({
        signal: controller.signal,
        catalogs,
        validate,
        seal: () => {
          validate()
          for (const id of used) sessions.get(id)!.seal()
        },
        query: async (id, query, title) => {
          const catalog = catalogs.find((c) => c.id === id),
            raw = sessions.get(id)
          if (!catalog || !raw || catalog.issue || catalog.structure == null)
            throw new AnalysisError('FETCH_QUERY_SCOPE')
          controller.signal.throwIfAborted()
          if (structureHash(await raw.schema()) !== catalog.structureSha256)
            throw new AnalysisError('FETCH_TARGET_CHANGED')
          const guarded =
            catalog.kind === 'mysql'
              ? automaticSql(query, catalog.database, catalog.structure as SqlStructure)
              : automaticDax(query, catalog.structure as PbiSchema)
          const payload = await raw.query(guarded, title)
          controller.signal.throwIfAborted()
          if (
            structureHash(payload.origin.powerBi?.schema ?? (await raw.schema())) !==
            catalog.structureSha256
          )
            throw new AnalysisError('FETCH_TARGET_CHANGED')
          used.add(id)
          validate()
          return payload
        }
      })
    }
    const pbi = chosen.find((t) => t!.kind === 'powerbi')
    const usePbi = () =>
      pbi
        ? this.pbi.withNatural(
            taskId,
            pbi.id.slice(8),
            selection.transport,
            requestId,
            owner,
            controller.signal,
            async (session) => {
              sessions.set(pbi.id, session as Raw)
              relay(session.signal)
              return ready()
            }
          )
        : ready()
    const mysql = chosen.filter((t) => t!.kind === 'mysql').map((t) => t!.id.slice(6))
    try {
      return mysql.length
        ? await this.sql.withNaturalConnections(
            taskId,
            mysql,
            requestId,
            owner,
            controller.signal,
            async (leases) => {
              for (const [id, lease] of leases) {
                sessions.set('mysql:' + id, lease as Raw)
                relay(lease.signal)
              }
              return usePbi()
            }
          )
        : await usePbi()
    } finally {
      for (const cleanup of listeners) cleanup()
    }
  }
}
