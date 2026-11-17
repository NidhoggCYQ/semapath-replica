import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AnalysisRunSchema,
  AnalysisTaskSchema,
  NaturalDecisionSchema,
  type AnalysisModel,
  type AnalysisRun,
  type AnalysisTask,
  type NaturalAsk,
  type NaturalReadyPlan
} from '@shared/analysis'
import { compareAnalysisValues } from '@shared/analysisDecimal'
import { NaturalAnalyzer, parseNaturalJson, validateNaturalPlan } from '@/analysis/naturalAnalyzer'
import { buildNaturalDerived } from '@/analysis/naturalFacts'
import { candidateHash, naturalTurnHash } from '@/analysis/service'
import { describeWorkbook, loadWorkbook } from '@/analysis/workbook'
import { createAnalysisWorkbook } from '../../fixtures/analysisWorkbook'

// Exercise the real parser/calculator here; Electron worker transport is covered by desktop E2E.
vi.mock('@/analysis/workerClient', async () => {
  const actual = await vi.importActual<typeof import('@/analysis/workbook')>('@/analysis/workbook')
  return {
    describeSource: async (source: AnalysisTask['sources'][number]) =>
      actual.describeWorkbook(await actual.loadWorkbook(source.path, source.id), source),
    calculateSource: async (source: AnalysisTask['sources'][number], plan: AnalysisRun['plan']) =>
      AnalysisRunSchema.parse(
        actual.calculateWorkbook(await actual.loadWorkbook(source.path, source.id), source, plan)
      )
  }
})

const model: AnalysisModel = {
  providerId: 'fixture',
  modelId: 'fixture-chat',
  providerName: 'Synthetic fixture',
  modelName: 'Fixture',
  isDefault: true
}
let directory: string
let file: string
let task: AnalysisTask
const ask = (question = '按区域汇总销售额并排名、计算占比'): NaturalAsk => ({
  requestId: randomUUID(),
  question,
  providerId: model.providerId,
  modelId: model.modelId
})
function plan(): NaturalReadyPlan {
  return {
    status: 'ready',
    queries: [
      {
        key: 'q1',
        sourceId: task.sources[0].id,
        sheet: '销售明细',
        headerRow: 1,
        operation: 'sum',
        measure: 'C',
        groupBy: 'B',
        filters: []
      }
    ],
    views: [
      { kind: 'summary', queryKey: 'q1', chart: 'bar' },
      { kind: 'ranking', queryKey: 'q1', chart: 'bar', direction: 'descending', limit: 1 },
      { kind: 'share', queryKey: 'q1', chart: 'bar' }
    ]
  }
}
function gateway(responses: unknown[]) {
  const generate =
    vi.fn<(_model: AnalysisModel, prompt: string, signal: AbortSignal) => Promise<string>>()
  for (const response of responses)
    generate.mockResolvedValueOnce(
      typeof response === 'string' ? response : JSON.stringify(response)
    )
  return { models: vi.fn(async () => [model]), generate }
}
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'semapath-natural-'))
  file = path.join(directory, 'synthetic.xlsx')
  await writeFile(file, createAnalysisWorkbook())
  const loaded = await loadWorkbook(file)
  const now = new Date().toISOString()
  task = {
    version: 1,
    id: randomUUID(),
    title: 'Synthetic',
    createdAt: now,
    updatedAt: now,
    sources: [loaded.source],
    runs: [],
    turns: []
  }
})
afterEach(async () => {
  vi.useRealTimers()
  await rm(directory, { recursive: true, force: true })
})

