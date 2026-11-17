import * as XLSX from 'xlsx'
import type { AnalysisSource } from '@shared/analysis'
import type { JoinInput, SourceOrigin } from '@shared/analysisData'
import { datasetTable, type LoadedWorkbook } from './workbook'
import { decimal, decimalString } from './decimal'
import { AnalysisError } from './errors'

export function joinWorkbooks(
  left: LoadedWorkbook,
  right: LoadedWorkbook,
  leftSource: AnalysisSource,
  rightSource: AnalysisSource,
  input: JoinInput
) {
  const l = datasetTable(left, leftSource, input.left.sheet, input.left.headerRow)
  const r = datasetTable(right, rightSource, input.right.sheet, input.right.headerRow)
  if (
    !l.columns.some((c) => c.key === input.left.key) ||
    !r.columns.some((c) => c.key === input.right.key)
  )
    throw new AnalysisError('JOIN_KEY')
  if (l.columns.length + r.columns.length > 40 || l.rows.length > 2000 || r.rows.length > 2000)
    throw new AnalysisError('JOIN_LIMIT')
  const key = (value: string | null) => {
    if (value == null || value === '') return null
    try {
      return input.keyKind === 'number' ? decimalString(decimal(value)) : value
    } catch {
      throw new AnalysisError('JOIN_KEY')
    }
  }
  const lookup = new Map<string, (typeof r.rows)[number]>()
  let missingRightKeys = 0
  for (const row of r.rows) {
    const k = key(row.cells[input.right.key])
    if (k == null) {
      missingRightKeys++
      continue
    }
    if (lookup.has(k)) throw new AnalysisError('JOIN_CARDINALITY')
    lookup.set(k, row)
  }
  const seen = new Set<string>()
  const parents: NonNullable<SourceOrigin['parents']> = []
  const addParent = (parent: NonNullable<SourceOrigin['parents']>[number]) => {
    const index = parents.findIndex(
      (p) => p.id === parent.id && p.sha256 === parent.sha256 && p.sheet === parent.sheet
    )
    if (index >= 0) return index
    if (parents.length >= 8) throw new AnalysisError('JOIN_LIMIT')
    parents.push(parent)
    return parents.length - 1
  }
  const side = (source: AnalysisSource, sheet: string) => {
    if (source.origin?.kind === 'join') {
      if (!source.origin.parents || !source.origin.columns || !source.origin.rowMap)
        throw new AnalysisError('JOIN_KEY')
      const remap = source.origin.parents.map(addParent)
      return {
        columns: new Map(
          source.origin.columns.map((c) => [c.output, { parent: remap[c.parent], input: c.input }])
        ),
        rows: new Map(
          source.origin.rowMap.map((r) => [
            r.output,
            r.sources.map((s) => ({ ...s, parent: remap[s.parent] }))
          ])
        )
      }
    }
    const parent = addParent({
      id: source.id,
      name: source.name,
      sha256: source.sha256,
      sheet,
      kind: source.origin?.kind ?? 'file',
      ...(source.origin?.fileExecution ? { fileExecution: source.origin.fileExecution } : {}),
      ...(source.origin?.query
        ? {
            query: source.origin.query,
            database: source.origin.database,
            result: source.origin.result,
            createdAt: source.origin.createdAt,
            types: source.origin.types,
            serverVersion: source.origin.serverVersion,
            acquisition: source.origin.acquisition,
            powerBi: source.origin.powerBi
          }
        : {})
    })
    return { columns: undefined, rows: undefined, parent }
  }
  const ls = side(leftSource, input.left.sheet),
    rs = side(rightSource, input.right.sheet)
  const sourceRows = (s: ReturnType<typeof side>, record: (typeof l.rows)[number]) =>
    s.rows
      ? (s.rows.get(record.row) ?? [])
      : [{ parent: s.parent!, row: record.row, cells: record.rawCells }]
  const data: (string | null)[][] = [
    [...l.columns.map((c) => 'L.' + c.label), ...r.columns.map((c) => 'R.' + c.label)]
  ]
  const rowMap: NonNullable<SourceOrigin['rowMap']> = []
  let matched = 0,
    unmatched = 0,
    missingLeftKeys = 0
  for (const row of l.rows) {
    const k = key(row.cells[input.left.key])
    if (k == null) missingLeftKeys++
    if (k != null && input.cardinality === 'one_to_one' && seen.has(k))
      throw new AnalysisError('JOIN_CARDINALITY')
    if (k != null) seen.add(k)
    const other = k == null ? undefined : lookup.get(k)
    if (other) matched++
    else unmatched++
    if (!other && input.kind === 'inner') continue
    data.push([
      ...l.columns.map((c) => row.cells[c.key]),
      ...r.columns.map((c) => other?.cells[c.key] ?? null)
    ])
    const sources = [...sourceRows(ls, row), ...(other ? sourceRows(rs, other) : [])]
    // A self-join can reference different rows of the same input. Such a mapping is ambiguous.
    if (new Set(sources.map((s) => s.parent)).size !== sources.length) {
      const byParent = new Map<number, number>()
      for (const s of sources) {
        if (byParent.has(s.parent) && byParent.get(s.parent) !== s.row)
          throw new AnalysisError('JOIN_KEY')
        byParent.set(s.parent, s.row)
      }
      rowMap.push({
        output: data.length,
        sources: [...new Map(sources.map((s) => [s.parent, s])).values()]
      })
    } else rowMap.push({ output: data.length, sources })
  }
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(data), '数据')
  const column = (s: ReturnType<typeof side>, key: string) =>
    s.columns?.get(key) ?? { parent: s.parent!, input: key }
  const steps = [
    ...new Map(
      [
        ...(leftSource.origin?.steps ?? []),
        ...(rightSource.origin?.steps ?? []),
        { input, leftSha: leftSource.sha256, rightSha: rightSource.sha256 }
      ].map((step) => [JSON.stringify(step), step])
    ).values()
  ]
  if (steps.length > 12) throw new AnalysisError('JOIN_LIMIT')
  const { title, ...join } = input
  const origin: SourceOrigin = {
    version: 'dataset/1',
    kind: 'join',
    title,
    createdAt: new Date().toISOString(),
    rows: data.length - 1,
    join,
    parents,
    steps,
    columns: [
      ...l.columns.map((c, i) => ({ output: XLSX.utils.encode_col(i), ...column(ls, c.key) })),
      ...r.columns.map((c, i) => ({
        output: XLSX.utils.encode_col(i + l.columns.length),
        ...column(rs, c.key)
      }))
    ],
    rowMap,
    matched,
    unmatched,
    missingLeftKeys,
    missingRightKeys
  }
  return { base64: XLSX.write(book, { type: 'base64', bookType: 'xlsx' }) as string, origin }
}
