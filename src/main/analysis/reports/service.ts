import logger from '@shared/logger'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { DatabaseConnectionProvider } from '@/data/databaseConnection'
import type { AnalysisService } from '../service'
import { AnalysisReportsTable } from '../data/analysisReports'
import { AnalysisError } from '../errors'
import {
  REPORT_RENDERER_VERSION,
  ReportOptionsSchema,
  ReportSnapshotSchema,
  type ReportCreate,
  type ReportOptions,
  type ReportRecord
} from '@shared/analysisReport'
import { buildReportDocument, reportExpectedTokens } from './document'
import { freezeReportAnswer, reportHash, validateReportSnapshot } from './snapshot'

export interface ReportRenderer {
  render(input: {
    htmlPath: string
    options: ReportOptions
    snapshotHash: string
    expectedTokens: string[]
    signal: AbortSignal
    owner: number
    progress: (stage: ReportRecord['stage']) => void
  }): Promise<{ pdf: Buffer; pages: number; bytes: number; sha256: string }>
}
type ActiveReport = { owner: number; controller: AbortController; done: Promise<void> }
export class AnalysisReportService {
  private readonly active = new Map<string, ActiveReport>()
  private readonly creating = new Set<string>()
  constructor(
    private readonly connection: DatabaseConnectionProvider,
    private readonly analysis: Pick<AnalysisService, 'get'>,
    private readonly root: string,
    private readonly renderer: ReportRenderer
  ) {
    for (const record of this.table.list())
      if (record.status === 'rendering') {
        record.status = 'interrupted'
        record.stage = 'finished'
        record.updatedAt = new Date().toISOString()
        const attempt = record.attempts.at(-1)!
        Object.assign(attempt, {
          status: 'interrupted',
          error: 'REPORT_INTERRUPTED',
          finishedAt: record.updatedAt
        })
        this.table.save(record)
      }
  }
  private get table() {
    return new AnalysisReportsTable(this.connection.getDatabase())
  }
  private directory(record: ReportRecord) {
    return path.join(this.root, record.taskId, record.id)
  }
  private filePath(record: ReportRecord, kind: 'pdf' | 'snapshot' | 'html') {
    return path.join(
      this.directory(record),
      kind === 'pdf'
        ? `attempt-${record.attempts.at(-1)!.number}.pdf`
        : kind === 'snapshot'
          ? 'evidence.json'
          : 'report.html'
    )
  }
  private check(signal: AbortSignal) {
    if (signal.aborted)
      throw signal.reason instanceof AnalysisError
        ? signal.reason
        : new AnalysisError('REPORT_CANCELLED')
  }
  list(taskId: string) {
    this.analysis.get(taskId)
    return this.table.list(taskId)
  }
  private async readChecked(filePath: string, hash: string, limit: number): Promise<Buffer> {
    try {
      const info = await stat(filePath)
      if (!info.isFile()) throw new AnalysisError('REPORT_FILE_MISSING')
      if (info.size > limit) throw new AnalysisError('REPORT_LIMIT')
      const bytes = await readFile(filePath)
      if (reportHash(bytes) !== hash) throw new AnalysisError('REPORT_FILE_CHANGED')
      return bytes
    } catch (error) {
      if (error instanceof AnalysisError) throw error
      throw new AnalysisError('REPORT_FILE_MISSING')
    }
  }
  async verifiedFile(
    taskId: string,
    reportId: string,
    kind: 'pdf' | 'evidence'
  ): Promise<{ path: string; name: string; bytes: Buffer }> {
    this.analysis.get(taskId)
    const record = this.table.get(taskId, reportId)
    if (kind === 'pdf' && record.status !== 'ready') throw new AnalysisError('REPORT_RENDER_FAILED')
    const filePath = this.filePath(record, kind === 'pdf' ? 'pdf' : 'snapshot')
    const hash = kind === 'pdf' ? record.attempts.at(-1)!.sha256 : record.snapshotHash
    if (!hash) throw new AnalysisError('REPORT_FILE_MISSING')
    const bytes = await this.readChecked(
      filePath,
      hash,
      kind === 'pdf' ? 50 * 1024 * 1024 : 32 * 1024 * 1024
    )
    return {
      path: filePath,
      name: reportFilename(record.options.title, kind === 'pdf' ? '.pdf' : '-evidence.json'),
      bytes
    }
  }
  async create(taskId: string, input: ReportCreate, owner: number): Promise<ReportRecord> {
    if (this.creating.has(taskId)) throw new AnalysisError('BUSY')
    this.creating.add(taskId)
    try {
      const options = ReportOptionsSchema.parse(input.options)
      const task = this.analysis.get(taskId)
      const snapshot = freezeReportAnswer(task, input.answer)
      const cacheKey = reportHash(
        JSON.stringify({ answer: input.answer, options, renderer: REPORT_RENDERER_VERSION })
      )
      const existing = this.table.findId(input.requestId)
      if (existing) {
        if (existing.taskId !== taskId || existing.cacheKey !== cacheKey)
          throw new AnalysisError('REPORT_INVALID_SNAPSHOT')
        return existing
      }
      const cached = this.table
        .list(taskId)
        .find(
          (record) =>
            record.cacheKey === cacheKey &&
            (record.status === 'ready' || record.status === 'rendering')
        )
      if (cached) {
        if (cached.status === 'ready') {
          try {
            await this.verifiedFile(taskId, cached.id, 'pdf')
            await this.readChecked(
              this.filePath(cached, 'snapshot'),
              cached.snapshotHash,
              32 * 1024 * 1024
            )
            return cached
          } catch {
            /* A damaged cached output must be regenerated from its own frozen snapshot. */ return this.retry(
              taskId,
              cached.id,
              owner
            )
          }
        }
        return cached
      }
      if (this.active.size >= 2) throw new AnalysisError('BUSY')
      const snapshotText = JSON.stringify(snapshot)
      const snapshotHash = reportHash(snapshotText)
      const html = buildReportDocument(snapshot, options, snapshotHash)
      if (Buffer.byteLength(html, 'utf8') > 8 * 1024 * 1024) throw new AnalysisError('REPORT_LIMIT')
      const now = new Date().toISOString()
      const record: ReportRecord = {
        id: input.requestId,
        taskId,
        createdAt: now,
        updatedAt: now,
        answer: input.answer,
        options,
        rendererVersion: REPORT_RENDERER_VERSION,
        cacheKey,
        snapshotHash,
        htmlHash: reportHash(html),
        status: 'rendering',
        stage: 'preparing',
        attempts: [
          {
            number: 1,
            startedAt: now,
            finishedAt: null,
            status: 'rendering',
            error: null,
            bytes: null,
            pages: null,
            sha256: null
          }
        ]
      }
      this.table.save(record)
      this.start(record, owner, async (signal) => {
        await mkdir(this.directory(record), { recursive: true })
        this.check(signal)
        // 'wx' never replaces an existing frozen source. Retrying uses these exact files.
        await writeFile(this.filePath(record, 'snapshot'), snapshotText, {
          encoding: 'utf8',
          flag: 'wx'
        })
        this.check(signal)
        await writeFile(this.filePath(record, 'html'), html, { encoding: 'utf8', flag: 'wx' })
        this.check(signal)
      })
      return record
    } finally {
      this.creating.delete(taskId)
    }
  }
  retry(taskId: string, reportId: string, owner: number): ReportRecord {
    this.analysis.get(taskId)
    if (this.active.has(reportId) || this.active.size >= 2) throw new AnalysisError('BUSY')
    const record = this.table.get(taskId, reportId)
    if (record.attempts.length >= 20) throw new AnalysisError('REPORT_LIMIT')
    const now = new Date().toISOString()
    record.attempts.push({
      number: record.attempts.length + 1,
      startedAt: now,
      finishedAt: null,
      status: 'rendering',
      error: null,
      bytes: null,
      pages: null,
      sha256: null
    })
    record.status = 'rendering'
    record.stage = 'preparing'
    record.updatedAt = now
    this.table.save(record)
    this.start(record, owner)
    return record
  }
  cancel(taskId: string, reportId: string, owner: number): boolean {
    this.table.get(taskId, reportId)
    const active = this.active.get(reportId)
    if (!active || active.owner !== owner) return false
    active.controller.abort(new AnalysisError('REPORT_CANCELLED'))
    return true
  }
  private start(
    record: ReportRecord,
    owner: number,
    prepare?: (signal: AbortSignal) => Promise<void>
  ) {
    const controller = new AbortController()
    const active: ActiveReport = { owner, controller, done: Promise.resolve() }
    this.active.set(record.id, active)
    active.done = this.generate(record, active, prepare).catch((error) => {
      logger.error('[Analysis reports] Failed to persist report state', error)
    })
  }
  private async generate(
    record: ReportRecord,
    active: ActiveReport,
    prepare?: (signal: AbortSignal) => Promise<void>
  ): Promise<void> {
    const signal = active.controller.signal
    const timer = setTimeout(
      () => active.controller.abort(new AnalysisError('REPORT_TIMEOUT')),
      120000
    )
    const attempt = record.attempts.at(-1)!
    const progress = (stage: ReportRecord['stage']) => {
      this.check(signal)
      record.stage = stage
      record.updatedAt = new Date().toISOString()
      this.table.save(record)
    }
    try {
      await prepare?.(signal)
      this.check(signal)
      const snapshotBytes = await this.readChecked(
        this.filePath(record, 'snapshot'),
        record.snapshotHash,
        32 * 1024 * 1024
      )
      const snapshot = ReportSnapshotSchema.parse(JSON.parse(snapshotBytes.toString('utf8')))
      validateReportSnapshot(snapshot)
      if (
        snapshot.task.id !== record.taskId ||
        snapshot.answer.id !== record.answer.id ||
        snapshot.answer.candidateHash !== record.answer.candidateHash
      )
        throw new AnalysisError('REPORT_INVALID_SNAPSHOT')
      await this.readChecked(this.filePath(record, 'html'), record.htmlHash, 8 * 1024 * 1024)
      this.check(signal)
      const result = await this.renderer.render({
        htmlPath: this.filePath(record, 'html'),
        options: record.options,
        snapshotHash: record.snapshotHash,
        expectedTokens: reportExpectedTokens(snapshot),
        signal,
        owner: active.owner,
        progress
      })
      this.check(signal)
      progress('saving')
      if (result.pdf.length !== result.bytes || reportHash(result.pdf) !== result.sha256)
        throw new AnalysisError('REPORT_RENDER_FAILED')
      const destination = this.filePath(record, 'pdf')
      await writeFile(destination + '.part', result.pdf, { flag: 'wx' })
      this.check(signal)
      await rename(destination + '.part', destination)
      this.check(signal)
      await this.readChecked(destination, result.sha256, 50 * 1024 * 1024)
      this.check(signal)
      Object.assign(attempt, {
        status: 'ready',
        error: null,
        bytes: result.bytes,
        pages: result.pages,
        sha256: result.sha256
      })
      record.status = 'ready'
    } catch (error) {
      const code = signal.aborted
        ? signal.reason instanceof AnalysisError
          ? signal.reason.code
          : 'REPORT_CANCELLED'
        : error instanceof AnalysisError
          ? error.code
          : 'REPORT_RENDER_FAILED'
      attempt.error = code
      attempt.status = code === 'REPORT_CANCELLED' ? 'cancelled' : 'failed'
      record.status = attempt.status
    } finally {
      clearTimeout(timer)
      record.stage = 'finished'
      record.updatedAt = new Date().toISOString()
      attempt.finishedAt = record.updatedAt
      try {
        this.table.save(record)
      } finally {
        if (this.active.get(record.id) === active) this.active.delete(record.id)
      }
    }
  }
  async dispose(): Promise<void> {
    const jobs = [...this.active.values()]
    for (const job of jobs) job.controller.abort(new AnalysisError('REPORT_CANCELLED'))
    await Promise.allSettled(jobs.map((job) => job.done))
  }
}
export function reportFilename(title: string, suffix: string): string {
  const printable = Array.from(title, (character) =>
    character.codePointAt(0)! < 32 ? '_' : character
  ).join('')
  const cleaned =
    Array.from(printable.replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/, ''))
      .slice(0, 100)
      .join('') || 'SemaPath-report'
  return (
    (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)
      ? 'report-' + cleaned
      : cleaned) + suffix
  )
}