describe('Natural-language planning and evidence contract', () => {
  it('executes full-file facts and shares locally; prompts contain no file path, secret or invented numeric prose', async () => {
    const transport = gateway([plan(), { decision: 'confirm' }])
    const result = await new NaturalAnalyzer(transport).analyze(task, ask(), 7)
    expect(result.runs).toHaveLength(1)
    expect(result.runs[0].values.map((value) => value.value)).toEqual(['0.3', '8'])
    expect(result.turn).toMatchObject({
      state: 'answered',
      message: '',
      review: { confirmed: true, modelCalls: 2 }
    })
    expect(result.turn.derived.map((fact) => fact.value)).toEqual([
      '3.614457831325',
      '96.385542168675'
    ])
    expect(result.turn.derived[0].inputs.map((input) => input.valueId)).toEqual(
      result.runs[0].values.map((value) => value.id)
    )
    expect(result.runs[0].values[0].inputs.map((input) => input.cell)).toEqual(['C2', 'C3'])
    expect(transport.generate.mock.calls[0][1]).not.toContain(file)
    expect(transport.generate.mock.calls[1][1]).toContain(result.runs[0].evidenceId)
  })
  it('repairs one malformed JSON response, but never executes arbitrary fields or code', async () => {
    const transport = gateway([
      'not json',
      `\`\`\`json\n${JSON.stringify(plan())}\n\`\`\``,
      { decision: 'confirm' }
    ])
    const result = await new NaturalAnalyzer(transport).analyze(task, ask(), 1)
    expect(result.turn.review.modelCalls).toBe(3)
    expect(() =>
      parseNaturalJson(JSON.stringify({ ...plan(), code: 'process.exit()' }), NaturalDecisionSchema)
    ).toThrow('INVALID_ANALYSIS_PLAN')
    const invalid = plan()
    invalid.queries[0].filters = [
      { column: 'B', operator: 'eq', value: '华东', sql: 'ignored?' } as never
    ]
    expect(() => parseNaturalJson(JSON.stringify(invalid), NaturalDecisionSchema)).toThrow(
      'INVALID_ANALYSIS_PLAN'
    )
  })
  it.each([
    'unknown-source',
    'unknown-column',
    'unknown-view',
    'duplicate-query',
    'invalid-date',
    'numeric-in',
    'count-measure'
  ])('rejects invalid plan: %s', async (kind) => {
    const invalid = plan()
    if (kind === 'unknown-source') invalid.queries[0].sourceId = 'not-bound'
    if (kind === 'unknown-column') invalid.queries[0].measure = 'ZZ'
    if (kind === 'unknown-view') invalid.views[0].queryKey = 'q6'
    if (kind === 'duplicate-query') invalid.queries.push({ ...invalid.queries[0] })
    if (kind === 'invalid-date')
      invalid.queries[0].filters = [
        { column: 'A', operator: 'gte', kind: 'date', value: '2026-02-30' }
      ]
    if (kind === 'numeric-in')
      invalid.queries[0].filters = [
        { column: 'C', operator: 'in', kind: 'number', values: ['1'], value: '' }
      ]
    if (kind === 'count-measure') invalid.queries[0].operation = 'count'
    const loaded = await loadWorkbook(file, task.sources[0].id)
    expect(() => validateNaturalPlan(invalid, [describeWorkbook(loaded, task.sources[0])])).toThrow(
      'INVALID_ANALYSIS_PLAN'
    )
  })
  it('keeps a clarification without a numeric run, and carries it into the next question and review', async () => {
    const transport = gateway([
      { status: 'clarify', message: '请说明要分析哪个金额字段？' },
      plan(),
      { decision: 'confirm' }
    ])
    const analyzer = new NaturalAnalyzer(transport)
    const first = await analyzer.analyze(task, ask('按区域分析金额'), 1)
    expect(first.runs).toEqual([])
    expect(first.turn.plan).toBeNull()
    task.turns.push(first.turn)
    await analyzer.analyze(task, ask('销售额'), 1)
    expect(transport.generate.mock.calls[1][1]).toContain('按区域分析金额')
    expect(transport.generate.mock.calls[2][1]).toContain('按区域分析金额')
  })
  it('discards unapproved calculations when the reviewer asks for clarification', async () => {
    const result = await new NaturalAnalyzer(
      gateway([plan(), { decision: 'clarify', message: '需要销售额还是数量？' }])
    ).analyze(task, ask(), 1)
    expect(result.runs).toEqual([])
    expect(result.turn).toMatchObject({
      state: 'clarify',
      derived: [],
      queryRuns: [],
      review: { confirmed: false }
    })
  })
  it('recalculates a revised plan and saves only its confirmed evidence', async () => {
    const revised = plan()
    revised.queries[0].filters = [{ column: 'B', operator: 'eq', kind: 'text', value: '华东' }]
    revised.views = [{ kind: 'summary', queryKey: 'q1', chart: 'bar' }]
    const result = await new NaturalAnalyzer(
      gateway([plan(), { decision: 'revise', plan: revised }, { decision: 'confirm' }])
    ).analyze(task, ask(), 1)
    expect(result.runs).toHaveLength(1)
    expect(result.runs[0].values.map((value) => value.category)).toEqual(['华东'])
    expect(result.turn.review.modelCalls).toBe(3)
    expect(result.turn.queryRuns[0].runId).toBe(result.runs[0].id)
  })
  it('fails rather than committing an unreviewed second revision', async () => {
    const transport = gateway([
      plan(),
      { decision: 'revise', plan: plan() },
      { decision: 'revise', plan: plan() }
    ])
    await expect(new NaturalAnalyzer(transport).analyze(task, ask(), 1)).rejects.toThrow(
      'INVALID_ANALYSIS_PLAN'
    )
    expect(task.runs).toHaveLength(0)
  })
  it('requires an enabled model and propagates provider failures without fabricating an answer', async () => {
    await expect(
      new NaturalAnalyzer({ models: async () => [], generate: vi.fn() }).analyze(task, ask(), 1)
    ).rejects.toThrow('MODEL_NOT_CONFIGURED')
    const transport = gateway([])
    transport.generate.mockRejectedValue(new Error('synthetic transport failure'))
    const analyzer = new NaturalAnalyzer(transport)
    await expect(analyzer.analyze(task, ask(), 1)).rejects.toThrow('MODEL_FAILED')
    expect(analyzer.status(task.id)).toBeNull()
  })
  it('rejects a source changed during model review and leaves task history untouched', async () => {
    const transport = gateway([plan()])
    transport.generate
      .mockReset()
      .mockResolvedValueOnce(JSON.stringify(plan()))
      .mockImplementationOnce(async () => {
        await writeFile(file, Buffer.from('changed after calculation'))
        return JSON.stringify({ decision: 'confirm' })
      })
    await expect(new NaturalAnalyzer(transport).analyze(task, ask(), 1)).rejects.toThrow(
      'SOURCE_CHANGED'
    )
    expect(task.runs).toEqual([])
    expect(task.turns).toEqual([])
  })
  it('cancels only the matching caller/request; a cancelled job can be asked again', async () => {
    const transport = gateway([])
    transport.generate.mockImplementation(
      (_model, _prompt, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        )
    )
    const analyzer = new NaturalAnalyzer(transport)
    const input = ask()
    const result = analyzer.analyze(task, input, 7)
    const assertion = expect(result).rejects.toThrow('ANALYSIS_CANCELLED')
    await vi.waitFor(() => expect(analyzer.status(task.id)?.stage).toBe('planning'))
    expect(analyzer.cancel(task.id, input.requestId, 8)).toBe(false)
    expect(analyzer.cancel(task.id, randomUUID(), 7)).toBe(false)
    expect(analyzer.cancel(task.id, input.requestId, 7)).toBe(true)
    await assertion
    expect(analyzer.status(task.id)).toBeNull()
    transport.generate
      .mockReset()
      .mockResolvedValueOnce(JSON.stringify(plan()))
      .mockResolvedValueOnce(JSON.stringify({ decision: 'confirm' }))
    expect((await analyzer.analyze(task, ask(), 7)).turn.state).toBe('answered')
  })
  it('times out model requests and clears progress without leaving a half answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const transport = gateway([])
    transport.generate.mockImplementation(
      (_model, _prompt, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        )
    )
    const analyzer = new NaturalAnalyzer(transport)
    const result = analyzer.analyze(task, ask(), 1)
    const assertion = expect(result).rejects.toThrow('MODEL_TIMEOUT')
    await vi.waitFor(() => expect(analyzer.status(task.id)?.stage).toBe('planning'))
    await vi.advanceTimersByTimeAsync(180000)
    await assertion
    expect(analyzer.status(task.id)).toBeNull()
    expect(task.turns).toEqual([])
  })
  it('keeps historical hashes compatible and binds a whole answer to every referenced run', async () => {
    const result = await new NaturalAnalyzer(gateway([plan(), { decision: 'confirm' }])).analyze(
      task,
      ask(),
      1
    )
    const run = result.runs[0]
    run.answer.candidateHash = candidateHash(run)
    task.runs.push(run)
    const { turns: _turns, ...oldTask } = task
    const restored = AnalysisTaskSchema.parse(JSON.parse(JSON.stringify(oldTask)))
    expect(restored.turns).toEqual([])
    expect(candidateHash(restored.runs[0])).toBe(run.answer.candidateHash)
    const hash = naturalTurnHash(result.turn, task)
    run.answer.status = 'published'
    expect(naturalTurnHash(result.turn, task)).toBe(hash)
    result.turn.derived[0].value = 'invented'
    expect(naturalTurnHash(result.turn, task)).not.toBe(hash)
  })
})

