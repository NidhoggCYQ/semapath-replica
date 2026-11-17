import { createHash } from 'node:crypto'
import { lstat, open } from 'node:fs/promises'
import * as XLSX from 'xlsx'
import { z } from 'zod'
import {
  FileExecutionTableSchema,
  type FileExecutionTable,
  type FileExecutionOrigin
} from '@shared/analysisFileExecution'
import type { SnapshotPayload } from './retrieval/types'
import { DatasetBuildSchema } from '@shared/analysisData'

export const FileResultsBuildSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), datasets: z.array(DatasetBuildSchema).min(1).max(100) }),
  z.object({ ok: z.literal(false), issue: z.string() })
])
export type FileExecutionMetadata = Omit<
  FileExecutionOrigin,
  'tableIndex' | 'tableSha256' | 'table'
>

export const FILE_RESULT_MAX_BYTES = 32 * 1024 * 1024
export const fileResultHash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex')
export class FileResultError extends Error {
  constructor(public readonly issue: string) {
    super(issue)
  }
}
class ExactNumber {
  constructor(readonly text: string) {}
}
const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/
const isoDate = z.union([z.iso.date(), z.iso.datetime({ local: true, offset: true })])
const excelDate = z
  .object({
    type: z.literal('excel-date'),
    serial: z.string().max(256),
    format: z.string().max(256),
    date1904: z.boolean()
  })
  .strict()

function dateCell(value: unknown): string | null {
  const parsed = excelDate.safeParse(value)
  if (!parsed.success || !numeric.test(parsed.data.serial)) return null
  const data = parsed.data
  const match = /^\+?(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(data.serial)
  if (!match || !XLSX.SSF.is_date(data.format)) return null
  const exponent = Number(match[3] ?? 0)
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 256) return null
  const fraction = match[2] ?? ''
  const scale = fraction.length - exponent
  const numerator = BigInt(match[1] + fraction) * 10n ** BigInt(Math.max(0, -scale))
  const denominator = 10n ** BigInt(Math.max(0, scale))
  const days = Number(numerator / denominator)
  if (!Number.isSafeInteger(days)) return null
  const date = XLSX.SSF.parse_date_code(days, { date1904: data.date1904 })
  if (!date) return null
  const pad = (n: number) => String(n).padStart(2, '0')
  const seconds = (numerator % denominator) * 86400n
  const whole = seconds / denominator
  const decimals = (seconds % denominator)
    .toString()
    .padStart(Math.max(0, scale), '0')
    .replace(/0+$/, '')
  const text = `${String(date.y).padStart(4, '0')}-${pad(date.m)}-${pad(date.d)}T${pad(Number(whole / 3600n))}:${pad(Number((whole / 60n) % 60n))}:${pad(Number(whole % 60n))}${decimals ? '.' + decimals : ''}`
  return isoDate.safeParse(text).success ? text : null
}

