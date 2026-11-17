import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { AnalysisPlan, AnalysisSource, AnalysisTask } from '@shared/analysis'
import { AnalysisRunSchema } from '@shared/analysis'
import type { FileExecutionRequest } from '@shared/analysisFileExecution'
import { AnalysisService } from '@/analysis/service'
import { AnalysisFileExecutionService } from '@/analysis/fileExecutionService'
import { AnalysisTasksTable } from '@/analysis/data/analysisTasks'
import { FileExecutionsTable } from '@/analysis/data/fileExecutions'
import {
  buildFileResultDatasets,
  decodeFileResult,
  fileResultHash,
  readFileResult
} from '@/analysis/fileResult'
import { freezeReportAnswer, validateReportSnapshot } from '@/analysis/reports/snapshot'
import { buildReportDocument } from '@/analysis/reports/document'
import { createAnalysisWorkbook } from '../../fixtures/analysisWorkbook'

vi.mock('@/analysis/workerClient', async () => {
  const actual = await import('@/analysis/workbook')
  const results = await import('@/analysis/fileResult')
  return {
    inspectWorkbook: async (file: string, id?: string) =>
      (await actual.loadWorkbook(file, id)).source,
    calculateSource: async (source: AnalysisSource, plan: AnalysisPlan) =>
      AnalysisRunSchema.parse(
        actual.calculateWorkbook(await actual.loadWorkbook(source.path, source.id), source, plan)
      ),
    buildFileResultSnapshots: async (...args: Parameters<typeof results.buildFileResultDatasets>) =>
      results.buildFileResultDatasets(...args)
  }
})

const tables = {
  complete: true,
  tables: [
    {
      title: '合成代码输出',
      columns: ['区域', '计算额'],
      columnTypes: ['text', 'number'],
      rows: [
        ['华东', '0.3'],
        ['华南', '8']
      ]
    },
    { title: '空表', columns: ['说明'], rows: [] }
  ]
}
let directory: string,
  db: DatabaseSync,
  analysis: AnalysisService,
  files: AnalysisFileExecutionService
let task: AnalysisTask, sessionId: string, request: FileExecutionRequest
let currentTask: string | null
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'semapath-file-execution-'))
  db = new DatabaseSync(':memory:')
  const native = {
    prepare: (sql: string) => db.prepare(sql),
    exec: (sql: string) => db.exec(sql),
    transaction: (fn: () => unknown) => () => {
      db.exec('BEGIN')
      try {
        const value = fn()
        db.exec('COMMIT')
        return value
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
  }
  const connection = { getDatabase: () => native } as never
  new AnalysisTasksTable(native as never).createTable()
  new FileExecutionsTable(native as never).createTable()
  analysis = new AnalysisService(connection, undefined, path.join(directory, 'datasets'))
  task = analysis.create('合成执行任务')
  const input = path.join(directory, '销售 输入.xlsx')
  await writeFile(input, createAnalysisWorkbook())
  task = await analysis.addSources(task.id, [input])
  currentTask = task.id
  sessionId = randomUUID()
  files = new AnalysisFileExecutionService({
    connection,
    analysis,
    root: path.join(directory, 'executions'),
    changed: vi.fn(),
    workspace: {
      isRegularSession: () => true,
      forSession: (id: string) => (id === sessionId ? currentTask : null)
    } as never
  })
  request = {
    sessionId,
    messageId: randomUUID(),
    toolCallId: randomUUID(),
    command: `node calculate.cjs ${JSON.stringify(input)}`,
    cwd: directory,
    inputs: [{ sourceId: task.sources[0].id, sheet: '销售明细', range: 'A1:D7' }],
    activeSkillNames: ['xlsx']
  }
})
afterEach(async () => {
  db.close()
  if (
    path.dirname(directory) !== path.resolve(tmpdir()) ||
    !path.basename(directory).startsWith('semapath-file-execution-')
  )
    throw Error('Unexpected test directory')
  await rm(directory, { recursive: true, force: true })
})
async function complete(
  payload = JSON.stringify(tables),
  result = { exitCode: 0, timedOut: false }
) {
  const prepared = await files.prepare(request)
  files.started(sessionId, prepared.id)
  await writeFile(prepared.env.PBI_RESULT_PATH, payload)
  return { prepared, delivery: await files.finish(sessionId, prepared.id, result) }
}

