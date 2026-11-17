import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import * as XLSX from 'xlsx'
import type {
  AnalysisSource,
  AnalysisPlan,
  AnalysisPreview,
  AnalysisRun,
  WorkbookCatalog
} from '@shared/analysis'
import { AnalysisError } from './errors'
import { calculateStudy, type StudyInputRow } from './studyEngine'
import { add, compare, decimal, decimalString, divide, type Decimal } from './decimal'

export type LoadedWorkbook = { book: XLSX.WorkBook; source: AnalysisSource }
const MAX_BYTES = 20 * 1024 * 1024
const MAX_CELLS = 500000
export async function loadWorkbook(
  filePath: string,
  id: string = randomUUID()
): Promise<LoadedWorkbook> {
  if (!['.xlsx', '.xls', '.csv'].includes(path.extname(filePath).toLowerCase()))
    throw new AnalysisError('FILE_TYPE')
  let bytes: Buffer
  let modifiedAt: string
  try {
    const info = await stat(filePath)
    if (!info.isFile()) throw new AnalysisError('FILE_UNREADABLE')
    if (info.size > MAX_BYTES) throw new AnalysisError('FILE_LIMIT')
    bytes = await readFile(filePath)
    modifiedAt = info.mtime.toISOString()
  } catch (error) {
    if (error instanceof AnalysisError) throw error
    throw new AnalysisError('FILE_UNREADABLE')
  }
  if (bytes.length > MAX_BYTES) throw new AnalysisError('FILE_LIMIT')
  if (
    path.extname(filePath).toLowerCase() === '.xlsx' &&
    (bytes.length < 2 || bytes.readUInt16LE(0) !== 0x4b50)
  )
    throw new AnalysisError('INVALID_WORKBOOK')
  // A workbook is parsed from the same bytes whose fingerprint is recorded in its evidence.
  let book: XLSX.WorkBook
  try {
    book = XLSX.read(bytes, {
      type: 'buffer',
      cellFormula: true,
      sheetStubs: true,
      nodim: true,
      WTF: true,
      cellNF: true,
      cellText: true,
      cellDates: false,
      raw: true
    })
  } catch {
    throw new AnalysisError('INVALID_WORKBOOK')
  }
  let cells = 0
  const sheets = book.SheetNames.map((name) => {
    const sheet = book.Sheets[name]
    const range = XLSX.utils.decode_range(sheet['!ref'] ?? 'A1')
    const rows = range.e.r - range.s.r + 1
    const columns = range.e.c - range.s.c + 1
    cells += rows * columns
    if (rows > 50001 || columns > 256 || cells > MAX_CELLS) throw new AnalysisError('FILE_LIMIT')
    return { name, firstRow: range.s.r + 1, lastRow: range.e.r + 1, columnCount: columns }
  })
  if (!sheets.length) throw new AnalysisError('INVALID_WORKBOOK')
  return {
    book,
    source: {
      id,
      path: filePath,
      name: path.basename(filePath),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      modifiedAt,
      boundAt: new Date().toISOString(),
      sheets
    }
  }
}
function sheetContext(loaded: LoadedWorkbook, sheetName: string, headerRow: number) {
  const sheet = loaded.book.Sheets[sheetName]
  if (!sheet || !sheet['!ref']) throw new AnalysisError('NO_ROWS')
  const range = XLSX.utils.decode_range(sheet['!ref'])
  if (headerRow < range.s.r + 1 || headerRow > range.e.r + 1)
    throw new AnalysisError('INVALID_COLUMN')
  const columns = Array.from({ length: range.e.c - range.s.c + 1 }, (_, offset) => {
    const index = range.s.c + offset
    const key = XLSX.utils.encode_col(index)
    return {
      key,
      label: XLSX.utils.format_cell(sheet[`${key}${headerRow}`] ?? { t: 's', v: '' }) || key
    }
  })
  return { sheet, range, columns }
}
export function describeWorkbook(loaded: LoadedWorkbook, bound: AnalysisSource): WorkbookCatalog {
  if (loaded.source.sha256 !== bound.sha256) throw new AnalysisError('SOURCE_CHANGED')
  if (loaded.source.sheets.length > 20) throw new AnalysisError('ANALYSIS_CONTEXT_LIMIT')
  return {
    sourceId: bound.id,
    ...(bound.origin?.fileExecution
      ? {
          fileExecution: {
            id: bound.origin.fileExecution.id,
            verification: bound.origin.fileExecution.verification,
            replay: bound.origin.fileExecution.replay
          }
        }
      : {}),
    name: bound.name,
    sha256: bound.sha256,
    sheets: loaded.source.sheets.map((metadata) => {
      // MySQL adds one locator column to its at-most-40 business columns.
      if (
        metadata.columnCount >
        (bound.origin?.kind === 'file_execution'
          ? 256
          : ['mysql', 'powerbi'].includes(bound.origin?.kind ?? '')
            ? 41
            : 40)
      )
        throw new AnalysisError('ANALYSIS_CONTEXT_LIMIT')
      const sheet = loaded.book.Sheets[metadata.name]
      const range = XLSX.utils.decode_range(sheet['!ref'] ?? 'A1')
      const sampleRows: WorkbookCatalog['sheets'][number]['sampleRows'] = []
      for (let row = range.s.r; row <= Math.min(range.e.r, range.s.r + 11); row++) {
        sampleRows.push({
          row: row + 1,
          cells: Array.from({ length: range.e.c - range.s.c + 1 }, (_, index) => {
            const column = XLSX.utils.encode_col(range.s.c + index)
            const cell = sheet[`${column}${row + 1}`] as XLSX.CellObject | undefined
            return {
              column,
              text: cell?.v == null ? '' : String(cell.v).slice(0, 160),
              type: cell?.t ?? 'blank',
              numberFormat: cell?.z == null ? null : String(cell.z),
              formulaCached: cell?.f ? cell.v != null : null
            }
          })
        })
      }
      return { ...metadata, sampleRows }
    })
  }
}
function dateKey(cell: XLSX.CellObject | undefined, date1904: boolean): string {
  if (cell?.f && cell.v == null) throw new AnalysisError('FORMULA_CACHE_MISSING')
  if (!cell || cell.v == null || cell.v === '') return ''
  let year: number
  let month: number
  let day: number
  if (cell.t === 'n' && cell.z && XLSX.SSF.is_date(cell.z)) {
    const parsed = XLSX.SSF.parse_date_code(Number(cell.v), { date1904 })
    if (!parsed) throw new AnalysisError('INVALID_NUMBER')
    year = parsed.y
    month = parsed.m
    day = parsed.d
  } else {
    const match = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})(?:日|(?:[ T].*)?)$/.exec(String(cell.v))
    if (!match) throw new AnalysisError('INVALID_NUMBER')
    year = Number(match[1])
    month = Number(match[2])
    day = Number(match[3])
  }
  const check = new Date(Date.UTC(year, month - 1, day))
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day
  )
    throw new AnalysisError('INVALID_NUMBER')
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}
export function previewWorkbook(
  loaded: LoadedWorkbook,
  bound: AnalysisSource,
  sheetName: string,
  headerRow: number,
  page: number
): AnalysisPreview {
  const { sheet, range, columns } = sheetContext(loaded, sheetName, headerRow)
  const totalRows = Math.max(0, range.e.r + 1 - headerRow)
  const pageCount = Math.max(1, Math.ceil(totalRows / 50))
  const currentPage = Math.min(page, pageCount)
  const first = headerRow + (currentPage - 1) * 50
  const rows = Array.from(
    { length: Math.max(0, Math.min(50, range.e.r + 1 - first)) },
    (_, offset) => {
      const row = first + offset
      return {
        rowNumber: row + 1,
        cells: columns.map(({ key }) => {
          const address = `${key}${row + 1}`
          const cell = sheet[address] as XLSX.CellObject | undefined
          return {
            address,
            display: cell ? XLSX.utils.format_cell(cell) : '',
            formula: cell?.f ?? null,
            error: cell?.t === 'e' || (!!cell?.f && cell.v == null)
          }
        })
      }
    }
  )
  return {
    sourceId: bound.id,
    sha256: loaded.source.sha256,
    changed: loaded.source.sha256 !== bound.sha256,
    sheet: sheetName,
    headerRow,
    page: currentPage,
    pageCount,
    totalRows,
    columns,
    rows
  }
}
function cellText(cell?: XLSX.CellObject): string {
  return cell?.v == null ? '' : String(cell.v)
}
function matches(
  cell: XLSX.CellObject | undefined,
  filter: AnalysisPlan['filters'][number],
  date1904 = false
): boolean {
  if (cell?.f && cell.v == null) throw new AnalysisError('FORMULA_CACHE_MISSING')
  if (cell?.t === 'e') throw new AnalysisError('INVALID_NUMBER')
  const text = filter.kind === 'date' ? dateKey(cell, date1904) : cellText(cell)
  if (filter.operator === 'in') return (filter.values ?? []).includes(text)
  if (filter.operator === 'neq' && filter.kind !== 'number') return text !== filter.value
  if (filter.operator === 'eq' && filter.kind !== 'number') return text === filter.value
  if (filter.operator === 'contains') return text.includes(filter.value)
  if (!text) return false
  let comparison: number
  try {
    if (filter.kind === 'date') {
      const target = dateKey({ t: 's', v: filter.value }, false)
      comparison = text < target ? -1 : text > target ? 1 : 0
    } else comparison = compare(decimal(text), decimal(filter.value))
  } catch {
    throw new AnalysisError('INVALID_NUMBER')
  }
  if (filter.operator === 'eq') return comparison === 0
  if (filter.operator === 'neq') return comparison !== 0
  return filter.operator === 'gt'
    ? comparison > 0
    : filter.operator === 'gte'
      ? comparison >= 0
      : filter.operator === 'lt'
        ? comparison < 0
        : comparison <= 0
}
function calculateWorkbookRaw(
  loaded: LoadedWorkbook,
  bound: AnalysisSource,
  plan: AnalysisPlan
): AnalysisRun {
  const started = performance.now()
  if (loaded.source.sha256 !== bound.sha256) throw new AnalysisError('SOURCE_CHANGED')
  const { sheet, range, columns } = sheetContext(loaded, plan.sheet, plan.headerRow)
  const rowScope = plan.rowScope ? new Set(plan.rowScope.rows) : undefined
  if (
    plan.rowScope &&
    (plan.rowScope.sourceSha256 !== bound.sha256 ||
      plan.rowScope.rows.length !== rowScope!.size ||
      plan.rowScope.rows.some((row) => row <= plan.headerRow || row > range.e.r + 1))
  )
    throw new AnalysisError('INVALID_ANALYSIS_CONTEXT')
  if (plan.study) {
    const config = plan.study
    const numericColumns = new Set(
      [
        ...(plan.operation === 'count' ? [] : [plan.measure]),
        config.secondMeasure,
        config.sizeMeasure,
        ...(config.factors ?? []),
        ...(config.stages ?? []),
        ...(config.rules ?? []).flatMap((rule) =>
          rule.conditions.filter((c) => c.kind === 'number').map((c) => c.column)
        )
      ].filter((value): value is string => !!value)
    )
    const selectedColumns = new Set(
      [
        ...numericColumns,
        plan.groupBy,
        config.observationBy,
        config.seriesBy,
        ...plan.filters.map((filter) => filter.column),
        ...(config.rules ?? []).flatMap((rule) => rule.conditions.map((c) => c.column))
      ].filter((value): value is string => !!value)
    )
    if ([...selectedColumns].some((key) => !columns.some((column) => column.key === key)))
      throw new AnalysisError('INVALID_COLUMN')
    if (
      config.rules &&
      new Set(config.rules.map((rule) => rule.label)).size !== config.rules.length
    )
      throw new AnalysisError('METHOD_REQUIREMENTS')
    const warnings = new Set<AnalysisRun['warnings'][number]>()
    const records: StudyInputRow[] = []
    let emptyRows = 0
    for (let row = plan.headerRow; row <= range.e.r; row++) {
      const rowNumber = row + 1
      if (rowScope && !rowScope.has(rowNumber)) continue
      if (
        !columns.some(({ key }) => {
          const c = sheet[`${key}${rowNumber}`]
          return c && (c.v != null || c.f)
        })
      ) {
        emptyRows++
        continue
      }
      if (plan.filters.some((filter) => sheet[`${filter.column}${rowNumber}`]?.f))
        warnings.add('CACHED_FORMULAS')
      if (
        !plan.filters.every((filter) =>
          matches(
            sheet[`${filter.column}${rowNumber}`],
            filter,
            !!loaded.book.Workbook?.WBProps?.date1904
          )
        )
      )
        continue
      if (records.length >= 2000) throw new AnalysisError('METHOD_DATA_LIMIT')
      const record: StudyInputRow = { row: rowNumber, fields: {}, numbers: {}, inputs: [] }
      for (const key of selectedColumns) {
        const address = `${key}${rowNumber}`
        const cell = sheet[address] as XLSX.CellObject | undefined
        if (cell?.f && cell.v == null) throw new AnalysisError('FORMULA_CACHE_MISSING')
        if (cell?.t === 'e') throw new AnalysisError('INVALID_NUMBER')
        if (cell?.f) warnings.add('CACHED_FORMULAS')
        const raw = cellText(cell)
        record.fields[key] = raw
        record.inputs.push({ row: rowNumber, cell: address, value: raw })
        if (numericColumns.has(key)) {
          if (raw === '') record.numbers[key] = null
          else {
            if (cell?.t === 'b' || (cell?.z && XLSX.SSF.is_date(cell.z)))
              throw new AnalysisError('INVALID_NUMBER')
            try {
              record.numbers[key] = decimalString(decimal(raw))
            } catch {
              throw new AnalysisError('INVALID_NUMBER')
            }
            if (cell?.t === 's') warnings.add('TEXT_NUMBERS')
          }
        }
      }
      if (config.method === 'cycle-analysis' && plan.groupBy) {
        const dateCell = sheet[`${plan.groupBy}${rowNumber}`] as XLSX.CellObject | undefined
        const raw = cellText(dateCell)
        if (raw) {
          const normalized =
            /^\d{4}-\d{2}$/.test(raw) && config.interval === 'month'
              ? raw + '-01'
              : /^\d{4}$/.test(raw) && config.interval === 'year'
                ? raw + '-01-01'
                : null
          record.date = dateKey(
            normalized ? { t: 's', v: normalized } : dateCell,
            !!loaded.book.Workbook?.WBProps?.date1904
          )
        }
      }
      records.push(record)
    }
    if (loaded.book.Workbook?.WBProps?.date1904) warnings.add('DATE_SYSTEM_1904')
    return calculateStudy({
      source: { ...loaded.source, boundAt: bound.boundAt },
      plan,
      rows: records,
      headers: Object.fromEntries(columns.map((column) => [column.key, column.label])),
      scannedRows: range.e.r + 1 - plan.headerRow,
      emptyRows,
      warnings: [...warnings],
      started
    })
  }
  const keys = new Set(columns.map((column) => column.key))
  if (
    (plan.operation !== 'count' && !keys.has(plan.measure)) ||
    (plan.groupBy && !keys.has(plan.groupBy)) ||
    plan.filters.some((filter) => !keys.has(filter.column))
  )
    throw new AnalysisError('INVALID_COLUMN')
  const warnings = new Set<AnalysisRun['warnings'][number]>()
  if (loaded.book.Workbook?.WBProps?.date1904) warnings.add('DATE_SYSTEM_1904')
  type Group = {
    category: string
    sum: Decimal
    min: Decimal | null
    max: Decimal | null
    included: number
    blank: number
    inputs: AnalysisRun['values'][number]['inputs']
  }
  const groups = new Map<string, Group>()
  let matchedRows = 0
  let emptyRows = 0
  for (let row = plan.headerRow; row <= range.e.r; row++) {
    const rowNumber = row + 1
    if (rowScope && !rowScope.has(rowNumber)) continue
    if (
      !columns.some(({ key }) => {
        const cell = sheet[`${key}${rowNumber}`]
        return cell && (cell.v != null || cell.f)
      })
    ) {
      emptyRows++
      continue
    }
    if (plan.filters.some((filter) => sheet[`${filter.column}${rowNumber}`]?.f))
      warnings.add('CACHED_FORMULAS')
    if (
      !plan.filters.every((filter) =>
        matches(
          sheet[`${filter.column}${rowNumber}`],
          filter,
          !!loaded.book.Workbook?.WBProps?.date1904
        )
      )
    )
      continue
    matchedRows++
    const groupCell = plan.groupBy
      ? (sheet[`${plan.groupBy}${rowNumber}`] as XLSX.CellObject | undefined)
      : undefined
    if (groupCell?.f && groupCell.v == null) throw new AnalysisError('FORMULA_CACHE_MISSING')
    if (groupCell?.t === 'e') throw new AnalysisError('INVALID_NUMBER')
    if (groupCell?.f) warnings.add('CACHED_FORMULAS')
    const rawCategory = plan.groupBy ? cellText(groupCell) : ''
    const category =
      plan.groupBy && plan.grouping && plan.grouping !== 'raw' && rawCategory !== ''
        ? dateKey(groupCell, !!loaded.book.Workbook?.WBProps?.date1904).slice(
            0,
            plan.grouping === 'month' ? 7 : 10
          )
        : rawCategory
    let group = groups.get(category)
    if (!group) {
      if (groups.size >= 100) throw new AnalysisError('GROUP_LIMIT')
      group = {
        category,
        sum: decimal('0'),
        min: null,
        max: null,
        included: 0,
        blank: 0,
        inputs: []
      }
      groups.set(category, group)
    }
    const address = `${plan.operation === 'count' ? columns[0].key : plan.measure}${rowNumber}`
    const cell = sheet[address] as XLSX.CellObject | undefined
    if (plan.operation === 'count') {
      group.included++
      group.inputs.push({ row: rowNumber, cell: address, value: '1' })
      continue
    }
    if (cell?.f && cell.v == null) throw new AnalysisError('FORMULA_CACHE_MISSING')
    if (cell?.t === 'e') throw new AnalysisError('INVALID_NUMBER')
    if (cell?.f) warnings.add('CACHED_FORMULAS')
    if (cell?.v == null || cell.v === '') {
      group.blank++
      continue
    }
    if (cell.t === 'b' || (cell.z && XLSX.SSF.is_date(cell.z)))
      throw new AnalysisError('INVALID_NUMBER')
    let value: Decimal
    try {
      value = decimal(String(cell.v))
    } catch {
      throw new AnalysisError('INVALID_NUMBER')
    }
    if (cell.t === 's') warnings.add('TEXT_NUMBERS')
    group.sum = add(group.sum, value)
    if (!group.min || compare(value, group.min) < 0) group.min = value
    if (!group.max || compare(value, group.max) > 0) group.max = value
    group.included++
    group.inputs.push({ row: rowNumber, cell: address, value: decimalString(value) })
  }
  if (!matchedRows) throw new AnalysisError('NO_ROWS')
  const runId = randomUUID()
  const orderedGroups = [...groups.values()]
  if (plan.groupOrder && plan.groupOrder !== 'source')
    orderedGroups.sort(
      (left, right) =>
        left.category.localeCompare(right.category, 'en', { numeric: true }) *
        (plan.groupOrder === 'descending' ? -1 : 1)
    )
  const values = orderedGroups.map((group, index) => {
    if (!group.included) throw new AnalysisError('NO_ROWS')
    const numerator =
      plan.operation === 'count'
        ? String(group.included)
        : decimalString(
            plan.operation === 'min'
              ? group.min!
              : plan.operation === 'max'
                ? group.max!
                : group.sum
          )
    const denominator = plan.operation === 'average' ? group.included : 1
    const result =
      denominator === 1
        ? { value: numerator, exact: numerator, rounded: false }
        : divide(group.sum, denominator)
    if (result.rounded) warnings.add('ROUNDING_12_DP')

    return {
      id: `${runId}:${index}`,
      category: group.category,
      value: result.value,
      exact: result.exact,
      numerator,
      denominator,
      included: group.included,
      blank: group.blank,
      inputs: group.inputs
    }
  })
  const evidenceId = `excel:${runId}`
  const { boundAt: _boundAt, ...sourceSnapshot } = loaded.source
  return {
    id: runId,
    createdAt: new Date().toISOString(),
    source: { ...sourceSnapshot, boundAt: bound.boundAt },
    plan,
    measureLabel: columns.find((column) => column.key === plan.measure)?.label ?? '',
    groupLabel: columns.find((column) => column.key === plan.groupBy)?.label ?? '',
    evidenceId,
    scannedRows: range.e.r + 1 - plan.headerRow,
    matchedRows,
    emptyRows,
    values,
    warnings: [...warnings],
    execution: {
      engine: 'semapath-excel/1',
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      plan: JSON.stringify(plan, null, 2),
      stdout: JSON.stringify({
        scannedRows: range.e.r + 1 - plan.headerRow,
        matchedRows,
        emptyRows,
        groups: values.length,
        inputSha256: loaded.source.sha256
      })
    },
    chart: { kind: 'bar', evidenceId },
    answer: { status: 'draft', candidateHash: '', publishedAt: null }
  }
}

