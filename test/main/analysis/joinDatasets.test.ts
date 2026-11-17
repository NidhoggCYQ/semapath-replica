import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { AnalysisRunSchema, type AnalysisPlan, type AnalysisTask } from '@shared/analysis'
import type { JoinInput } from '@shared/analysisData'
import { joinWorkbooks } from '@/analysis/joinWorkbook'
import {
  loadWorkbook,
  calculateWorkbook,
  describeWorkbook,
  type LoadedWorkbook
} from '@/analysis/workbook'
import { candidateHash } from '@/analysis/integrity'
import { freezeReportAnswer, validateReportSnapshot } from '@/analysis/reports/snapshot'
import { buildReportDocument } from '@/analysis/reports/document'

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'semapath-join-'))
})
afterEach(async () => {
  if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir()))
    throw new Error('Unsafe fixture cleanup')
  await rm(directory, { recursive: true, force: true })
})
async function workbook(name: string, rows: unknown[][], edit?: (book: XLSX.WorkBook) => void) {
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), '数据')
  edit?.(book)
  const file = path.join(directory, name + '.xlsx')
  await writeFile(file, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }))
  return loadWorkbook(file)
}
function joinInput(
  left: LoadedWorkbook,
  right: LoadedWorkbook,
  overrides: Partial<JoinInput> = {}
): JoinInput {
  return {
    title: '关联结果',
    left: { sourceId: left.source.id, sheet: '数据', headerRow: 1, key: 'A' },
    right: { sourceId: right.source.id, sheet: '数据', headerRow: 1, key: 'A' },
    kind: 'left',
    cardinality: 'many_to_one',
    keyKind: 'text',
    ...overrides
  }
}
async function join(left: LoadedWorkbook, right: LoadedWorkbook, input = joinInput(left, right)) {
  const result = joinWorkbooks(left, right, left.source, right.source, input)
  const file = path.join(directory, randomUUID() + '.xlsx')
  await writeFile(file, Buffer.from(result.base64, 'base64'))
  const loaded = await loadWorkbook(file)
  loaded.source.name = input.title + '.xlsx'
  loaded.source.origin = result.origin
  return loaded
}
function calculate(loaded: LoadedWorkbook, overrides: Partial<AnalysisPlan> = {}) {
  return AnalysisRunSchema.parse(
    calculateWorkbook(loaded, loaded.source, {
      sourceId: loaded.source.id,
      sheet: '数据',
      headerRow: 1,
      operation: 'sum',
      measure: 'B',
      groupBy: 'E',
      filters: [],
      question: '按区域核对金额',
      unit: '元',
      period: '',
      ...overrides
    })
  )
}
async function fixture() {
  const left = await workbook('订单', [
    ['客户', '金额', '订单号'],
    ['001', '0.1', '9007199254740993001'],
    ['001', '0.2', '9007199254740993002'],
    ['002', '5', '9007199254740993003'],
    ['003', '2.5', '9007199254740993004'],
    ['', '1', '9007199254740993005']
  ])
  const right = await workbook('客户区域', [
    ['客户', '区域'],
    ['001', '华东'],
    ['002', '华南'],
    ['004', '华西'],
    ['', '空键不匹配']
  ])
  return { left, right }
}
describe('Joined snapshots, original cells and frozen reports', () => {
  it('allows the MySQL locator plus forty business columns without widening Excel catalogs', async () => {
    const columns = Array.from({ length: 41 }, (_, i) => String(i))
    const loaded = await workbook('wide', [columns, columns])
    expect(() => describeWorkbook(loaded, loaded.source)).toThrow('ANALYSIS_CONTEXT_LIMIT')
    loaded.source.origin = {
      version: 'dataset/1',
      kind: 'mysql',
      title: 'wide',
      createdAt: new Date().toISOString(),
      rows: 1,
      database: 'fixture',
      query: 'SELECT columns FROM fixture',
      result: { columns, rows: [columns] }
    }
    expect(describeWorkbook(loaded, loaded.source).sheets[0].columnCount).toBe(41)
  })
  it('keeps exact decimals and bigint text, left rows and original root records', async () => {
    const { left, right } = await fixture(),
      loaded = await join(left, right),
      run = calculate(loaded)
    expect(run.values.map((v) => [v.category, v.value])).toEqual([
      ['华东', '0.3'],
      ['华南', '5'],
      ['', '3.5']
    ])
    expect(loaded.book.Sheets.数据.C2.v).toBe('9007199254740993001')
    expect(loaded.source.origin).toMatchObject({
      rows: 5,
      matched: 3,
      unmatched: 2,
      missingLeftKeys: 1,
      missingRightKeys: 1
    })
    expect(run.values[0].inputs[0].origin).toEqual([
      {
        sourceId: left.source.id,
        source: left.source.name,
        sha256: left.source.sha256,
        sheet: '数据',
        cell: 'B2',
        value: '0.1'
      },
      {
        sourceId: right.source.id,
        source: right.source.name,
        sha256: right.source.sha256,
        sheet: '数据',
        cell: 'B2',
        value: '华东'
      }
    ])
    expect(loaded.source.origin!.rowMap![0].sources[0].cells!.C).toBe('9007199254740993001')
  })
  it('does not match blank keys and inner join includes only matched left records', async () => {
    const { left, right } = await fixture()
    const loaded = await join(left, right, joinInput(left, right, { kind: 'inner' }))
    expect(loaded.source.origin!.rows).toBe(3)
    expect(calculate(loaded).values.map((v) => v.value)).toEqual(['0.3', '5'])
  })
  it('makes leading-zero text and explicit decimal key matching different choices', async () => {
    const left = await workbook('left', [
      ['key', 'value'],
      ['001', '0.1']
    ])
    const right = await workbook('right', [
      ['key', 'region'],
      ['1', 'east']
    ])
    const text = await join(left, right),
      numeric = await join(left, right, joinInput(left, right, { keyKind: 'number' }))
    expect(text.source.origin!.matched).toBe(0)
    expect(numeric.source.origin!.matched).toBe(1)
    await expect(
      join(
        left,
        await workbook('bad', [
          ['key', 'region'],
          ['abc', 'east']
        ]),
        joinInput(left, right, { keyKind: 'number' })
      )
    ).rejects.toThrow('JOIN_KEY')
  })
  it('rejects duplicate keys instead of silently multiplying amounts', async () => {
    const { left, right } = await fixture()
    const duplicated = await workbook('duplicates', [
      ['key', 'region'],
      ['001', 'east'],
      ['001', 'west']
    ])
    expect(() =>
      joinWorkbooks(left, duplicated, left.source, duplicated.source, joinInput(left, duplicated))
    ).toThrow('JOIN_CARDINALITY')
    expect(() =>
      joinWorkbooks(
        left,
        right,
        left.source,
        right.source,
        joinInput(left, right, { cardinality: 'one_to_one' })
      )
    ).toThrow('JOIN_CARDINALITY')
  })
  it('flattens a second join to all original files and keeps original cell values', async () => {
    const { left, right } = await fixture(),
      first = await join(left, right)
    const targets = await workbook('区域目标', [
      ['区域', '目标'],
      ['华东', '100'],
      ['华南', '200']
    ])
    const second = await join(
      first,
      targets,
      joinInput(first, targets, {
        left: { sourceId: first.source.id, sheet: '数据', headerRow: 1, key: 'E' }
      })
    )
    expect(second.source.origin!.parents!.map((p) => p.id)).toEqual([
      left.source.id,
      right.source.id,
      targets.source.id
    ])
    expect(second.source.origin!.steps).toHaveLength(2)
    const run = calculate(second, { groupBy: 'F' })
    expect(run.values[0].value).toBe('0.3')
    expect(run.values[0].inputs[0].origin!.at(-1)).toMatchObject({
      sourceId: targets.source.id,
      cell: 'A2',
      value: '华东'
    })
  })
  it('retains Excel date meaning across the 1904 system while freezing original serials', async () => {
    const parsed = XLSX.SSF.parse_date_code(43000, { date1904: true })
    const iso = [
      String(parsed.y),
      String(parsed.m).padStart(2, '0'),
      String(parsed.d).padStart(2, '0')
    ].join('-')
    const left = await workbook(
      'dated',
      [
        ['日期', '金额'],
        [43000, '0.1']
      ],
      (book) => {
        book.Workbook = { WBProps: { date1904: true } }
        book.Sheets.数据.A2.z = 'yyyy-mm-dd'
      }
    )
    const right = await workbook('calendar', [
      ['日期', '区域'],
      [iso, '华东']
    ])
    const loaded = await join(left, right)
    const run = calculate(loaded, {
      groupBy: 'A',
      grouping: 'month',
      filters: [{ column: 'A', operator: 'eq', kind: 'date', value: iso }]
    })
    expect(run.values[0]).toMatchObject({ category: iso.slice(0, 7), value: '0.1' })
    expect(run.values[0].inputs[0].origin!.find((c) => c.cell === 'A2')).toMatchObject({
      value: '43000',
      sourceId: left.source.id
    })
  })
  it('rejects changed parents and oversized joins before saving a new source', async () => {
    const { left, right } = await fixture()
    expect(() =>
      joinWorkbooks(
        left,
        right,
        { ...left.source, sha256: 'bad' },
        right.source,
        joinInput(left, right)
      )
    ).toThrow('SOURCE_CHANGED')
    const large = await workbook('large', [
      ['key', 'amount'],
      ...Array.from({ length: 2001 }, (_, i) => [String(i), 1])
    ])
    expect(() =>
      joinWorkbooks(large, right, large.source, right.source, joinInput(large, right))
    ).toThrow('JOIN_LIMIT')
  })
  it('freezes SQL query, all SQL rows, root cells and join mapping into a portable report', async () => {
    const { left, right } = await fixture()
    left.source.origin = {
      version: 'dataset/1',
      kind: 'mysql',
      title: 'SQL订单',
      createdAt: new Date().toISOString(),
      rows: 5,
      query: "SELECT customer,amount,id FROM orders WHERE memo <> '<script>bad</script>'",
      database: 'fixture',
      result: {
        columns: ['customer', 'amount', 'id'],
        rows: [2, 3, 4, 5, 6].map((r) =>
          ['A', 'B', 'C'].map((c) => String(left.book.Sheets.数据[c + r]?.v ?? ''))
        )
      }
    }
    const loaded = await join(left, right),
      run = calculate(loaded)
    run.answer = {
      status: 'published',
      candidateHash: candidateHash(run),
      publishedAt: new Date().toISOString()
    }
    const task: AnalysisTask = {
      version: 1,
      id: randomUUID(),
      title: '合成关联验收',
      createdAt: run.createdAt,
      updatedAt: run.createdAt,
      sources: [],
      runs: [run],
      turns: []
    }
    await unlink(left.source.path)
    await unlink(right.source.path)
    await unlink(loaded.source.path)
    const snapshot = freezeReportAnswer(task, {
      kind: 'run',
      id: run.id,
      candidateHash: run.answer.candidateHash
    })
    expect(snapshot.runs[0].source.origin!.parents![0].result!.rows).toHaveLength(5)
    const html = buildReportDocument(
      snapshot,
      { format: 'a4', locale: 'zh-CN', title: '关联报告' },
      'a'.repeat(64)
    )
    expect(html).toContain('客户区域.xlsx · 数据!B2=华东')
    expect(html).toContain('&lt;script&gt;bad&lt;/script&gt;')
    expect(html).not.toContain('<script>bad</script>')
    expect(JSON.stringify(snapshot)).not.toContain(directory)
    const invalid = structuredClone(snapshot)
    invalid.runs[0].values[0].inputs[0].origin![0].cell = 'B999'
    expect(() => validateReportSnapshot(invalid)).toThrow('REPORT_INVALID_SNAPSHOT')
    const changed = structuredClone(snapshot)
    changed.runs[0].source.origin!.parents![0].result!.rows[0][1] = '999'
    expect(() => validateReportSnapshot(changed)).toThrow('REPORT_INVALID_SNAPSHOT')
  })
})
