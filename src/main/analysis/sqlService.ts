import { createHash } from 'node:crypto'
import type { AnalysisService } from './service'
import { SqlVault } from './sqlVault'
import { AnalysisError } from './errors'
import { executeSql, readSqlRows, withSql } from './sqlDriver'
import { sqlIdentifier } from './sqlGuard'
import type { SqlConnectionInput, SqlQueryInput } from '@shared/analysisData'
import { sqlSnapshot } from './sqlSnapshot'
import type { RawDataSession } from './retrieval/types'

type SqlJob = {
  owner: number
  controller: AbortController
  progress: { requestId: string; stage: 'connecting' | 'querying' | 'saving'; startedAt: string }
}
export class SqlService {
  private readonly active = new Map<string, SqlJob>()
  constructor(
    private readonly analysis: Pick<AnalysisService, 'get' | 'addSnapshot'>,
    private readonly vault: SqlVault
  ) {}
  list(taskId: string) {
    this.analysis.get(taskId)
    return this.vault.list(taskId)
  }
  save(taskId: string, input: SqlConnectionInput) {
    this.analysis.get(taskId)
    if (this.active.has(taskId)) throw new AnalysisError('BUSY')
    return this.vault.save(taskId, input)
  }
  remove(taskId: string, id: string) {
    this.analysis.get(taskId)
    if (this.active.has(taskId)) throw new AnalysisError('BUSY')
    this.vault.remove(taskId, id)
    return this.list(taskId)
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
    job.controller.abort(new AnalysisError('SQL_CANCELLED'))
    return true
  }
  cancelOwner(owner: number) {
    for (const job of this.active.values())
      if (job.owner === owner && job.progress.stage !== 'saving')
        job.controller.abort(new AnalysisError('SQL_CANCELLED'))
  }
  dispose() {
    for (const job of this.active.values())
      if (job.progress.stage !== 'saving') job.controller.abort(new AnalysisError('SQL_CANCELLED'))
  }
  private async run<T>(
    taskId: string,
    requestId: string,
    owner: number,
    action: (job: SqlJob) => Promise<T>,
    external?: AbortSignal,
    timeout = 30000
  ): Promise<T> {
    this.analysis.get(taskId)
    if (this.active.has(taskId) || this.active.size >= 4) throw new AnalysisError('BUSY')
    const job: SqlJob = {
      owner,
      controller: new AbortController(),
      progress: { requestId, stage: 'connecting', startedAt: new Date().toISOString() }
    }
    this.active.set(taskId, job)
    const abort = () => job.controller.abort(external?.reason ?? new AnalysisError('SQL_CANCELLED'))
    external?.addEventListener('abort', abort, { once: true })
    if (external?.aborted) abort()
    const timer = setTimeout(() => {
      if (job.progress.stage !== 'saving') job.controller.abort(new AnalysisError('SQL_TIMEOUT'))
    }, timeout)
    try {
      const result = await action(job)
      if (job.controller.signal.aborted) throw job.controller.signal.reason
      return result
    } finally {
      external?.removeEventListener('abort', abort)
      clearTimeout(timer)
      if (this.active.get(taskId) === job) this.active.delete(taskId)
    }
  }
  test(taskId: string, requestId: string, input: SqlConnectionInput, owner: number) {
    const config =
      input.id && input.password == null
        ? { ...input, password: this.vault.get(taskId, input.id).password }
        : input
    return this.run(taskId, requestId, owner, async (job) =>
      withSql(config, job.controller.signal, async (connection) => {
        const result = await readSqlRows(connection, 'SELECT VERSION()', job.controller.signal, 1)
        return result.rows[0][0] ?? ''
      })
    )
  }
  schema(taskId: string, requestId: string, id: string, owner: number) {
    const config = this.vault.get(taskId, id)
    return this.run(taskId, requestId, owner, async (job) =>
      this.readSchema(config, job.controller.signal)
    )
  }
  private readSchema(config: SqlConnectionInput, signal: AbortSignal) {
    return withSql(config, signal, async (connection) => {
      const result = await readSqlRows(
        connection,
        'SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ' +
          "'" +
          config.database.replaceAll("'", "''") +
          "'" +
          ' ORDER BY TABLE_NAME,ORDINAL_POSITION',
        signal
      )
      const tables = new Map<
        string,
        { name: string; columns: { name: string; type: string; nullable: boolean }[] }
      >()
      for (const row of result.rows) {
        const [name, column, type, nullable] = row
        if (!name || !column || !type) continue
        const table = tables.get(name) ?? { name, columns: [] }
        table.columns.push({ name: column, type, nullable: nullable === 'YES' })
        tables.set(name, table)
      }
      return [...tables.values()]
    })
  }
  preview(taskId: string, requestId: string, id: string, table: string, owner: number) {
    const config = this.vault.get(taskId, id)
    return this.run(taskId, requestId, owner, async (job) => {
      job.progress.stage = 'querying'
      const result = await executeSql(
        config,
        'SELECT * FROM ' +
          sqlIdentifier(config.database) +
          '.' +
          sqlIdentifier(table) +
          ' LIMIT 50',
        job.controller.signal
      )
      return { columns: result.fields.map((f) => f.name), rows: result.rows }
    })
  }
  query(taskId: string, input: SqlQueryInput, owner: number) {
    const config = this.vault.get(taskId, input.connectionId)
    return this.run(taskId, input.requestId, owner, async (job) => {
      job.progress.stage = 'querying'
      const result = await executeSql(config, input.query, job.controller.signal)
      if (job.controller.signal.aborted) throw job.controller.signal.reason
      const snapshot = sqlSnapshot(result, config, input.query, input.title)
      job.progress.stage = 'saving'
      if (job.controller.signal.aborted) throw job.controller.signal.reason
      return this.analysis.addSnapshot(taskId, snapshot.bytes, snapshot.origin)
    })
  }
  withNaturalConnections<T>(
    taskId: string,
    ids: string[],
    requestId: string,
    owner: number,
    signal: AbortSignal,
    action: (
      sessions: Map<string, RawDataSession<Awaited<ReturnType<SqlService['readSchema']>>>>
    ) => Promise<T>
  ) {
    const configs = ids.map((id) => ({ id, config: this.vault.get(taskId, id) })),
      fingerprint = (value: SqlConnectionInput) =>
        createHash('sha256').update(JSON.stringify(value)).digest('hex')
    return this.run(
      taskId,
      requestId,
      owner,
      async (job) => {
        const sessions = new Map<
          string,
          RawDataSession<Awaited<ReturnType<SqlService['readSchema']>>>
        >()
        for (const { id, config } of configs) {
          const original = fingerprint(config)
          const validate = () => {
            job.controller.signal.throwIfAborted()
            if (fingerprint(this.vault.get(taskId, id)) !== original)
              throw new AnalysisError('FETCH_TARGET_CHANGED')
          }
          sessions.set(id, {
            signal: job.controller.signal,
            schema: async () => {
              validate()
              const result = await this.readSchema(config, job.controller.signal)
              validate()
              return result
            },
            query: async (query, title) => {
              validate()
              job.progress.stage = 'querying'
              const result = await executeSql(config, query, job.controller.signal)
              validate()
              return sqlSnapshot(result, config, query, title)
            },
            validate,
            seal: () => {
              validate()
              job.progress.stage = 'saving'
            }
          })
        }
        return action(sessions)
      },
      signal,
      300000
    )
  }
}
