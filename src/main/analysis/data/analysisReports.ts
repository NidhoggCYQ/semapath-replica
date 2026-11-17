import type Database from 'better-sqlite3-multiple-ciphers'
import { BaseTable } from '@/data/baseTable'
import { ReportRecordSchema, type ReportRecord } from '@shared/analysisReport'
import { AnalysisError } from '../errors'
export class AnalysisReportsTable extends BaseTable {
  constructor(db: Database.Database) {
    super(db, 'replica_analysis_reports')
  }
  getCreateTableSQL(): string {
    return 'CREATE TABLE IF NOT EXISTS replica_analysis_reports (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, cache_key TEXT NOT NULL, updated_at TEXT NOT NULL, report_json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS replica_analysis_reports_task ON replica_analysis_reports(task_id,updated_at);'
  }
  getMigrationSQL(): null {
    return null
  }
  getLatestVersion(): number {
    return 0
  }
  list(taskId?: string): ReportRecord[] {
    const rows = taskId
      ? this.db
          .prepare(
            'SELECT report_json FROM replica_analysis_reports WHERE task_id = ? ORDER BY updated_at DESC'
          )
          .all(taskId)
      : this.db.prepare('SELECT report_json FROM replica_analysis_reports').all()
    return (rows as { report_json: string }[]).map((row) =>
      ReportRecordSchema.parse(JSON.parse(row.report_json))
    )
  }
  get(taskId: string, reportId: string): ReportRecord {
    const row = this.db
      .prepare('SELECT report_json FROM replica_analysis_reports WHERE task_id = ? AND id = ?')
      .get(taskId, reportId) as { report_json: string } | undefined
    if (!row) throw new AnalysisError('NOT_FOUND')
    return ReportRecordSchema.parse(JSON.parse(row.report_json))
  }
  findId(reportId: string): ReportRecord | null {
    const row = this.db
      .prepare('SELECT report_json FROM replica_analysis_reports WHERE id = ?')
      .get(reportId) as { report_json: string } | undefined
    return row ? ReportRecordSchema.parse(JSON.parse(row.report_json)) : null
  }
  save(record: ReportRecord): ReportRecord {
    const checked = ReportRecordSchema.parse(record)
    this.db
      .prepare(
        'INSERT INTO replica_analysis_reports (id,task_id,cache_key,updated_at,report_json) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,report_json=excluded.report_json'
      )
      .run(checked.id, checked.taskId, checked.cacheKey, checked.updatedAt, JSON.stringify(checked))
    return checked
  }
}
