import mysql, { type Connection, type FieldPacket } from 'mysql2'
import type { SqlConnectionInput } from '@shared/analysisData'
import { AnalysisError } from './errors'
import { readOnlySql } from './sqlGuard'

export type SqlResult = { rows: (string | null)[][]; fields: FieldPacket[]; serverVersion: string }
export function sqlFailure(error: unknown): AnalysisError {
  if (error instanceof AnalysisError) return error
  const code = (error as { code?: string })?.code
  if (code === 'ER_ACCESS_DENIED_ERROR') return new AnalysisError('SQL_AUTH_FAILED')
  if (code === 'ER_BAD_DB_ERROR' || code === 'ER_DBACCESS_DENIED_ERROR')
    return new AnalysisError('SQL_DATABASE')
  if (['ETIMEDOUT', 'PROTOCOL_SEQUENCE_TIMEOUT', 'ER_QUERY_TIMEOUT'].includes(code ?? ''))
    return new AnalysisError('SQL_TIMEOUT')
  if (
    [
      'ECONNREFUSED',
      'ENOTFOUND',
      'ECONNRESET',
      'HANDSHAKE_SSL_ERROR',
      'PROTOCOL_CONNECTION_LOST'
    ].includes(code ?? '')
  )
    return new AnalysisError('SQL_CONNECT_FAILED')
  return new AnalysisError('SQL_QUERY_FAILED')
}
export async function withSql<T>(
  config: SqlConnectionInput,
  signal: AbortSignal,
  action: (connection: Connection) => Promise<T>
): Promise<T> {
  if (signal.aborted) throw signal.reason
  const connection = mysql.createConnection({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password ?? '',
    connectTimeout: 10000,
    multipleStatements: false,
    flags: ['-LOCAL_FILES'],
    rowsAsArray: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    dateStrings: true,
    jsonStrings: true,
    ...(config.tls ? { ssl: { rejectUnauthorized: true, verifyIdentity: true } } : {})
  })
  let rejectAbort: ((error: unknown) => void) | undefined
  const cancelled = new Promise<never>((_, reject) => {
    rejectAbort = reject
  })
  const abort = () => {
    connection.destroy()
    rejectAbort?.(signal.reason ?? new AnalysisError('SQL_CANCELLED'))
  }
  signal.addEventListener('abort', abort, { once: true })
  const ignoreError = () => {}
  connection.on('error', ignoreError)
  try {
    const pending = (async () => {
      await new Promise<void>((resolve, reject) =>
        connection.connect((error) => (error ? reject(error) : resolve()))
      )
      if (signal.aborted) throw signal.reason
      await connection
        .promise()
        .query("SET SESSION sql_mode = 'STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES'")
      await connection.promise().query('SET SESSION max_execution_time = 20000')
      await connection.promise().query('SET SESSION sql_select_limit = 5001')
      await connection.promise().query('START TRANSACTION READ ONLY')
      return action(connection)
    })()
    if (signal.aborted) abort()
    return await Promise.race([pending, cancelled])
  } catch (error) {
    if (signal.aborted)
      throw signal.reason instanceof AnalysisError
        ? signal.reason
        : new AnalysisError('SQL_CANCELLED')
    throw sqlFailure(error)
  } finally {
    signal.removeEventListener('abort', abort)
    connection.destroy()
  }
}
export function readSqlRows(
  connection: Connection,
  sql: string,
  signal: AbortSignal,
  maxRows = 5000
): Promise<{ rows: (string | null)[][]; fields: FieldPacket[] }> {
  return new Promise((resolve, reject) => {
    const rows: (string | null)[][] = []
    let fields: FieldPacket[] = []
    let bytes = 0
    let done = false
    const finish = (error?: unknown) => {
      if (done) return
      done = true
      signal.removeEventListener('abort', cancel)
      if (error) {
        connection.destroy()
        reject(error)
      } else resolve({ rows, fields })
    }
    const cancel = () => finish(signal.reason ?? new AnalysisError('SQL_CANCELLED'))
    signal.addEventListener('abort', cancel, { once: true })
    const query = connection.query({ sql, timeout: 30000, rowsAsArray: true })
    query.on('fields', (value: FieldPacket[]) => {
      fields = value
      if (fields.length > 40) finish(new AnalysisError('SQL_LIMIT'))
    })
    query.on('result', (value: unknown) => {
      if (done) return
      if (!Array.isArray(value)) return finish(new AnalysisError('SQL_QUERY_FAILED'))
      const row = value.map((cell) =>
        cell == null ? null : Buffer.isBuffer(cell) ? '0x' + cell.toString('hex') : String(cell)
      )
      bytes += Buffer.byteLength(JSON.stringify(row), 'utf8')
      if (rows.length >= maxRows || bytes > 4 * 1024 * 1024 || row.length > 40)
        return finish(new AnalysisError('SQL_LIMIT'))
      rows.push(row)
    })
    query.once('error', (error) => finish(sqlFailure(error)))
    query.once('end', () => finish())
    if (signal.aborted) cancel()
  })
}
export async function executeSql(
  config: SqlConnectionInput,
  query: string,
  signal: AbortSignal
): Promise<SqlResult> {
  const validated = readOnlySql(query)
  return withSql(config, signal, async (connection) => {
    const version = await readSqlRows(connection, 'SELECT VERSION()', signal, 1)
    const result = await readSqlRows(connection, validated, signal)
    if (
      !result.fields.length ||
      new Set(result.fields.map((f) => f.name)).size !== result.fields.length
    )
      throw new AnalysisError('SQL_QUERY_FAILED')
    return { ...result, serverVersion: version.rows[0][0] ?? '' }
  })
}
