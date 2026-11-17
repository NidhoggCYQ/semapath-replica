import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, readFile, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import {
  AnalysisRunSchema,
  type AnalysisTask,
  type NaturalReadyPlan,
  type NaturalTurn
} from '@shared/analysis'
import { ReportRecordSchema, type ReportCreate, type ReportRecord } from '@shared/analysisReport'
import { calculateWorkbook, loadWorkbook } from '@/analysis/workbook'
import { candidateHash, naturalTurnHash } from '@/analysis/service'
import { buildNaturalDerived } from '@/analysis/naturalFacts'
import { freezeReportAnswer, reportHash } from '@/analysis/reports/snapshot'
import { buildReportDocument, reportExpectedTokens } from '@/analysis/reports/document'
import {
  AnalysisReportService,
  reportFilename,
  type ReportRenderer
} from '@/analysis/reports/service'
import { createAnalysisWorkbook } from '../../fixtures/analysisWorkbook'
const state = vi.hoisted(() => ({ records: new Map<string, ReportRecord>() }))
vi.mock('@/analysis/data/analysisReports', () => ({
  AnalysisReportsTable: class {
    list(taskId?: string) {
      return [...state.records.values()]
        .filter((record) => !taskId || record.taskId === taskId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((record) => structuredClone(record))
    }
    get(taskId: string, id: string) {
      const record = state.records.get(id)
      if (!record || record.taskId !== taskId) throw new Error('NOT_FOUND')
      return structuredClone(record)
    }
    findId(id: string) {
      const record = state.records.get(id)
      return record ? structuredClone(record) : null
    }
    save(record: ReportRecord) {
      const checked = ReportRecordSchema.parse(record)
      state.records.set(checked.id, structuredClone(checked))
      return checked
    }
  }
}))
let directory: string
let file: string
let task: AnalysisTask
const services: AnalysisReportService[] = []
const fakePdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(1200, 32)])
const rendered = () => ({
  pdf: fakePdf,
  pages: 2,
  bytes: fakePdf.length,
  sha256: reportHash(fakePdf)
})
const reference = () => ({
  kind: 'run' as const,
  id: task.runs[0].id,
  candidateHash: task.runs[0].answer.candidateHash
})
const input = (): ReportCreate => ({
  requestId: randomUUID(),
  answer: reference(),
  options: { title: '合成验收报告', format: 'a4', locale: 'zh-CN' }
})
function setup(renderer: ReportRenderer = { render: vi.fn(async () => rendered()) }) {
  const analysis = {
    get: (id: string) => {
      if (id !== task.id) throw new Error('NOT_FOUND')
      return structuredClone(task)
    }
  }
  const service = new AnalysisReportService(
    { getDatabase: () => ({}) } as never,
    analysis,
    path.join(directory, 'reports'),
    renderer
  )
  services.push(service)
  return { service, renderer }
}
async function finished(service: AnalysisReportService, id: string) {
  await vi.waitFor(
    () =>
      expect(service.list(task.id).find((record) => record.id === id)?.status).not.toBe(
        'rendering'
      ),
    { timeout: 3000 }
  )
  return service.list(task.id).find((record) => record.id === id)!
}
beforeEach(async () => {
  state.records.clear()
  directory = await mkdtemp(path.join(tmpdir(), 'semapath-reports-'))
  file = path.join(directory, 'synthetic.xlsx')
  await writeFile(file, createAnalysisWorkbook())
  const loaded = await loadWorkbook(file)
  const run = AnalysisRunSchema.parse(
    calculateWorkbook(loaded, loaded.source, {
      sourceId: loaded.source.id,
      sheet: '销售明细',
      headerRow: 1,
      operation: 'sum',
      measure: 'C',
      groupBy: 'B',
      filters: [],
      question: '按区域核对销售额',
      unit: '元',
      period: '2026-10'
    })
  )
  run.answer.candidateHash = candidateHash(run)
  run.answer.status = 'published'
  run.answer.publishedAt = new Date().toISOString()
  const now = new Date().toISOString()
  task = {
    version: 1,
    id: randomUUID(),
    title: '合成销售分析',
    createdAt: now,
    updatedAt: now,
    sources: [loaded.source],
    runs: [run],
    turns: []
  }
})
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir()))
    throw new Error('Unsafe fixture cleanup')
  await rm(directory, { recursive: true, force: true })
})

