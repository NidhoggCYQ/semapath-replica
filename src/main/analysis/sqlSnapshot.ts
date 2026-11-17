import * as XLSX from 'xlsx'
import mysql from 'mysql2'
import { AnalysisError } from './errors'
import type { executeSql } from './sqlDriver'
import type { SqlConnectionInput } from '@shared/analysisData'
import type { SnapshotPayload } from './retrieval/types'
export function sqlSnapshot(
  result: Awaited<ReturnType<typeof executeSql>>,
  config: SqlConnectionInput,
  query: string,
  title: string
): SnapshotPayload {
  const ordinal = '结果行号'
  if (result.fields.some((f) => f.name === ordinal)) throw new AnalysisError('SQL_QUERY_FAILED')
  const data = {
    columns: [ordinal, ...result.fields.map((f) => f.name)],
    rows: result.rows.map((row, i) => [String(i + 1), ...row])
  }
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([data.columns, ...data.rows]), '数据')
  return {
    bytes: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer,
    origin: {
      version: 'dataset/1',
      kind: 'mysql',
      title,
      createdAt: new Date().toISOString(),
      rows: result.rows.length,
      query,
      database: config.database,
      connectionName: config.name,
      serverVersion: result.serverVersion,
      result: data,
      types: [
        { column: 'A', type: 'RESULT_ROW_ORDINAL' },
        ...result.fields.map((field, i) => ({
          column: XLSX.utils.encode_col(i + 1),
          type:
            field.columnType == null
              ? 'UNKNOWN'
              : String(mysql.Types[field.columnType] ?? field.columnType)
        }))
      ]
    }
  }
}
