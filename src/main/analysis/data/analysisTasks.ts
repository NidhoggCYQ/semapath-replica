import type Database from 'better-sqlite3-multiple-ciphers'
import { BaseTable } from '@/data/baseTable'
import { AnalysisTaskSchema, type AnalysisTask, type AnalysisTaskSummary } from '@shared/analysis'
import { AnalysisError } from '../errors'

export class AnalysisTasksTable extends BaseTable {
  constructor(db: Database.Database) {
    super(db, 'replica_analysis_tasks')
  }
  getCreateTableSQL(): string {
    return `CREATE TABLE IF NOT EXISTS replica_analysis_tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, source_count INTEGER NOT NULL, run_count INTEGER NOT NULL, task_json TEXT NOT NULL);`
  }
  getMigrationSQL(): null {
    return null
  }
  getLatestVersion(): number {
    return 0
  }
  list(): AnalysisTaskSummary[] {
    const rows = this.db
      .prepare(
        "SELECT id, title, created_at AS createdAt, updated_at AS updatedAt, source_count AS sourceCount, run_count AS runCount,json_extract(task_json,'$.projectDir') AS projectDir,json_extract(task_json,'$.isPinned') AS pinned FROM replica_analysis_tasks ORDER BY updated_at DESC"
      )
      .all() as Array<AnalysisTaskSummary & { pinned: number | null }>
    return rows.map(({ pinned, ...row }) => ({ ...row, isPinned: !!pinned }))
  }
  assertExists(id: string): void {
    if (!this.db.prepare('SELECT 1 FROM replica_analysis_tasks WHERE id = ?').get(id))
      throw new AnalysisError('NOT_FOUND')
  }
  get(id: string): AnalysisTask {
    const row = this.db
      .prepare('SELECT task_json FROM replica_analysis_tasks WHERE id = ?')
      .get(id) as { task_json: string } | undefined
    if (!row) throw new AnalysisError('NOT_FOUND')
    return AnalysisTaskSchema.parse(JSON.parse(row.task_json))
  }
  save(task: AnalysisTask): AnalysisTask {
    const validated = AnalysisTaskSchema.parse(task)
    this.db
      .prepare(
        'INSERT INTO replica_analysis_tasks (id,title,created_at,updated_at,source_count,run_count,task_json) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,updated_at=excluded.updated_at,source_count=excluded.source_count,run_count=excluded.run_count,task_json=excluded.task_json'
      )
      .run(
        validated.id,
        validated.title,
        validated.createdAt,
        validated.updatedAt,
        validated.sources.length,
        validated.runs.length,
        JSON.stringify(validated)
      )
    return validated
  }
}
