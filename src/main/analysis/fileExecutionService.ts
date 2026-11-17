import { randomUUID } from 'node:crypto'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import * as XLSX from 'xlsx'
import type { DatabaseConnectionProvider } from '@/data/databaseConnection'
import type {
  FileExecutionPort,
  FileExecutionRequest,
  FileExecutionDelivery
} from '@shared/analysisFileExecution'
import { FileExecutionInputsSchema } from '@shared/analysisFileExecution'
import { FileExecutionsTable, type FileExecutionRecord } from './data/fileExecutions'
import { FileResultError, fileResultHash, readFileResult } from './fileResult'
import { buildFileResultSnapshots } from './workerClient'
import logger from '@shared/logger'
import type { AnalysisService } from './service'
import type { AnalysisWorkspaceService } from './workspaceService'
import { assertFileFingerprint } from './sourceVersion'
import { AnalysisError } from './errors'

const guidance =
  'Recorded code output is not business verification or a captured replay environment. Read saved tables and source versions, calculate compatible views, then submit/read/confirm an answer before exporting. Do not rerun side-effecting commands to repair formatting.'
export class AnalysisFileExecutionService implements FileExecutionPort {
  private readonly completing = new Set<string>()
  constructor(
    private readonly deps: {
      connection: DatabaseConnectionProvider
      analysis: AnalysisService
      workspace: AnalysisWorkspaceService
      root: string
      changed: (taskId: string) => void
    }
  ) {}
  private get table() {
    return new FileExecutionsTable(this.deps.connection.getDatabase())
  }
  private directory(id: string) {
    return path.join(this.deps.root, id)
  }
  private record(sessionId: string, id: string) {
    const record = this.table.get(id)
    if (!record || record.sessionId !== sessionId) throw new AnalysisError('NOT_FOUND')
    return record
  }
  private save(record: FileExecutionRecord) {
    this.table.save(record)
    try {
      this.deps.changed(record.taskId)
    } catch {
      logger.warn('[Analysis] File execution update notification failed', { taskId: record.taskId })
    }
  }
  async prepare(request: FileExecutionRequest, signal?: AbortSignal) {
    signal?.throwIfAborted()
    if (
      !this.deps.workspace.isRegularSession(request.sessionId) ||
      !request.messageId ||
      !request.toolCallId ||
      Buffer.byteLength(request.command, 'utf8') > 131072
    )
      throw new AnalysisError('ANALYSIS_TOOL_ARGUMENTS')
    const inputs = FileExecutionInputsSchema.parse(request.inputs)
    const taskId =
      this.deps.workspace.forSession(request.sessionId) ??
      this.deps.workspace.ensureForSession(request.sessionId).id
    const task = this.deps.analysis.get(taskId)
    const callKey = fileResultHash(
      JSON.stringify([request.sessionId, request.messageId, request.toolCallId])
    )
    const digest = fileResultHash(
      JSON.stringify({ taskId, command: request.command, cwd: request.cwd, inputs })
    )
    const prior = this.table.forCall(callKey)
    if (prior) {
      if (prior.digest !== digest) throw new AnalysisError('ANALYSIS_TOOL_REPLAY')
      if (prior.state === 'prepared') return { id: prior.id, env: this.environment(prior.id) }
      if (prior.delivery) return { id: prior.id, env: {}, cached: prior.delivery }
      throw new AnalysisError(prior.state === 'running' ? 'BUSY' : 'ANALYSIS_TOOL_INTERRUPTED')
    }
    const captured: FileExecutionRecord['inputs'] = []
    for (const input of inputs) {
      const requestedPath = input.path
        ? await realpath(path.resolve(request.cwd, input.path))
        : null
      let source = input.sourceId ? task.sources.find((s) => s.id === input.sourceId) : undefined
      if (requestedPath) {
        const identity = (value: string) =>
          process.platform === 'win32' ? value.toLowerCase() : value
        for (const candidate of task.sources) {
          let canonical: string
          try {
            canonical = await realpath(candidate.path)
          } catch {
            continue
          }
          if (identity(canonical) === identity(requestedPath)) {
            source = candidate
            break
          }
        }
      }
      if (!source) throw new AnalysisError('NOT_FOUND')
      await assertFileFingerprint(source)
      if (input.sheet) {
        const sheet = source.sheets.find((s) => s.name === input.sheet)
        if (!sheet) throw new AnalysisError('INVALID_COLUMN')
        if (input.range) {
          const range = XLSX.utils.decode_range(input.range)
          if (
            range.s.r > range.e.r ||
            range.s.c > range.e.c ||
            range.e.r >= sheet.lastRow ||
            range.e.c >= 256
          )
            throw new AnalysisError('INVALID_COLUMN')
        }
      }
      captured.push({
        sourceId: source.id,
        name: source.name,
        path: source.path,
        sha256: source.sha256,
        bytes: source.bytes,
        ...(input.sheet ? { sheet: input.sheet } : {}),
        ...(input.range ? { range: input.range } : {})
      })
    }
    signal?.throwIfAborted()
    const id = randomUUID()
    const record: FileExecutionRecord = {
      id,
      callKey,
      digest,
      taskId,
      sessionId: request.sessionId,
      state: 'prepared',
      startedAt: new Date().toISOString(),
      command: request.command,
      cwd: request.cwd,
      inputs: captured,
      skillStatus: request.activeSkillNames.includes('xlsx') ? 'loaded' : 'not_loaded'
    }
    await mkdir(this.directory(id), { recursive: true })
    await writeFile(
      path.join(this.directory(id), 'inputs.json'),
      JSON.stringify({ inputs: captured }),
      { flag: 'wx' }
    )
    this.save(record)
    return { id, env: this.environment(id) }
  }
  private environment(id: string) {
    return {
      PBI_RESULT_PATH: path.join(this.directory(id), 'result.json'),
      PBI_INPUTS_PATH: path.join(this.directory(id), 'inputs.json')
    }
  }
  started(sessionId: string, id: string) {
    const record = this.record(sessionId, id)
    if (record.state !== 'prepared') throw new AnalysisError('ANALYSIS_TOOL_REPLAY')
    record.state = 'running'
    record.startedAt = new Date().toISOString()
    this.save(record)
  }
  failed(sessionId: string, id: string, issue: string): FileExecutionDelivery {
    const record = this.record(sessionId, id)
    if (record.delivery) return record.delivery
    record.state = 'failed'
    record.finishedAt = new Date().toISOString()
    record.delivery = {
      executionId: id,
      state: 'failed',
      issue,
      sources: [],
      instruction: guidance
    }
    this.save(record)
    return record.delivery
  }
  async finish(
    sessionId: string,
    id: string,
    result: { exitCode: number | null; timedOut: boolean },
    signal?: AbortSignal
  ) {
    const record = this.record(sessionId, id)
    if (record.delivery) return record.delivery
    if (record.state !== 'running' || this.completing.has(id))
      throw new AnalysisError('ANALYSIS_TOOL_REPLAY')
    this.completing.add(id)
    try {
      if (result.exitCode !== 0 || result.timedOut)
        return this.failed(sessionId, id, result.timedOut ? 'timeout' : 'command_failed')
      signal?.throwIfAborted()
      const raw = await readFileResult(this.environment(id).PBI_RESULT_PATH)
      await this.validateInputs(record)
      const finishedAt = new Date().toISOString()
      // Redact known native paths in public provenance; exact command remains in the private ledger.
      let command = record.command
      const redact = (value: string, replacement: string) => {
        for (const variant of new Set([
          value,
          value.replaceAll('\\', '/'),
          JSON.stringify(value).slice(1, -1)
        ]))
          if (variant) command = command.split(variant).join(replacement)
      }
      for (const input of record.inputs) redact(input.path, `[input:${input.sourceId}]`)
      redact(record.cwd, '[workdir]')
      const built = await buildFileResultSnapshots(
        raw,
        {
          version: 'file-execution/1',
          id,
          startedAt: record.startedAt,
          finishedAt,
          command,
          commandSha256: fileResultHash(record.command),
          resultSha256: fileResultHash(raw),
          skillStatus: record.skillStatus,
          inputs: record.inputs.map(({ path: _path, ...input }) => input),
          verification: 'recorded_result',
          replay: 'not_captured'
        },
        signal
      )
      if (!built.ok) throw new FileResultError(built.issue)
      const payloads = built.datasets.map((data) => ({
        bytes: Buffer.from(data.base64, 'base64'),
        origin: data.origin
      }))
      const updated = await this.deps.analysis.addSnapshots(
        record.taskId,
        payloads,
        () => this.validateInputs(record),
        signal
      )
      record.state = 'ready'
      record.finishedAt = finishedAt
      record.delivery = {
        executionId: id,
        state: 'ready',
        sources: updated.sources
          .filter((s) => s.origin?.fileExecution?.id === id)
          .map((s) => ({
            id: s.id,
            name: s.name,
            sha256: s.sha256,
            tableIndex: s.origin!.fileExecution!.tableIndex
          })),
        instruction: guidance
      }
      this.save(record)
      return record.delivery
    } catch (error) {
      return this.failed(
        sessionId,
        id,
        error instanceof FileResultError
          ? error.issue
          : error instanceof AnalysisError
            ? error.code
            : signal?.aborted
              ? 'cancelled'
              : (error as NodeJS.ErrnoException).code === 'ENOENT'
                ? 'missing_result'
                : 'read_failed'
      )
    } finally {
      this.completing.delete(id)
    }
  }
  private async validateInputs(record: FileExecutionRecord) {
    if (this.deps.workspace.forSession(record.sessionId) !== record.taskId)
      throw new AnalysisError('WORKSPACE_SESSION_MISSING')
    const task = this.deps.analysis.get(record.taskId)
    for (const input of record.inputs) {
      const source = task.sources.find(
        (s) => s.id === input.sourceId && s.sha256 === input.sha256 && s.path === input.path
      )
      if (!source) throw new AnalysisError('SOURCE_CHANGED')
      await assertFileFingerprint(source)
    }
  }
  list(taskId: string) {
    return this.table.list(taskId).map((r) => ({
      id: r.id,
      state: r.state,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      skillStatus: r.skillStatus,
      inputs: r.inputs.map(({ path: _path, ...input }) => input),
      delivery: r.delivery
    }))
  }
  read(taskId: string, id: string, tableIndex = 0, offset = 0, limit = 50) {
    const record = this.table.get(id)
    if (!record || record.taskId !== taskId) throw new AnalysisError('NOT_FOUND')
    const task = this.deps.analysis.get(taskId)
    const tables = task.sources.filter((s) => s.origin?.fileExecution?.id === id)
    const selected = tables.find((s) => s.origin!.fileExecution!.tableIndex === tableIndex)
    if (!selected) return { ...this.list(taskId).find((r) => r.id === id)!, table: null }
    const { table, ...metadata } = selected.origin!.fileExecution!
    return {
      ...this.list(taskId).find((r) => r.id === id)!,
      availableTables: tables.map((s) => ({
        sourceId: s.id,
        tableIndex: s.origin!.fileExecution!.tableIndex,
        title: s.origin!.fileExecution!.table.title
      })),
      metadata,
      sourceId: selected.id,
      table: {
        title: table.title,
        columns: table.columns,
        columnTypes: table.columnTypes,
        rows: table.rows.slice(offset, offset + limit),
        excelDates: table.excelDates?.filter((d) => d.row >= offset && d.row < offset + limit)
      },
      total: table.rows.length,
      offset,
      hasMore: offset + limit < table.rows.length
    }
  }
  interruptOpen() {
    for (const record of this.table.list())
      if (record.state === 'running' || record.state === 'prepared') {
        // Atomic source registration may have committed immediately before process termination.
        let sources: ReturnType<AnalysisService['get']>['sources'] = []
        try {
          sources = this.deps.analysis
            .get(record.taskId)
            .sources.filter((s) => s.origin?.fileExecution?.id === record.id)
        } catch {
          /* Deleted tasks cannot receive recovered results. */
        }
        record.state = sources.length ? 'ready' : 'interrupted'
        record.finishedAt = new Date().toISOString()
        record.delivery = {
          executionId: record.id,
          state: sources.length ? 'ready' : 'interrupted',
          ...(sources.length ? {} : { issue: 'interrupted' }),
          sources: sources.map((s) => ({
            id: s.id,
            name: s.name,
            sha256: s.sha256,
            tableIndex: s.origin!.fileExecution!.tableIndex
          })),
          instruction: guidance
        }
        this.save(record)
      }
  }
}