describe('Published-answer freezing and report rendering contract', () => {
  it('freezes Power BI model identity, exact result and DAX; rejects changed provenance', () => {
    const run = task.runs[0],
      dax = "EVALUATE 'Orders'"
    run.source.origin = {
      version: 'dataset/1',
      kind: 'powerbi',
      title: 'Power BI snapshot',
      createdAt: new Date().toISOString(),
      rows: 1,
      database: 'synthetic-model',
      query: dax,
      result: { columns: ['结果行号', 'Amount'], rows: [['1', '0.10000000000000000000']] },
      powerBi: {
        kind: 'local',
        transport: 'adomd',
        modelId: 'synthetic-model',
        modelName: '合成订单模型',
        workspaceId: null,
        querySha256: reportHash(dax),
        complete: true,
        precision: 'native_strings',
        local: {
          processId: 123,
          startedAt: '2026-10-28T00:00:00Z',
          port: 55555,
          identity: 'synthetic-identity'
        }
      }
    }
    run.answer.candidateHash = candidateHash(run)
    const snapshot = freezeReportAnswer(task, reference())
    expect(snapshot.runs[0].source.origin?.result?.rows[0][1]).toBe('0.10000000000000000000')
    const html = buildReportDocument(snapshot, { title: 'PBI报告', locale: 'zh-CN', format: 'a4' })
    expect(html).toContain('Power BI DAX')
    expect(html).toContain('合成订单模型')
    expect(html).toContain('DAX SHA-256')
    run.source.origin.query = 'EVALUATE ROW("Changed", 1)'
    run.answer.candidateHash = candidateHash(run)
    expect(() => freezeReportAnswer(task, reference())).toThrow('REPORT_INVALID_SNAPSHOT')
  })
  it('freezes historical results without rereading a removed source and excludes native paths', async () => {
    await unlink(file)
    task.sources = []
    const snapshot = freezeReportAnswer(task, reference())
    expect(snapshot.runs[0].values.map((value) => value.value)).toEqual(['0.3', '8'])
    expect(snapshot.runs[0].values[0].inputs.map((input) => input.cell)).toEqual(['C2', 'C3'])
    expect(JSON.stringify(snapshot)).not.toContain(file)
    expect(snapshot.answer.candidateHash).toBe(reference().candidateHash)
  })
  it('rejects drafts, a stale candidate hash and modified stored calculations', () => {
    task.runs[0].answer.status = 'draft'
    expect(() => freezeReportAnswer(task, reference())).toThrow('REPORT_NOT_PUBLISHED')
    task.runs[0].answer.status = 'published'
    expect(() =>
      freezeReportAnswer(task, { ...reference(), candidateHash: '0'.repeat(64) })
    ).toThrow('INVALID_DRAFT')
    task.runs[0].values[0].value = '9000'
    expect(() => freezeReportAnswer(task, reference())).toThrow('INVALID_DRAFT')
  })
  it('keeps every natural-answer view, exact share and input reference together', () => {
    const run = task.runs[0]
    const plan: NaturalReadyPlan = {
      status: 'ready',
      queries: [
        {
          key: 'q1',
          sourceId: run.source.id,
          sheet: run.plan.sheet,
          headerRow: 1,
          operation: 'sum',
          measure: 'C',
          groupBy: 'B',
          filters: []
        }
      ],
      views: [
        { kind: 'ranking', queryKey: 'q1', direction: 'descending', limit: 1, chart: 'bar' },
        { kind: 'share', queryKey: 'q1', chart: 'bar' }
      ]
    }
    const turn: NaturalTurn = {
      id: randomUUID(),
      createdAt: run.createdAt,
      question: '排名并计算占比',
      model: {
        providerId: 'synthetic',
        modelId: 'fixture',
        providerName: 'Synthetic',
        modelName: 'Fixture',
        isDefault: true
      },
      state: 'answered',
      message: '',
      plan,
      queryRuns: [{ key: 'q1', runId: run.id }],
      derived: buildNaturalDerived(plan, new Map([['q1', run]])),
      review: { version: 'natural/1', modelCalls: 2, confirmed: true },
      answer: { status: 'published', publishedAt: run.answer.publishedAt, candidateHash: '' }
    }
    turn.answer.candidateHash = naturalTurnHash(turn, task)
    task.turns.push(turn)
    const snapshot = freezeReportAnswer(task, {
      kind: 'turn',
      id: turn.id,
      candidateHash: turn.answer.candidateHash
    })
    const html = buildReportDocument(
      snapshot,
      input().options,
      reportHash(JSON.stringify(snapshot))
    )
    expect(snapshot.views).toHaveLength(2)
    expect(snapshot.derived[0].value).toBe('3.614457831325')
    expect(html).toContain('3.614457831325')
    expect(html).toContain('0.3 / (0.3 + 8) × 100')
    expect(html).toContain('href="#E1.1"')
    expect(reportExpectedTokens(snapshot)).toContain('[D1]')
  })
  it('escapes workbook/question HTML and emits only inline resources with a restrictive policy', () => {
    task.runs[0].plan.question =
      '<script>process.exit()</script><img src="https://example.invalid/private">'
    task.runs[0].values[0].category = '<svg onload="x()">'
    task.runs[0].answer.candidateHash = candidateHash(task.runs[0])
    const snapshot = freezeReportAnswer(task, reference())
    const html = buildReportDocument(
      snapshot,
      input().options,
      reportHash(JSON.stringify(snapshot))
    )
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img ')
    expect(html).toContain("connect-src 'none'")
    expect(html).not.toContain(file)
  })
  it('retains the last group and exact values when a chart needs multiple segments', () => {
    const snapshot = freezeReportAnswer(task, reference())
    snapshot.runs[0].values = Array.from({ length: 65 }, (_, index) => ({
      ...snapshot.runs[0].values[0],
      id: `value-${index}`,
      category: `中文区域-${index + 1}`,
      value: index === 64 ? '-2.05' : String(index + 1),
      exact: index === 64 ? '-2.05' : String(index + 1)
    }))
    const html = buildReportDocument(
      snapshot,
      input().options,
      reportHash(JSON.stringify(snapshot))
    )
    expect(html).toContain('中文区域-65')
    expect(html).toContain('[E1.65]')
    expect(html).toContain('-2.05')
    expect(html.match(/图表分段/g)).toHaveLength(6)
    expect(reportExpectedTokens(snapshot)).toContain('[E1.65]')
  })
  it('normalizes Windows-reserved output names without using titles as paths', () => {
    expect(reportFilename('CON ', '.pdf')).toBe('report-CON.pdf')
    expect(reportFilename('行\u0000标签', '.pdf')).toBe('行_标签.pdf')
    expect(reportFilename('销售/区域:报告?.', '-evidence.json')).toBe(
      '销售_区域_报告_-evidence.json'
    )
  })
})

