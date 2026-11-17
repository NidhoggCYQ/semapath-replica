import type Database from 'better-sqlite3-multiple-ciphers'
import { BaseTable } from '@/data/baseTable'
import type { AnalysisToolRecord } from '@shared/analysisWorkspace'

export type AnalysisSessionLink = { taskId: string; sessionId: string }
export class AnalysisSessionsTable extends BaseTable {
  constructor(db: Database.Database) {
    super(db, 'replica_analysis_sessions')
  }
  getCreateTableSQL() {
    return `CREATE TABLE IF NOT EXISTS replica_analysis_sessions (
      task_id TEXT PRIMARY KEY REFERENCES replica_analysis_tasks(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );`
  }
  getLatestVersion() {
    return 0
  }
  getMigrationSQL() {
    return null
  }
  list(): AnalysisSessionLink[] {
    return this.db
      .prepare('SELECT task_id AS taskId, session_id AS sessionId FROM replica_analysis_sessions')
      .all() as AnalysisSessionLink[]
  }
  forTask(id: string): AnalysisSessionLink | null {
    return (
      (this.db
        .prepare(
          'SELECT task_id AS taskId, session_id AS sessionId FROM replica_analysis_sessions WHERE task_id=?'
        )
        .get(id) as AnalysisSessionLink | undefined) ?? null
    )
  }
  forSession(id: string): AnalysisSessionLink | null {
    return (
      (this.db
        .prepare(
          'SELECT task_id AS taskId, session_id AS sessionId FROM replica_analysis_sessions WHERE session_id=?'
        )
        .get(id) as AnalysisSessionLink | undefined) ?? null
    )
  }
  link(taskId: string, sessionId: string) {
    this.db
      .prepare(
        'INSERT INTO replica_analysis_sessions(task_id,session_id,created_at) VALUES (?,?,?)'
      )
      .run(taskId, sessionId, new Date().toISOString())
  }
}

export type StoredToolOperation = AnalysisToolRecord & {
  taskId: string
  sessionId: string
  digest: string
  result: string | null
}
export class AnalysisToolOperationsTable extends BaseTable {
  constructor(db: Database.Database) {
    super(db, 'replica_analysis_tool_operations')
  }
  getCreateTableSQL() {
    return `CREATE TABLE IF NOT EXISTS replica_analysis_tool_operations (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES replica_analysis_tasks(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL, tool TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL,
      created_at TEXT NOT NULL, finished_at TEXT, result_json TEXT, error TEXT
    );
    CREATE INDEX IF NOT EXISTS replica_analysis_tool_operations_task ON replica_analysis_tool_operations(task_id,created_at);`
  }
  getLatestVersion() {
    return 0
  }
  getMigrationSQL() {
    return null
  }
  get(id: string): StoredToolOperation | null {
    return (
      (this.db
        .prepare(
          `SELECT id,task_id AS taskId,session_id AS sessionId,tool,digest,state,created_at AS createdAt,finished_at AS finishedAt,result_json AS result,error FROM replica_analysis_tool_operations WHERE id=?`
        )
        .get(id) as StoredToolOperation | undefined) ?? null
    )
  }
  list(taskId: string): AnalysisToolRecord[] {
    return this.db
      .prepare(
        'SELECT id,tool,state,created_at AS createdAt,finished_at AS finishedAt,error FROM replica_analysis_tool_operations WHERE task_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100'
      )
      .all(taskId) as AnalysisToolRecord[]
  }
  begin(input: { id: string; taskId: string; sessionId: string; tool: string; digest: string }) {
    this.db
      .prepare(
        "INSERT INTO replica_analysis_tool_operations(id,task_id,session_id,tool,digest,state,created_at) VALUES (?,?,?,?,?,'running',?)"
      )
      .run(
        input.id,
        input.taskId,
        input.sessionId,
        input.tool,
        input.digest,
        new Date().toISOString()
      )
  }
  finish(id: string, state: 'succeeded' | 'failed', result: string | null, error: string | null) {
    this.db
      .prepare(
        "UPDATE replica_analysis_tool_operations SET state=?,finished_at=?,result_json=?,error=? WHERE id=? AND state='running'"
      )
      .run(state, new Date().toISOString(), result, error, id)
  }
  interruptOpen() {
    this.db
      .prepare(
        "UPDATE replica_analysis_tool_operations SET state='interrupted',finished_at=?,error='ANALYSIS_TOOL_INTERRUPTED' WHERE state='running'"
      )
      .run(new Date().toISOString())
  }
  wasRead(
    taskId: string,
    sessionId: string,
    turnId: string,
    hash: string,
    providerId: string,
    modelId: string,
    receiptId: string
  ): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM replica_analysis_tool_operations
      WHERE task_id=? AND session_id=? AND state='succeeded' AND tool IN ('analysis_get','answer_resume')
      AND json_extract(result_json,'$.reviewReceipt.turnId')=?
      AND json_extract(result_json,'$.reviewReceipt.hash')=?
      AND json_extract(result_json,'$.reviewReceipt.providerId')=?
      AND json_extract(result_json,'$.reviewReceipt.modelId')=?
      AND json_extract(result_json,'$.reviewReceipt.id')=? LIMIT 1`)
      .get(taskId, sessionId, turnId, hash, providerId, modelId, receiptId)
  }
}