describe('Complete file table protocol', () => {
  it('keeps raw JSON numeric lexemes, booleans, null and precise string values without IEEE rounding', () => {
    const decoded = decodeFileResult(
      '{"complete":true,"tables":[{"title":"精度","columns":["大整数","小数","标志","缺失"],"rows":[[9007199254740993001,0.10000000000000000000,true,null]]}]}'
    )
    expect(decoded[0].rows[0]).toEqual([
      '9007199254740993001',
      '0.10000000000000000000',
      'true',
      null
    ])
    expect(decoded[0].columnTypes).toEqual(['number', 'number', 'boolean', 'text'])
  })
  it('retains Excel date metadata and exact subsecond serial arithmetic for both date systems', () => {
    const date = {
      type: 'excel-date',
      serial: '45000.000000000001',
      format: 'yyyy-mm-dd hh:mm:ss',
      date1904: false
    }
    const decoded = decodeFileResult(
      JSON.stringify({
        complete: true,
        tables: [
          {
            title: '日期',
            columns: ['日期'],
            columnTypes: ['date'],
            rows: [[date], [{ ...date, serial: '0.5', date1904: true }]]
          }
        ]
      })
    )
    expect(decoded[0].rows).toEqual([['2023-03-15T00:00:00.0000000864'], ['1904-01-01T12:00:00']])
    expect(decoded[0].excelDates?.[0]).toMatchObject({ serial: date.serial, row: 0, column: 0 })
  })
  it.each([
    ['partial', { ...tables, complete: false }],
    ['no tables', { complete: true, tables: [] }],
    [
      'duplicate headers',
      { complete: true, tables: [{ title: 'x', columns: ['a', 'a'], rows: [] }] }
    ],
    [
      'ragged rows',
      { complete: true, tables: [{ title: 'x', columns: ['a'], rows: [['1', '2']] }] }
    ],
    [
      'invalid declared number',
      {
        complete: true,
        tables: [{ title: 'x', columns: ['a'], columnTypes: ['number'], rows: [['unknown']] }]
      }
    ],
    [
      'invalid date',
      {
        complete: true,
        tables: [{ title: 'x', columns: ['a'], columnTypes: ['date'], rows: [['2026-02-30']] }]
      }
    ]
  ])('rejects %s rather than accepting a partial table', (_, value) =>
    expect(() => decodeFileResult(JSON.stringify(value))).toThrow()
  )
  it('rejects invalid UTF-8 and oversized on-disk delivery before import', async () => {
    const file = path.join(directory, 'invalid.json')
    const bom = '\uFEFF' + JSON.stringify(tables)
    await writeFile(file, bom)
    expect(fileResultHash(await readFileResult(file))).toBe(fileResultHash(await readFile(file)))
    expect(decodeFileResult(await readFileResult(file))).toHaveLength(2)
    await writeFile(file, Buffer.from([0xff, 0xfe, 0xfa]))
    await expect(readFileResult(file)).rejects.toMatchObject({ issue: 'invalid_utf8' })
    await writeFile(file, Buffer.alloc(32 * 1024 * 1024 + 1))
    await expect(readFileResult(file)).rejects.toMatchObject({ issue: 'too_large' })
  })
})