describe('Exact derived calculations', () => {
  it('compares exact rational means rather than rounded displayed means', () => {
    expect(
      compareAnalysisValues(
        { numerator: '1', denominator: 3 },
        { numerator: '0.9999999999999', denominator: 3 }
      )
    ).toBe(1)
    const basePlan = plan()
    basePlan.queries.push({ ...basePlan.queries[0], key: 'q2' })
    basePlan.views = [
      { kind: 'comparison', queryKey: 'q1', baselineQueryKey: 'q2', chart: 'table' }
    ]
    const makeRun = (id: string, denominator: number): AnalysisRun =>
      ({
        id,
        source: task.sources[0],
        plan: { ...basePlan.queries[0], operation: 'average', question: '', unit: '', period: '' },
        values: [
          {
            id: `${id}:0`,
            category: '华东',
            value: denominator === 3 ? '0.333333333333' : '0.166666666667',
            exact: `1 / ${denominator}`,
            numerator: '1',
            denominator,
            included: denominator,
            blank: 0,
            inputs: []
          }
        ]
      }) as AnalysisRun
    const facts = buildNaturalDerived(
      basePlan,
      new Map([
        ['q1', makeRun('current', 3)],
        ['q2', makeRun('baseline', 6)]
      ])
    )
    expect(facts.map((fact) => fact.value)).toEqual(['0.166666666667', '100'])
    expect(facts[0].exact).toBe('3 / 18')
    expect(facts[0].inputs.map((input) => input.runId)).toEqual(['current', 'baseline'])
    const baseline = makeRun('zero', 6)
    baseline.values[0] = { ...baseline.values[0], numerator: '0', exact: '0', value: '0' }
    const zero = buildNaturalDerived(
      basePlan,
      new Map([
        ['q1', makeRun('current', 3)],
        ['q2', baseline]
      ])
    )
    expect(zero[1]).toMatchObject({ value: null, reason: 'ZERO_DENOMINATOR', denominator: '0' })
  })
})
