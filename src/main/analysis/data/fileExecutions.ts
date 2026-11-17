import type Database from 'better-sqlite3-multiple-ciphers'
import { BaseTable } from '@/data/baseTable'
import type {
  FileExecutionCapturedInputSchema,
  FileExecutionDelivery
} from '@shared/analysisFileExecution'
import type { z } from 'zod'

export type FileExecutionRecord = {
  id: string
  callKey: string
  digest: string
  taskId: string
  sessionId: string
  state: 'prepared' | 'running' | 'ready' | 'failed' | 'interrupted'
  startedAt: string
  finishedAt?: string
  command: string
  cwd: string
  skillStatus: 'loaded' | 'not_loaded'
  inputs: Array<z.infer<typeof FileExecutionCapturedInputSchema> & { path: string }>
  delivery?: FileExecutionDelivery
}
export class FileExecutionsTable extends BaseTable {
  constructor(db: Database.Database) {
    super(db, 'replica_file_executions')
  }
  getCreateTableSQL() {
    return 'CREATE TABLE IF NOT EXISTS replica_file_executions (id TEXT PRIMARY KEY,call_key TEXT NOT NULL UNIQUE,task_id TEXT NOT NULL,session_id TEXT NOT NULL,record_json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS replica_file_executions_task ON replica_file_executions(task_id);'
  }
  getMigrationSQL(): null {
    return null
  }
  getLatestVersion() {
    return 0
  }
  get(id: string): FileExecutionRecord | null {
    const row = this.db
      .prepare('SELECT record_json FROM replica_file_executions WHERE id=?')
      .get(id) as { record_json: string } | undefined
    return row ? (JSON.parse(row.record_json) as FileExecutionRecord) : null
  }
  forCall(key: string): FileExecutionRecord | null {
    const row = this.db
      .prepare('SELECT record_json FROM replica_file_executions WHERE call_key=?')
      .get(key) as { record_json: string } | undefined
    return row ? (JSON.parse(row.record_json) as FileExecutionRecord) : null
  }
  list(taskId?: string): FileExecutionRecord[] {
    const rows = (
      taskId
        ? this.db
            .prepare('SELECT record_json FROM replica_file_executions WHERE task_id=?')
            .all(taskId)
        : this.db.prepare('SELECT record_json FROM replica_file_executions').all()
    ) as { record_json: string }[]
    return rows.map((row) => JSON.parse(row.record_json) as FileExecutionRecord)
  }
  save(record: FileExecutionRecord) {
    this.db
      .prepare(
        'INSERT INTO replica_file_executions VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json'
      )
      .run(record.id, record.callKey, record.taskId, record.sessionId, JSON.stringify(record))
  }
}