describe('Execution provenance, atomic registration and recovery', () => {
  it('captures actual registered input identities, imports all tables and replays without another execution', async () => {
    const { prepared, delivery } = await complete()
    expect(delivery.state).toBe('ready')
    expect(delivery.sources).toHaveLength(2)
    expect(analysis.get(task.id).sources).toHaveLength(3)
    expect(
      JSON.parse(await readFile(prepared.env.PBI_INPUTS_PATH, 'utf8')).inputs[0]
    ).toMatchObject({ path: task.sources[0].path, sha256: task.sources[0].sha256 })
    expect((await files.prepare(request)).cached).toEqual(delivery)
    expect(files.read(task.id, prepared.id, 0, 1, 1)).toMatchObject({
      total: 2,
      offset: 1,
      hasMore: false,
      table: { rows: [['华南', '8']] }
    })
    expect(JSON.stringify(files.read(task.id, prepared.id))).not.toContain(
      JSON.stringify(task.sources[0].path).slice(1, -1)
    )
    expect(files.read(task.id, prepared.id)).toMatchObject({
      metadata: { skillStatus: 'loaded', verification: 'recorded_result', replay: 'not_captured' }
    })
  })
  it.each([false, 'nonzero', 'missing', 'cancelled'] as const)(
    'never imports an unsuccessful delivery: %s',
    async (mode) => {
      const prepared = await files.prepare(request)
      files.started(sessionId, prepared.id)
      if (mode !== 'missing')
        await writeFile(
          prepared.env.PBI_RESULT_PATH,
          JSON.stringify({ ...tables, complete: mode !== false })
        )
      const controller = new AbortController()
      if (mode === 'cancelled') controller.abort()
      const delivery = await files.finish(
        sessionId,
        prepared.id,
        { exitCode: mode === 'nonzero' ? 2 : 0, timedOut: false },
        controller.signal
      )
      expect(delivery.state).toBe('failed')
      expect(analysis.get(task.id).sources).toHaveLength(1)
      expect((await files.prepare(request)).cached?.state).toBe('failed')
    }
  )
  it('rejects unregistered files and same-call argument substitution', async () => {
    await expect(
      files.prepare({ ...request, inputs: [{ sourceId: randomUUID() }] })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await files.prepare(request)
    await expect(files.prepare({ ...request, command: 'node changed.cjs' })).rejects.toMatchObject({
      code: 'ANALYSIS_TOOL_REPLAY'
    })
  })
  it('accepts an explicit registered path and preserves trailing all-null table rows', async () => {
    request.inputs = [{ path: path.relative(directory, task.sources[0].path), sheet: '销售明细' }]
    const { delivery } = await complete(
      JSON.stringify({
        complete: true,
        tables: [{ title: '保留空行', columns: ['空列'], rows: [[null], [null]] }]
      })
    )
    expect(delivery.state).toBe('ready')
    const source = analysis.get(task.id).sources.find((s) => s.id === delivery.sources[0].id)!
    expect(source.sheets[0].lastRow).toBe(3)
    expect(source.origin!.fileExecution!.table.rows).toEqual([[null], [null]])
  })
  it('rejects changed/removed inputs during execution and never leaves half the tables', async () => {
    const prepared = await files.prepare(request)
    files.started(sessionId, prepared.id)
    await writeFile(prepared.env.PBI_RESULT_PATH, JSON.stringify(tables))
    await writeFile(task.sources[0].path, 'changed')
    expect(
      (await files.finish(sessionId, prepared.id, { exitCode: 0, timedOut: false })).state
    ).toBe('failed')
    expect(analysis.get(task.id).sources).toHaveLength(1)
  })
  it('does not expose another task/session and marks unfinished commands interrupted on restart', async () => {
    const prepared = await files.prepare(request)
    files.started(sessionId, prepared.id)
    expect(() => files.started(randomUUID(), prepared.id)).toThrow()
    expect(() => files.read(randomUUID(), prepared.id)).toThrow()
    files.interruptOpen()
    expect((await files.prepare(request)).cached).toMatchObject({
      state: 'interrupted',
      issue: 'interrupted',
      sources: []
    })
  })
  it('recovers a committed source batch after interruption before the delivery ledger was updated', async () => {
    const { prepared, delivery } = await complete()
    const ledger = new FileExecutionsTable({ prepare: (sql: string) => db.prepare(sql) } as never)
    const record = ledger.get(prepared.id)!
    record.state = 'running'
    delete record.delivery
    ledger.save(record)
    files.interruptOpen()
    expect((await files.prepare(request)).cached).toMatchObject({
      state: 'ready',
      sources: delivery.sources
    })
    expect(analysis.get(task.id).sources).toHaveLength(3)
  })
  it('requires declared input versions at publication, then freezes code provenance for reports', async () => {
    const formatted = structuredClone(tables)
    formatted.tables[0].rows = [
      ['华东', '0.30'],
      ['华南', '8.00']
    ]
    const { delivery } = await complete(JSON.stringify(formatted))
    const sourceId = delivery.sources[0].id
    const updated = await analysis.run(task.id, {
      sourceId,
      sheet: '数据',
      headerRow: 1,
      operation: 'sum',
      measure: 'B',
      groupBy: 'A',
      filters: [],
      question: '合成计算',
      unit: '元',
      period: ''
    })
    const run = updated.runs.at(-1)!
    expect(run.values.map((v) => v.value)).toEqual(['0.3', '8'])
    await analysis.publish(task.id, run.id, run.answer.candidateHash)
    const snapshot = freezeReportAnswer(analysis.get(task.id), {
      kind: 'run',
      id: run.id,
      candidateHash: run.answer.candidateHash
    })
    expect(snapshot.runs[0].source.origin?.fileExecution?.inputs[0].sha256).toBe(
      task.sources[0].sha256
    )
    expect(
      buildReportDocument(snapshot, { format: 'a4', locale: 'zh-CN', title: '执行依据' })
    ).toContain('已记录的程序输出')
    const bad = structuredClone(snapshot)
    bad.runs[0].source.origin!.fileExecution!.table.rows[0][1] = '999'
    expect(() => validateReportSnapshot(bad)).toThrow()
    await writeFile(task.sources[0].path, 'changed later')
    await expect(analysis.publish(task.id, run.id, run.answer.candidateHash)).rejects.toMatchObject(
      { code: 'SOURCE_CHANGED' }
    )
    expect(() => validateReportSnapshot(snapshot)).not.toThrow()
  })
  it('builds a finite worker response and rejects invalid tables before snapshot allocation', () => {
    const source = task.sources[0]
    const metadata = {
      version: 'file-execution/1' as const,
      id: randomUUID(),
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      command: 'code',
      commandSha256: fileResultHash('code'),
      resultSha256: fileResultHash('raw'),
      skillStatus: 'not_loaded' as const,
      inputs: [
        { sourceId: source.id, name: source.name, sha256: source.sha256, bytes: source.bytes }
      ],
      verification: 'recorded_result' as const,
      replay: 'not_captured' as const
    }
    expect(
      buildFileResultDatasets(JSON.stringify({ ...tables, complete: false }), metadata)
    ).toEqual({ ok: false, issue: 'incomplete' })
  })
})
