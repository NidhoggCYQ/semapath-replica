import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AnalysisRunSchema,
  type AnalysisModel,
  type AnalysisTask,
  type NaturalAsk,
  type WorkbookCatalog
} from '@shared/analysis'
import type { PbiSchema } from '@shared/analysisPowerBi'
import type { RetrievalGateway, SnapshotPayload } from '@/analysis/retrieval/types'
import { automaticSql, automaticDax } from '@/analysis/retrieval/queryScope'
import { ConnectedDataGateway, structureHash } from '@/analysis/retrieval/gateway'
import { NaturalAnalyzer } from '@/analysis/naturalAnalyzer'
import { AnalysisService } from '@/analysis/service'
import { AnalysisError } from '@/analysis/errors'
import { freezeReportAnswer, validateReportSnapshot } from '@/analysis/reports/snapshot'
import { buildReportDocument } from '@/analysis/reports/document'

// Real workbook parsing, join cardinality, decimal arithmetic, provenance and persistence schema.
// Only the Electron worker transport, remote data and model boundary are synthetic here.
vi.mock('@/analysis/workerClient', async () => {
  const actual = await vi.importActual<typeof import('@/analysis/workbook')>('@/analysis/workbook')
  const { joinWorkbooks } =
    await vi.importActual<typeof import('@/analysis/joinWorkbook')>('@/analysis/joinWorkbook')
  return {
    inspectWorkbook: async (file: string, id?: string) =>
      (await actual.loadWorkbook(file, id)).source,
    describeSource: async (source: AnalysisTask['sources'][number]) =>
      actual.describeWorkbook(await actual.loadWorkbook(source.path, source.id), source),
    calculateSource: async (
      source: AnalysisTask['sources'][number],
      plan: AnalysisTask['runs'][number]['plan']
    ) =>
      AnalysisRunSchema.parse(
        actual.calculateWorkbook(await actual.loadWorkbook(source.path, source.id), source, plan)
      ),
    buildJoinedSource: async (
      left: AnalysisTask['sources'][number],
      right: AnalysisTask['sources'][number],
      input: Parameters<typeof joinWorkbooks>[4]
    ) =>
      joinWorkbooks(
        await actual.loadWorkbook(left.path, left.id),
        await actual.loadWorkbook(right.path, right.id),
        left,
        right,
        input
      )
  }
})
const model: AnalysisModel = {
  providerId: 'synthetic',
  modelId: 'fixture',
  modelName: '合成协议模型',
  providerName: 'Fixture',
  isDefault: true
}
const sql = 'SELECT id,customer,amount FROM orders ORDER BY id'
const tables = [
  {
    name: 'orders',
    columns: [
      { name: 'id', type: 'bigint', nullable: false },
      { name: 'customer', type: 'varchar', nullable: false },
      { name: 'amount', type: 'decimal', nullable: false }
    ]
  }
]
const pbiSchema: PbiSchema = {
  fetchedAt: '2026-10-28',
  source: 'cloud_xmla',
  coverage: {
    tables: 'available',
    columns: 'available',
    measures: 'available',
    relationships: 'available'
  },
  tables: [
    {
      name: 'Orders',
      hidden: false,
      description: '',
      columns: [
        { name: 'Amount', type: 'Decimal', hidden: false, formatString: '', expression: '' }
      ],
      measures: []
    }
  ],
  relationships: [],
  issues: []
}
describe('Automatic query structure boundaries', () => {
  it.each([
    'SELECT o.amount FROM replica_fixture.orders o',
    'SELECT * FROM (SELECT amount FROM orders) x',
    'SELECT amount FROM orders UNION ALL SELECT amount FROM orders'
  ])('accepts a known scoped read: %s', (query) =>
    expect(automaticSql(query, 'replica_fixture', tables)).toBe(query)
  )
  it.each([
    'SELECT * FROM other.orders',
    'SELECT * FROM `null`.orders',
    'SELECT (SELECT amount FROM other.orders) FROM orders',
    'SELECT * FROM information_schema.TABLES',
    'SELECT * FROM missing',
    'WITH x AS (SELECT * FROM orders) SELECT * FROM x',
    'SELECT 100 AS fake_answer'
  ])('rejects unknown or unverifiable scope: %s', (query) =>
    expect(() => automaticSql(query, 'replica_fixture', tables)).toThrow('FETCH_QUERY_SCOPE')
  )
  it('keeps the existing write guard and validates model-backed DAX', () => {
    expect(() => automaticSql('DELETE FROM orders', 'replica_fixture', tables)).toThrow(
      'SQL_READ_ONLY'
    )
    expect(automaticDax('EVALUATE SUMMARIZECOLUMNS(Orders[Amount])', pbiSchema)).toContain('Orders')
    expect(automaticDax("EVALUATE 'Orders'", pbiSchema)).toContain('Orders')
    expect(
      automaticDax("DEFINE VAR tmp = FILTER('Orders', [Amount] > 1e-20) EVALUATE tmp", pbiSchema)
    ).toContain('tmp')
    for (const query of [
      'EVALUATE ROW("fake", 100)',
      "EVALUATE 'Missing'",
      'EVALUATE INFO.TABLES()',
      "EVALUATE UNION('Orders', Secret)"
    ])
      expect(() => automaticDax(query, pbiSchema)).toThrow('FETCH_QUERY_SCOPE')
  })
})

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'semapath-retrieval-'))
})
afterEach(async () => {
  if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir()))
    throw new Error('Unsafe cleanup')
  await rm(directory, { recursive: true, force: true })
})
function payload(query = sql, empty = false): SnapshotPayload {
  const rows = empty
    ? []
    : [
        ['1', '9007199254740993001', '001', '0.10000000000000000000'],
        ['2', '9007199254740993002', '001', '0.20000000000000000000'],
        ['3', '9007199254740993003', '002', '5']
      ]
  const columns = ['结果行号', 'id', 'customer', 'amount'],
    book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([columns, ...rows]), '数据')
  return {
    bytes: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }),
    origin: {
      version: 'dataset/1',
      kind: 'mysql',
      title: '自动订单',
      createdAt: new Date().toISOString(),
      rows: rows.length,
      query,
      database: 'replica_fixture',
      connectionName: '订单库',
      result: { columns, rows }
    }
  }
}
function fixture(
  options: {
    failReview?: boolean
    empty?: boolean
    cancelReview?: boolean
    repeatFetch?: boolean
  } = {}
) {
  const rows = new Map<string, string>(),
    state = { failSave: false },
    prompts: string[] = []
  const db = {
    prepare: (statement: string) => ({
      get: (id: string) => (rows.has(id) ? { task_json: rows.get(id) } : undefined),
      run: (...args: unknown[]) => {
        if (!statement.startsWith('INSERT')) throw new Error('Unexpected SQL')
        if (state.failSave) throw new Error('Synthetic disk failure')
        rows.set(String(args[0]), String(args[6]))
      }
    })
  }
  const generate = vi.fn(async (_model: AnalysisModel, prompt: string, signal: AbortSignal) => {
    prompts.push(prompt)
    if (prompt.includes('REMOTE_CATALOG_DATA\n')) {
      const catalogs = JSON.parse(
        prompt.split('WORKBOOK_CATALOG_DATA\n')[1].split('\nACQUISITION_RESULTS_DATA')[0]
      ) as WorkbookCatalog[]
      const trace = JSON.parse(
        prompt.split('ACQUISITION_RESULTS_DATA\n')[1].split('\nLAST_ERROR_DATA')[0]
      ) as { kind: string; sourceId: string }[]
      if (!trace.length || options.repeatFetch)
        return JSON.stringify({
          action: 'fetch',
          targetId: 'mysql:fixture',
          query: sql,
          title: '自动订单'
        })
      if (options.empty)
        return JSON.stringify({ action: 'clarify', message: '所选条件没有返回订单，请确认期间。' })
      const mapping = catalogs.find((c) => c.name === '客户区域.xlsx')
      if (mapping && trace.length === 1)
        return JSON.stringify({
          action: 'join',
          input: {
            title: '订单区域',
            left: { sourceId: trace[0].sourceId, sheet: '数据', headerRow: 1, key: 'C' },
            right: { sourceId: mapping.sourceId, sheet: '区域', headerRow: 1, key: 'A' },
            kind: 'left',
            cardinality: 'many_to_one',
            keyKind: 'text'
          }
        })
      return JSON.stringify({ action: 'analyze', sourceIds: [trace.at(-1)!.sourceId] })
    }
    if (prompt.includes('EXECUTED_EVIDENCE_DATA\n')) {
      if (options.cancelReview)
        return new Promise<string>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        )
      if (options.failReview) throw new Error('Synthetic provider failure')
      return JSON.stringify({ decision: 'confirm' })
    }
    const catalogs = JSON.parse(prompt.split('WORKBOOK_CATALOG_DATA\n')[1]) as WorkbookCatalog[]
    return JSON.stringify({
      status: 'ready',
      queries: [
        {
          key: 'q1',
          sourceId: catalogs[0].sourceId,
          sheet: '数据',
          headerRow: 1,
          operation: 'sum',
          measure: 'D',
          groupBy: catalogs[0].name === '订单区域.xlsx' ? 'F' : 'C',
          filters: []
        }
      ],
      views: [{ kind: 'summary', queryKey: 'q1', chart: 'bar' }]
    })
  })
  const analyzer = new NaturalAnalyzer({ models: async () => [model], generate })
  const query = vi.fn(async (_id: string, query: string) => {
    automaticSql(query, 'replica_fixture', tables)
    return payload(query, options.empty)
  })
  const seal = vi.fn()
  const gateway: RetrievalGateway = {
    targets: () => ({
      targets: [{ id: 'mysql:fixture', kind: 'mysql', label: '订单库', detail: 'replica_fixture' }],
      issues: []
    }),
    use: async (_task, _selection, _request, _owner, signal, action) =>
      action({
        signal,
        catalogs: [
          {
            id: 'mysql:fixture',
            kind: 'mysql',
            label: '订单库',
            database: 'replica_fixture',
            structure: tables,
            structureSha256: structureHash(tables)
          }
        ],
        query,
        validate: () => signal.throwIfAborted(),
        seal
      })
  }
  analyzer.setRetrieval(gateway)
  const service = new AnalysisService({ getDatabase: () => db } as never, analyzer, directory)
  const task = service.create('自动取数验收')
  const ask: NaturalAsk = {
    requestId: randomUUID(),
    question: '按客户汇总订单金额，保留精确数值',
    providerId: model.providerId,
    modelId: model.modelId,
    retrieval: { targetIds: ['mysql:fixture'], sourceIds: [], transport: 'rest' },
    newRoot: true
  }
  return { service, analyzer, task, ask, rows, state, prompts, query, seal }
}
async function snapshotFiles(taskId: string) {
  return readdir(path.join(directory, taskId)).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
}
describe('Question acquisition, atomic persistence and frozen evidence', () => {
  it('starts without files, saves exact inputs and publishes a verifiable report without requerying', async () => {
    const f = fixture(),
      updated = await f.service.ask(f.task.id, f.ask, 7)
    expect(updated.sources).toHaveLength(1)
    expect(updated.runs[0].values.map((v) => v.value)).toEqual(['0.3', '5'])
    expect(updated.runs[0].values[0].inputs.map((i) => i.cell)).toEqual(['D2', 'D3'])
    expect(updated.sources[0].origin?.result?.rows[0][1]).toBe('9007199254740993001')
    expect(updated.sources[0].origin?.acquisition).toMatchObject({
      requestId: f.ask.requestId,
      question: f.ask.question,
      modelId: model.modelId,
      structureSha256: structureHash(tables)
    })
    expect(updated.turns[0].retrieval?.steps).toHaveLength(1)
    expect(f.seal).toHaveBeenCalledOnce()
    const turn = updated.turns[0],
      published = await f.service.publishTurn(updated.id, turn.id, turn.answer.candidateHash)
    await unlink(updated.sources[0].path)
    const frozen = freezeReportAnswer(published, {
      kind: 'turn',
      id: turn.id,
      candidateHash: turn.answer.candidateHash
    })
    validateReportSnapshot(frozen)
    const tampered = structuredClone(frozen)
    tampered.runs[0].source.origin!.acquisition!.querySha256 = '0'.repeat(64)
    expect(() => validateReportSnapshot(tampered)).toThrow('REPORT_INVALID_SNAPSHOT')
    const html = buildReportDocument(frozen, {
      format: 'a4',
      locale: 'zh-CN',
      title: '自动取数报告'
    })
    expect(html).toContain('自然语言只读取数')
    expect(html).toContain(sql)
    expect(f.query).toHaveBeenCalledOnce()
    expect(f.prompts.join('\n')).not.toContain(directory)
    expect(f.service.get(updated.id).turns[0].answer.status).toBe('published')
  })
  it('joins selected Excel data and preserves automatic query identity in root evidence', async () => {
    const f = fixture(),
      file = path.join(directory, '客户区域.xlsx'),
      book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([
        ['客户', '区域'],
        ['001', '华东'],
        ['002', '华南']
      ]),
      '区域'
    )
    await writeFile(file, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }))
    const bound = await f.service.addSources(f.task.id, [file])
    f.ask.retrieval!.sourceIds = [bound.sources[0].id]
    const result = await f.service.ask(f.task.id, f.ask, 7),
      joined = result.sources.at(-1)!
    expect(result.turns[0].retrieval?.steps.map((step) => step.kind)).toEqual(['query', 'join'])
    expect(result.runs[0].values.map((v) => [v.category, v.value])).toEqual([
      ['华东', '0.3'],
      ['华南', '5']
    ])
    expect(joined.origin?.parents?.[0].acquisition?.requestId).toBe(f.ask.requestId)
    expect(result.runs[0].values[0].inputs[0].origin?.map((o) => o.cell)).toEqual(['D2', 'B2'])
  })
  it.each(['model failure', 'save failure', 'cancel'])(
    'rolls back only new snapshots after %s',
    async (failure) => {
      const f = fixture({
        failReview: failure === 'model failure',
        cancelReview: failure === 'cancel'
      })
      const oldFile = path.join(directory, 'existing.csv')
      await writeFile(oldFile, 'Customer,Amount\n001,20\n')
      const before = await f.service.addSources(f.task.id, [oldFile])
      f.state.failSave = failure === 'save failure'
      const pending = f.service.ask(f.task.id, f.ask, 7),
        assertion = expect(pending).rejects.toThrow()
      if (failure === 'cancel') {
        await vi.waitFor(() => expect(f.analyzer.status(f.task.id)?.stage).toBe('reviewing'))
        expect(f.analyzer.cancel(f.task.id, f.ask.requestId, 8)).toBe(false)
        expect(f.analyzer.cancel(f.task.id, f.ask.requestId, 7)).toBe(true)
      }
      await assertion
      expect(f.service.get(f.task.id).sources).toEqual(before.sources)
      expect(f.service.get(f.task.id).turns).toEqual([])
      expect(await snapshotFiles(f.task.id)).toEqual([])
      expect(await readdir(directory)).toContain('existing.csv')
    }
  )
  it('persists a real zero-row snapshot with clarification instead of inventing zero sales', async () => {
    const f = fixture({ empty: true }),
      result = await f.service.ask(f.task.id, f.ask, 7)
    expect(result.sources[0].origin?.rows).toBe(0)
    expect(result.runs).toEqual([])
    expect(result.turns[0]).toMatchObject({ state: 'clarify', queryRuns: [], derived: [] })
    expect(await snapshotFiles(f.task.id)).toHaveLength(1)
  })
  it('bounds repeated model acquisition and rolls back all three provisional results', async () => {
    const f = fixture({ repeatFetch: true })
    await expect(f.service.ask(f.task.id, f.ask, 7)).rejects.toThrow('FETCH_PLAN_LIMIT')
    expect(f.query).toHaveBeenCalledTimes(3)
    expect(f.service.get(f.task.id).sources).toEqual([])
    expect(await snapshotFiles(f.task.id)).toEqual([])
  })
  it('prevents online acquisition from enlarging a fixed drill-down scope', async () => {
    const f = fixture(),
      result = await f.service.ask(f.task.id, f.ask, 7),
      parent = result.turns[0]
    await expect(
      f.service.ask(
        f.task.id,
        {
          ...f.ask,
          requestId: randomUUID(),
          newRoot: undefined,
          continuation: {
            parentTurnId: parent.id,
            parentCandidateHash: parent.answer.candidateHash,
            scope: { queryKey: 'q1' }
          }
        },
        7
      )
    ).rejects.toThrow('FETCH_SCOPE_LOCKED')
    expect(f.query).toHaveBeenCalledOnce()
    expect(f.service.get(f.task.id).turns).toHaveLength(1)
  })
})
describe('Connection scope drift', () => {
  it.each(['local', 'cloud'] as const)(
    'preserves %s Power BI type for honest transport controls',
    (kind) => {
      const model =
        kind === 'local'
          ? { name: 'Local model', databaseId: 'db' }
          : { name: 'Cloud model', datasetId: 'dataset' }
      const gateway = new ConnectedDataGateway(
        { list: () => [] } as never,
        { binding: () => ({ id: 'binding', target: { kind, model } }) } as never
      )
      expect(gateway.targets('task').targets[0]).toMatchObject({
        kind: 'powerbi',
        powerBiKind: kind,
        label: model.name
      })
    }
  )
  it('rejects schema drift before a query and rejects stale task target IDs', async () => {
    const raw = {
      signal: new AbortController().signal,
      schema: vi
        .fn()
        .mockResolvedValueOnce(tables)
        .mockResolvedValueOnce([...tables, { name: 'changed', columns: [] }]),
      query: vi.fn(),
      validate: vi.fn(),
      seal: vi.fn()
    }
    const sqlService = {
      list: () => [
        {
          id: 'id',
          name: 'Only public name',
          database: 'replica_fixture',
          host: 'private-host',
          user: 'private-user',
          password: 'secret'
        }
      ],
      withNaturalConnections: async (
        _task: string,
        _ids: string[],
        _request: string,
        _owner: number,
        _signal: AbortSignal,
        action: (sessions: Map<string, typeof raw>) => unknown
      ) => action(new Map([['id', raw]]))
    }
    const gateway = new ConnectedDataGateway(sqlService as never, { binding: () => null } as never)
    expect(JSON.stringify(gateway.targets('task'))).not.toMatch(/private-host|private-user|secret/)
    await expect(
      gateway.use(
        'task',
        { targetIds: ['mysql:id'], sourceIds: [], transport: 'rest' },
        randomUUID(),
        7,
        new AbortController().signal,
        (session) => session.query('mysql:id', sql, 'Orders')
      )
    ).rejects.toThrow('FETCH_TARGET_CHANGED')
    expect(raw.query).not.toHaveBeenCalled()
    await expect(
      gateway.use(
        'task',
        { targetIds: ['mysql:missing'], sourceIds: [], transport: 'rest' },
        randomUUID(),
        7,
        new AbortController().signal,
        vi.fn()
      )
    ).rejects.toThrow('FETCH_TARGET_CHANGED')
  })
})
