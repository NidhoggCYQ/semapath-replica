import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import {
  loadWorkbook,
  describeWorkbook,
  previewWorkbook,
  calculateWorkbook,
  type LoadedWorkbook
} from '@/analysis/workbook'
import type { AnalysisPlan } from '@shared/analysis'
import { createAnalysisWorkbook } from '../../fixtures/analysisWorkbook'

let directory: string
let file: string
const plan = (sourceId: string, overrides: Partial<AnalysisPlan> = {}): AnalysisPlan => ({
  sourceId,
  sheet: '销售明细',
  headerRow: 1,
  operation: 'sum',
  measure: 'C',
  groupBy: 'B',
  filters: [],
  question: '',
  unit: '元',
  period: '2026-10',
  ...overrides
})
async function custom(
  rows: unknown[][],
  mutate?: (sheet: XLSX.WorkSheet) => void
): Promise<LoadedWorkbook> {
  const book = XLSX.utils.book_new()
  const sheet = XLSX.utils.aoa_to_sheet(rows)
  mutate?.(sheet)
  XLSX.utils.book_append_sheet(book, sheet, '销售明细')
  await writeFile(file, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }))
  return loadWorkbook(file)
}
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'semapath-analysis-'))
  file = path.join(directory, 'synthetic-sales.xlsx')
  await writeFile(file, createAnalysisWorkbook())
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})
describe('Excel calculation and provenance', () => {
  it('preserves exact decimal sums, zero, blanks, source hash and original input addresses', async () => {
    const loaded = await loadWorkbook(file)
    const run = calculateWorkbook(loaded, loaded.source, plan(loaded.source.id))
    expect(
      run.values.map(({ category, value, included, blank }) => ({
        category,
        value,
        included,
        blank
      }))
    ).toEqual([
      { category: '华东', value: '0.3', included: 2, blank: 1 },
      { category: '华南', value: '8', included: 3, blank: 0 }
    ])
    expect(run.values[0].inputs).toEqual([
      { row: 2, cell: 'C2', value: '0.1' },
      { row: 3, cell: 'C3', value: '0.2' }
    ])
    expect(run.source.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(run.chart.evidenceId).toBe(run.evidenceId)
    expect(run.matchedRows).toBe(6)
  })
  it('preserves large numeric text without conversion to binary floats', async () => {
    const loaded = await custom([
      ['区域', '金额'],
      ['A', '9007199254740993.01'],
      ['A', '0.02']
    ])
    const run = calculateWorkbook(
      loaded,
      loaded.source,
      plan(loaded.source.id, { measure: 'B', groupBy: 'A' })
    )
    expect(run.values[0].value).toBe('9007199254740993.03')
    expect(run.warnings).toContain('TEXT_NUMBERS')
  })
  it('retains exact mean numerator and denominator when decimal display is rounded', async () => {
    const loaded = await custom([
      ['区域', '金额'],
      ['A', 1],
      ['A', 0],
      ['A', 0]
    ])
    const run = calculateWorkbook(
      loaded,
      loaded.source,
      plan(loaded.source.id, { measure: 'B', groupBy: 'A', operation: 'average' })
    )
    expect(run.values[0]).toMatchObject({
      value: '0.333333333333',
      exact: '1 / 3',
      numerator: '1',
      denominator: 3
    })
    expect(run.warnings).toContain('ROUNDING_12_DP')
  })
  it('counts matching nonempty records including blank measure cells', async () => {
    const loaded = await loadWorkbook(file)
    const run = calculateWorkbook(
      loaded,
      loaded.source,
      plan(loaded.source.id, {
        operation: 'count',
        measure: '',
        filters: [{ column: 'B', operator: 'eq', value: '华东' }]
      })
    )
    expect(run.values[0]).toMatchObject({ value: '3', included: 3 })
    expect(run.values[0].inputs.map((input) => input.row)).toEqual([2, 3, 6])
  })
  it.each([
    ['min', '-2.05'],
    ['max', '10.05']
  ] as const)('computes %s over matching values', async (operation, value) => {
    const loaded = await loadWorkbook(file)
    const run = calculateWorkbook(
      loaded,
      loaded.source,
      plan(loaded.source.id, { operation, groupBy: '' })
    )
    expect(run.values[0].value).toBe(value)
  })
  it('applies numeric filters using decimal comparison', async () => {
    const loaded = await loadWorkbook(file)
    const run = calculateWorkbook(
      loaded,
      loaded.source,
      plan(loaded.source.id, {
        groupBy: '',
        filters: [
          { column: 'C', operator: 'gt', value: '0.15' },
          { column: 'B', operator: 'eq', value: '华东' }
        ]
      })
    )
    expect(run.values[0].value).toBe('0.2')
  })
  it('previews exactly 50 rows per page with original worksheet row positions', async () => {
    const loaded = await loadWorkbook(file)
    const first = previewWorkbook(loaded, loaded.source, '分页检查', 1, 1)
    const second = previewWorkbook(loaded, loaded.source, '分页检查', 1, 2)
    expect(first.rows).toHaveLength(50)
    expect(second.rows).toHaveLength(15)
    expect(second.rows[0].rowNumber).toBe(52)
    expect(second.pageCount).toBe(2)
    expect(second.rows[0].cells[1].address).toBe('B52')
  })
  it('distinguishes duplicate header labels by original column letters and configurable header rows', async () => {
    const loaded = await custom([['说明'], ['区域', '金额', '金额'], ['华东', 1, 2]])
    const preview = previewWorkbook(loaded, loaded.source, '销售明细', 2, 1)
    expect(preview.columns.map((column) => column.key)).toEqual(['A', 'B', 'C'])
    const run = calculateWorkbook(
      loaded,
      loaded.source,
      plan(loaded.source.id, { headerRow: 2, measure: 'C', groupBy: 'A' })
    )
    expect(run.values[0].value).toBe('2')
    expect(run.values[0].inputs[0].cell).toBe('C3')
  })
  it('uses saved formula values and marks them as cached', async () => {
    const loaded = await custom(
      [
        ['区域', '金额'],
        ['A', 1]
      ],
      (sheet) => {
        sheet.B2 = { t: 'n', f: 'SUM(2,3)', v: 5 }
      }
    )
    const run = calculateWorkbook(
      loaded,
      loaded.source,
      plan(loaded.source.id, { measure: 'B', groupBy: 'A' })
    )
    expect(run.values[0].value).toBe('5')
    expect(run.warnings).toContain('CACHED_FORMULAS')
  })
  it('refuses formulas with no saved value', async () => {
    const loaded = await custom(
      [
        ['区域', '金额'],
        ['A', 1]
      ],
      (sheet) => {
        sheet.B2 = { t: 'n', f: 'SUM(2,3)' }
      }
    )
    expect(() =>
      calculateWorkbook(
        loaded,
        loaded.source,
        plan(loaded.source.id, { measure: 'B', groupBy: 'A' })
      )
    ).toThrow('FORMULA_CACHE_MISSING')
  })
  it.each([true, 'not-a-number'])('refuses invalid numeric measures (%s)', async (value) => {
    const loaded = await custom([
      ['区域', '金额'],
      ['A', value]
    ])
    expect(() =>
      calculateWorkbook(
        loaded,
        loaded.source,
        plan(loaded.source.id, { measure: 'B', groupBy: 'A' })
      )
    ).toThrow('INVALID_NUMBER')
  })
  it('refuses date-formatted numeric measures rather than summing Excel serials', async () => {
    const loaded = await custom(
      [
        ['区域', '日期'],
        ['A', 45000]
      ],
      (sheet) => {
        sheet.B2.z = 'yyyy-mm-dd'
      }
    )
    expect(() =>
      calculateWorkbook(
        loaded,
        loaded.source,
        plan(loaded.source.id, { measure: 'B', groupBy: 'A' })
      )
    ).toThrow('INVALID_NUMBER')
  })
  it('refuses empty groups rather than reporting missing data as zero', async () => {
    const loaded = await custom([
      ['区域', '金额'],
      ['A', null]
    ])
    expect(() =>
      calculateWorkbook(
        loaded,
        loaded.source,
        plan(loaded.source.id, { measure: 'B', groupBy: 'A' })
      )
    ).toThrow('NO_ROWS')
  })
  it('does not silently truncate more than 100 groups', async () => {
    const loaded = await custom([
      ['区域', '金额'],
      ...Array.from({ length: 101 }, (_, index) => [String(index), 1])
    ])
    expect(() =>
      calculateWorkbook(
        loaded,
        loaded.source,
        plan(loaded.source.id, { measure: 'B', groupBy: 'A' })
      )
    ).toThrow('GROUP_LIMIT')
  })
  it('blocks a changed source while preview exposes its new fingerprint', async () => {
    const original = await loadWorkbook(file)
    await custom([
      ['区域', '金额'],
      ['A', 99]
    ])
    const changed = await loadWorkbook(file, original.source.id)
    expect(previewWorkbook(changed, original.source, '销售明细', 1, 1).changed).toBe(true)
    expect(() => calculateWorkbook(changed, original.source, plan(original.source.id))).toThrow(
      'SOURCE_CHANGED'
    )
  })
  it('reads UTF-8 CSV numeric text without losing decimal precision', async () => {
    const csv = path.join(directory, 'sales.csv')
    await writeFile(csv, '\uFEFF区域,金额\n华东,0.1\n华东,0.2\n')
    const loaded = await loadWorkbook(csv)
    const run = calculateWorkbook(
      loaded,
      loaded.source,
      plan(loaded.source.id, { sheet: loaded.source.sheets[0].name, measure: 'B', groupBy: 'A' })
    )
    expect(run.values[0].value).toBe('0.3')
  })
  it('reads legacy XLS workbooks through the same calculation and provenance path', async () => {
    const book = XLSX.read(createAnalysisWorkbook(), { type: 'buffer' })
    const legacyFile = path.join(directory, 'legacy.xls')
    await writeFile(legacyFile, XLSX.write(book, { type: 'buffer', bookType: 'biff8' }))
    const loaded = await loadWorkbook(legacyFile)
    expect(calculateWorkbook(loaded, loaded.source, plan(loaded.source.id)).values[0].value).toBe(
      '0.3'
    )
  })
  it('rejects oversized row and column ranges without publishing truncated data', async () => {
    const book = XLSX.utils.book_new()
    const sheet = XLSX.utils.aoa_to_sheet([['Header']])
    sheet.IW2 = { t: 'n', v: 1 }
    sheet['!ref'] = 'A1:IW2'
    XLSX.utils.book_append_sheet(book, sheet, 'Wide')
    await writeFile(file, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }))
    await expect(loadWorkbook(file)).rejects.toThrow('FILE_LIMIT')
    delete sheet.IW2
    sheet.A50003 = { t: 'n', v: 1 }
    sheet['!ref'] = 'A1:A50003'
    await writeFile(file, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }))
    await expect(loadWorkbook(file)).rejects.toThrow('FILE_LIMIT')
  })
  it('checks the byte limit before attempting to parse a file', async () => {
    const oversized = path.join(directory, 'oversized.csv')
    await writeFile(oversized, Buffer.alloc(20 * 1024 * 1024 + 1, 32))
    await expect(loadWorkbook(oversized)).rejects.toThrow('FILE_LIMIT')
  })
  it('rejects renamed non-workbook content and unsupported types', async () => {
    await writeFile(file, 'This is not an XLSX file')
    await expect(loadWorkbook(file)).rejects.toThrow('INVALID_WORKBOOK')
    await expect(loadWorkbook(path.join(directory, 'file.exe'))).rejects.toThrow('FILE_TYPE')
  })
})