describe('Report persistence, idempotency and recovery', () => {
  it('reuses a successful output for identical answer/options and exports the complete frozen evidence', async () => {
    const { service, renderer } = setup()
    const request = input()
    const created = await service.create(task.id, request, 7)
    expect((await finished(service, created.id)).status).toBe('ready')
    const again = await service.create(task.id, { ...request, requestId: randomUUID() }, 7)
    expect(again.id).toBe(created.id)
    expect((await service.create(task.id, request, 7)).id).toBe(created.id)
    expect(renderer.render).toHaveBeenCalledOnce()
    const frozen = await service.verifiedFile(task.id, created.id, 'evidence')
    expect(reportHash(frozen.bytes)).toBe(created.snapshotHash)
    expect(JSON.parse(frozen.bytes.toString()).runs[0].values[0].inputs).toHaveLength(2)
    expect((await service.verifiedFile(task.id, created.id, 'pdf')).bytes).toEqual(fakePdf)
  })
  it('regenerates the same frozen content after the original workbook disappears', async () => {
    const { service, renderer } = setup()
    const created = await service.create(task.id, input(), 1)
    await finished(service, created.id)
    const before = await service.verifiedFile(task.id, created.id, 'evidence')
    await unlink(file)
    task.sources = []
    service.retry(task.id, created.id, 1)
    const ready = await finished(service, created.id)
    expect(ready.status).toBe('ready')
    expect(ready.attempts).toHaveLength(2)
    expect(ready.snapshotHash).toBe(created.snapshotHash)
    expect((await service.verifiedFile(task.id, created.id, 'evidence')).bytes).toEqual(
      before.bytes
    )
    expect(renderer.render).toHaveBeenCalledTimes(2)
  })
  it('blocks an altered PDF and can repair it without rewriting frozen data', async () => {
    const { service } = setup()
    const created = await service.create(task.id, input(), 1)
    await finished(service, created.id)
    const original = await service.verifiedFile(task.id, created.id, 'pdf')
    await writeFile(original.path, 'synthetic damage')
    await expect(service.verifiedFile(task.id, created.id, 'pdf')).rejects.toThrow(
      'REPORT_FILE_CHANGED'
    )
    service.retry(task.id, created.id, 1)
    expect((await finished(service, created.id)).status).toBe('ready')
    expect((await service.verifiedFile(task.id, created.id, 'pdf')).path).not.toBe(original.path)
    expect(service.list(task.id)[0].snapshotHash).toBe(created.snapshotHash)
  })
  it('fails a retry when the frozen input was changed, rather than trusting current source data', async () => {
    const { service, renderer } = setup()
    const created = await service.create(task.id, input(), 1)
    await finished(service, created.id)
    await writeFile(path.join(directory, 'reports', task.id, created.id, 'evidence.json'), '{}')
    service.retry(task.id, created.id, 1)
    const failed = await finished(service, created.id)
    expect(failed.status).toBe('failed')
    expect(failed.attempts.at(-1)?.error).toBe('REPORT_FILE_CHANGED')
    expect(renderer.render).toHaveBeenCalledOnce()
    await expect(service.verifiedFile(task.id, created.id, 'pdf')).rejects.toThrow(
      'REPORT_RENDER_FAILED'
    )
  })
  it('cancels only the owner and retries without preserving a partial PDF as ready', async () => {
    const renderer = {
      render: vi.fn<ReportRenderer['render']>().mockImplementation(
        (input) =>
          new Promise((_resolve, reject) =>
            input.signal.addEventListener('abort', () => reject(input.signal.reason), {
              once: true
            })
          )
      )
    }
    const { service } = setup(renderer)
    const created = await service.create(task.id, input(), 7)
    await vi.waitFor(() => expect(renderer.render).toHaveBeenCalledOnce())
    expect(service.cancel(task.id, created.id, 8)).toBe(false)
    expect(service.cancel(task.id, created.id, 7)).toBe(true)
    expect((await finished(service, created.id)).status).toBe('cancelled')
    await expect(service.verifiedFile(task.id, created.id, 'pdf')).rejects.toThrow(
      'REPORT_RENDER_FAILED'
    )
    renderer.render.mockResolvedValueOnce(rendered())
    service.retry(task.id, created.id, 7)
    const ready = await finished(service, created.id)
    expect(ready.status).toBe('ready')
    expect(ready.attempts[0].status).toBe('cancelled')
  })
  it('marks an interrupted persisted attempt on startup and resumes its original snapshot', async () => {
    const { service } = setup()
    const created = await service.create(task.id, input(), 1)
    await finished(service, created.id)
    await service.dispose()
    const persisted = state.records.get(created.id)!
    persisted.status = 'rendering'
    persisted.attempts.at(-1)!.status = 'rendering'
    persisted.attempts.at(-1)!.finishedAt = null
    const recovered = setup().service
    expect(recovered.list(task.id)[0].status).toBe('interrupted')
    expect(recovered.list(task.id)[0].attempts.at(-1)?.error).toBe('REPORT_INTERRUPTED')
    recovered.retry(task.id, created.id, 1)
    const ready = await finished(recovered, created.id)
    expect(ready.status).toBe('ready')
    expect(ready.snapshotHash).toBe(created.snapshotHash)
  })
  it('bounds concurrent generation and returns capacity after cancellation', async () => {
    const renderer = {
      render: vi.fn<ReportRenderer['render']>().mockImplementation(
        (input) =>
          new Promise((_resolve, reject) =>
            input.signal.addEventListener('abort', () => reject(input.signal.reason), {
              once: true
            })
          )
      )
    }
    const { service } = setup(renderer)
    const one = await service.create(task.id, input(), 1)
    const second = input()
    second.options.title = 'Second frozen report'
    const two = await service.create(task.id, second, 1)
    await vi.waitFor(() => expect(renderer.render).toHaveBeenCalledTimes(2))
    const third = input()
    third.options.title = 'Third frozen report'
    await expect(service.create(task.id, third, 1)).rejects.toThrow('BUSY')
    service.cancel(task.id, one.id, 1)
    service.cancel(task.id, two.id, 1)
    await finished(service, one.id)
    await finished(service, two.id)
    renderer.render.mockResolvedValueOnce(rendered())
    expect((await finished(service, (await service.create(task.id, third, 1)).id)).status).toBe(
      'ready'
    )
  })
  it('prevents another task from reading or cancelling a report', async () => {
    const { service } = setup()
    const created = await service.create(task.id, input(), 1)
    await finished(service, created.id)
    const foreign = randomUUID()
    await expect(service.verifiedFile(foreign, created.id, 'pdf')).rejects.toThrow('NOT_FOUND')
    expect(() => service.cancel(foreign, created.id, 1)).toThrow('NOT_FOUND')
    expect(service.list(task.id)).toHaveLength(1)
  })
})