export function datasetTable(
  loaded: LoadedWorkbook,
  bound: AnalysisSource,
  sheetName: string,
  headerRow: number
) {
  if (loaded.source.sha256 !== bound.sha256) throw new AnalysisError('SOURCE_CHANGED')
  const { sheet, range, columns } = sheetContext(loaded, sheetName, headerRow)
  const rows: {
    row: number
    cells: Record<string, string | null>
    rawCells: Record<string, string | null>
  }[] = []
  for (let row = headerRow + 1; row <= range.e.r + 1; row++) {
    const cells: Record<string, string | null> = {}
    const rawCells: Record<string, string | null> = {}
    for (const column of columns) {
      const cell = sheet[column.key + row] as XLSX.CellObject | undefined
      if (cell?.f && cell.v == null) throw new AnalysisError('FORMULA_CACHE_MISSING')
      if (cell?.t === 'e') throw new AnalysisError('INVALID_NUMBER')
      rawCells[column.key] = cell?.v == null ? null : cellText(cell)
      cells[column.key] =
        cell?.t === 'n' && cell.z && XLSX.SSF.is_date(cell.z)
          ? dateKey(cell, !!loaded.book.Workbook?.WBProps?.date1904)
          : rawCells[column.key]
    }
    if (Object.values(cells).some((value) => value != null && value !== ''))
      rows.push({ row, cells, rawCells })
    if (rows.length > 50000) throw new AnalysisError('JOIN_LIMIT')
  }
  return { columns, rows }
}