describe('Natural analysis date filters and catalog', () => {
  it('groups real dates by calendar month, sorts chronologically and retains original row addresses', async () => {
    const loaded = await custom([
      ['日期', '销售额'],
      ['2026/10/2', '0.2'],
      ['2026年9月30日', '0.1'],
      ['2026-10-03', '0.3'],
      ['2025-10-01', 100]
    ])
    const run = calculateWorkbook(
      loaded,
      loaded.source,
      plan(loaded.source.id, {
        measure: 'B',
        groupBy: 'A',
        grouping: 'month',
        groupOrder: 'ascending',
        filters: [{ column: 'A', operator: 'gte', kind: 'date', value: '2026-01-01' }]
      })
    )
    expect(run.values.map((value) => [value.category, value.value])).toEqual([
      ['2026-09', '0.1'],
      ['2026-10', '0.5']
    ])
    expect(run.values[1].inputs.map((input) => input.cell)).toEqual(['B2', 'B4'])
  })
  it('supports typed numeric equality/inequality and an explicit category OR set', async () => {
    const loaded = await custom([
      ['区域', '金额'],
      ['A', '1.00'],
      ['B', '2'],
      ['C', null]
    ])
    const numeric = calculateWorkbook(
      loaded,
      loaded.source,
      plan(loaded.source.id, {
        measure: 'B',
        groupBy: '',
        filters: [{ column: 'B', operator: 'neq', kind: 'number', value: '1' }]
      })
    )
    expect(numeric.values[0].value).toBe('2')
    const set = calculateWorkbook(
      loaded,
      loaded.source,
      plan(loaded.source.id, {
        measure: 'B',
        groupBy: '',
        filters: [{ column: 'A', operator: 'in', kind: 'text', value: '', values: ['A', 'B'] }]
      })
    )
    expect(set.values[0].value).toBe('3')
  })
  it('honors the workbook 1904 date system rather than treating date serials as ordinary numbers', async () => {
    const book = XLSX.utils.book_new()
    book.Workbook = { WBProps: { date1904: true } }
    const sheet = XLSX.utils.aoa_to_sheet([
      ['日期', '金额'],
      [1, 10],
      [2, 20]
    ])
    sheet.A2.z = 'yyyy-mm-dd'
    sheet.A3.z = 'yyyy-mm-dd'
    XLSX.utils.book_append_sheet(book, sheet, '销售明细')
    await writeFile(file, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }))
    const loaded = await loadWorkbook(file)
    const run = calculateWorkbook(
      loaded,
      loaded.source,
      plan(loaded.source.id, {
        measure: 'B',
        groupBy: 'A',
        grouping: 'day',
        filters: [{ column: 'A', operator: 'eq', kind: 'date', value: '1904-01-02' }]
      })
    )
    expect(run.values.map((value) => [value.category, value.value])).toEqual([['1904-01-02', '10']])
    expect(run.warnings).toContain('DATE_SYSTEM_1904')
  })
  it('bounds model samples and preserves exact column identity without exposing native paths', async () => {
    const loaded = await loadWorkbook(file)
    const catalog = describeWorkbook(loaded, loaded.source)
    expect(catalog.sheets[1].sampleRows).toHaveLength(12)
    expect(catalog.sheets[0].sampleRows[0].cells[2]).toMatchObject({ column: 'C', text: '销售额' })
    expect(JSON.stringify(catalog)).not.toContain(file)
    const changed = { ...loaded.source, sha256: 'different' }
    expect(() => describeWorkbook(loaded, changed)).toThrow('SOURCE_CHANGED')
  })
})
