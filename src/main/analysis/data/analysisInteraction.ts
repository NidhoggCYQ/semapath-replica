import type Database from 'better-sqlite3-multiple-ciphers'
import { BaseTable } from '@/data/baseTable'
import { AnalysisContextSchema, type AnalysisContext } from '@shared/analysisInteraction'

export class AnalysisContextsTable extends BaseTable {
  constructor(db: Database.Database) {
    super(db, 'replica_analysis_contexts')
  }
  getCreateTableSQL() {
    return `CREATE TABLE IF NOT EXISTS replica_analysis_contexts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES replica_analysis_tasks(id) ON DELETE CASCADE,
      payload TEXT NOT NULL
    );`
  }
  getLatestVersion() {
    return 0
  }
  getMigrationSQL() {
    return null
  }
  save(context: AnalysisContext) {
    this.db
      .prepare('INSERT INTO replica_analysis_contexts(id,task_id,payload) VALUES (?,?,?)')
      .run(context.id, context.taskId, JSON.stringify(AnalysisContextSchema.parse(context)))
  }
  get(taskId: string, id: string): AnalysisContext | null {
    const row = this.db
      .prepare('SELECT payload FROM replica_analysis_contexts WHERE id=? AND task_id=?')
      .get(id, taskId) as { payload: string } | undefined
    return row ? AnalysisContextSchema.parse(JSON.parse(row.payload)) : null
  }
}

export class AnalysisUiTable extends BaseTable {
  constructor(db: Database.Database) {
    super(db, 'replica_analysis_ui')
  }
  getCreateTableSQL() {
    return `CREATE TABLE IF NOT EXISTS replica_analysis_ui (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL
    );`
  }
  getLatestVersion() {
    return 0
  }
  getMigrationSQL() {
    return null
  }
  get(id: string): unknown {
    const row = this.db.prepare('SELECT payload FROM replica_analysis_ui WHERE id=?').get(id) as
      | { payload: string }
      | undefined
    if (!row) return null
    try {
      return JSON.parse(row.payload)
    } catch {
      return null
    }
  }
  save(id: string, payload: unknown) {
    this.db
      .prepare(
        'INSERT INTO replica_analysis_ui(id,payload) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload'
      )
      .run(id, JSON.stringify(payload))
  }
}