export function calculateWorkbook(
  loaded: LoadedWorkbook,
  bound: AnalysisSource,
  plan: AnalysisPlan
): AnalysisRun {
  const run = calculateWorkbookRaw(loaded, bound, plan)
  if (!bound.origin) return run
  run.source.origin = bound.origin
  run.source.name = bound.name
  if (bound.origin.kind !== 'join') return run
  const origin = bound.origin
  const rows = new Map(origin.rowMap?.map((row) => [row.output, row]))
  const columns = new Map(origin.columns?.map((column) => [column.output, column]))
  const sheet = loaded.book.Sheets[plan.sheet]
  for (const value of run.values)
    for (const input of value.inputs) {
      const row = rows.get(input.row)
      for (const cell of new Set([
        input.cell,
        ...(plan.groupBy ? [plan.groupBy + input.row] : []),
        ...plan.filters.map((f) => f.column + input.row)
      ])) {
        const mapping = columns.get(cell.replace(/\d+$/, ''))
        const parent = mapping ? origin.parents?.[mapping.parent] : undefined
        const parentRecord = row?.sources.find((source) => source.parent === mapping?.parent)
        if (!mapping || !parent || !parentRecord) continue
        input.origin ??= []
        input.origin.push({
          sourceId: parent.id,
          source: parent.name,
          sha256: parent.sha256,
          sheet: parent.sheet,
          cell: mapping.input + parentRecord.row,
          value: parentRecord.cells
            ? (parentRecord.cells[mapping.input] ?? '')
            : cellText(sheet[cell])
        })
      }
    }
  if (Buffer.byteLength(JSON.stringify(run), 'utf8') > 28 * 1024 * 1024)
    throw new AnalysisError('METHOD_DATA_LIMIT')
  return run
}