export function decodeFileResult(raw: string): FileExecutionTable[] {
  if (Buffer.byteLength(raw, 'utf8') > FILE_RESULT_MAX_BYTES) throw new FileResultError('too_large')
  let payload: unknown
  try {
    payload = JSON.parse(raw.replace(/^\uFEFF/, ''), ((
      _key: string,
      value: unknown,
      context?: { source?: string }
    ) => {
      if (typeof value !== 'number') return value
      if (!context?.source) throw new FileResultError('lossless_json_unavailable')
      return new ExactNumber(context.source)
    }) as Parameters<typeof JSON.parse>[1])
  } catch {
    throw new FileResultError('invalid_json')
  }
  const envelope = z
    .object({ complete: z.boolean(), tables: z.array(z.unknown()).min(1).max(100) })
    .strict()
    .safeParse(payload)
  if (!envelope.success) throw new FileResultError('invalid_table')
  if (!envelope.data.complete) throw new FileResultError('incomplete')
  let cells = 0
  return envelope.data.tables.map((input) => {
    const parsed = z
      .object({
        title: z.string().trim().min(1).max(200),
        columns: z.array(z.string().trim().min(1).max(500)).min(1).max(256),
        columnTypes: z.array(z.enum(['number', 'text', 'boolean', 'date'])).optional(),
        rows: z.array(z.array(z.unknown()).max(256)).max(50000)
      })
      .strict()
      .safeParse(input)
    if (!parsed.success) throw new FileResultError('invalid_table')
    const table = parsed.data
    if (
      new Set(table.columns).size !== table.columns.length ||
      (table.columnTypes && table.columnTypes.length !== table.columns.length)
    )
      throw new FileResultError('invalid_table')
    cells += (table.rows.length + 1) * table.columns.length
    if (cells > 500000) throw new FileResultError('cell_limit')
    const numericColumns = new Set<number>()
    const booleanColumns = new Set<number>()
    const dateColumns = new Set<number>()
    const excelDates: NonNullable<FileExecutionTable['excelDates']> = []
    const rows = table.rows.map((row, rowIndex) => {
      if (row.length !== table.columns.length) throw new FileResultError('invalid_table')
      return row.map((value, col) => {
        let cell: string | null
        if (value === null) cell = null
        else if (value instanceof ExactNumber) {
          cell = value.text
          numericColumns.add(col)
        } else if (typeof value === 'string') cell = value
        else if (typeof value === 'boolean') {
          cell = String(value)
          booleanColumns.add(col)
        } else {
          cell = dateCell(value)
          if (cell === null) throw new FileResultError('invalid_table')
          dateColumns.add(col)
          const typedDate = excelDate.parse(value)
          excelDates.push({
            row: rowIndex,
            column: col,
            serial: typedDate.serial,
            format: typedDate.format,
            date1904: typedDate.date1904
          })
        }
        const requested = table.columnTypes?.[col]
        if (
          cell !== null &&
          ((requested === 'number' && !numeric.test(cell)) ||
            (requested === 'boolean' && typeof value !== 'boolean') ||
            (requested === 'date' && !isoDate.safeParse(cell).success))
        )
          throw new FileResultError('invalid_column_type')
        return cell
      })
    })
    const columnTypes = table.columns.map(
      (_, col) =>
        table.columnTypes?.[col] ??
        (dateColumns.has(col) &&
        rows.every((r) => r[col] === null || isoDate.safeParse(r[col]).success)
          ? 'date'
          : booleanColumns.has(col) &&
              rows.every((r) => r[col] === null || ['true', 'false'].includes(r[col]!))
            ? 'boolean'
            : numericColumns.has(col) && rows.every((r) => r[col] === null || numeric.test(r[col]!))
              ? 'number'
              : 'text')
    )
    return FileExecutionTableSchema.parse({
      title: table.title,
      columns: table.columns,
      columnTypes,
      rows,
      ...(excelDates.length ? { excelDates } : {})
    })
  })
}

export async function readFileResult(file: string): Promise<string> {
  const before = await lstat(file)
  if (!before.isFile() || before.isSymbolicLink()) throw new FileResultError('read_failed')
  if (before.size > FILE_RESULT_MAX_BYTES) throw new FileResultError('too_large')
  const handle = await open(file, 'r')
  try {
    const opened = await handle.stat()
    if (opened.dev !== before.dev || opened.ino !== before.ino)
      throw new FileResultError('read_failed')
    const bytes = Buffer.alloc(Math.min(before.size + 1, FILE_RESULT_MAX_BYTES + 1))
    let count = 0
    while (count < bytes.length) {
      const { bytesRead } = await handle.read(bytes, count, bytes.length - count, count)
      if (!bytesRead) break
      count += bytesRead
    }
    const after = await handle.stat()
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new FileResultError('read_failed')
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(0, count)
      )
    } catch {
      throw new FileResultError('invalid_utf8')
    }
  } finally {
    await handle.close()
  }
}

export function fileResultSnapshot(execution: FileExecutionOrigin): SnapshotPayload {
  const book = XLSX.utils.book_new()
  const table = execution.table
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      table.columns,
      ...table.rows.map((row) => row.map((cell) => cell ?? ''))
    ]),
    '数据'
  )
  return {
    bytes: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer,
    origin: {
      version: 'dataset/1',
      kind: 'file_execution',
      title: table.title,
      createdAt: execution.finishedAt,
      rows: table.rows.length,
      fileExecution: execution
    }
  }
}

export function buildFileResultDatasets(raw: string, metadata: FileExecutionMetadata) {
  try {
    const datasets = decodeFileResult(raw).map((table, tableIndex) => {
      const payload = fileResultSnapshot({
        ...metadata,
        tableIndex,
        table,
        tableSha256: fileResultHash(JSON.stringify(table))
      })
      return { base64: payload.bytes.toString('base64'), origin: payload.origin }
    })
    return { ok: true as const, datasets }
  } catch (error) {
    return {
      ok: false as const,
      issue: error instanceof FileResultError ? error.issue : 'invalid_table'
    }
  }
}
