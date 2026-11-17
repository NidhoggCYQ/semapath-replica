import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import {
  AnalysisPlanSchema,
  AnalysisRunSchema,
  AnalysisTaskSchema,
  NaturalDecisionSchema,
  type AnalysisTask,
  type AnalysisModel,
  type NaturalReadyPlan,
  type NaturalTurn,
  type NaturalAsk
} from '@shared/analysis'
import { NaturalAnalyzer } from '@/analysis/naturalAnalyzer'
import { FrameDecisionSchema } from '@shared/analysisFramework'
import {
  buildAnalysisFrame,
  resolveAnalysisContext,
  applyAnalysisScope,
  analysisAncestors
} from '@/analysis/framework'
import { candidateHash, naturalTurnHash } from '@/analysis/integrity'
import { freezeReportAnswer, validateReportSnapshot } from '@/analysis/reports/snapshot'
import { buildReportDocument } from '@/analysis/reports/document'
import { loadWorkbook, calculateWorkbook, type LoadedWorkbook } from '@/analysis/workbook'
import { createAnalysisWorkbook } from '../../fixtures/analysisWorkbook'

vi.mock('@/analysis/workerClient', async () => {
  const actual = await vi.importActual<typeof import('@/analysis/workbook')>('@/analysis/workbook')
  return {
    describeSource: async (source: AnalysisTask['sources'][number]) =>
      actual.describeWorkbook(await actual.loadWorkbook(source.path, source.id), source),
    calculateSource: async (
      source: AnalysisTask['sources'][number],
      plan: AnalysisTask['runs'][number]['plan']
    ) =>
      AnalysisRunSchema.parse(
        actual.calculateWorkbook(await actual.loadWorkbook(source.path, source.id), source, plan)
      )
  }
})
const model: AnalysisModel = {
  providerId: 'fixture',
  modelId: 'frame',
  providerName: 'Synthetic',
  modelName: 'Frame fixture',
  isDefault: true
}
let directory: string
let loaded: LoadedWorkbook
let task: AnalysisTask
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'semapath-frame-'))
  const file = path.join(directory, 'synthetic.xlsx')
  await writeFile(file, createAnalysisWorkbook())
  loaded = await loadWorkbook(file)
  const now = new Date().toISOString()
  task = {
    version: 1,
    id: randomUUID(),
    title: 'Synthetic frame',
    createdAt: now,
    updatedAt: now,
    sources: [loaded.source],
    runs: [],
    turns: []
  }
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})
function plan(overrides: Partial<NaturalReadyPlan['queries'][number]> = {}): NaturalReadyPlan {
  return {
    status: 'ready',
    queries: [
      {
        key: 'q1',
        sourceId: loaded.source.id,
        sheet: '销售明细',
        headerRow: 1,
        operation: 'sum',
        measure: 'C',
        groupBy: 'B',
        filters: [{ column: 'B', operator: 'eq', kind: 'text', value: '华东' }],
        ...overrides
      }
    ],
    views: [{ kind: 'summary', queryKey: 'q1', chart: 'bar' }],
    frame: {
      objective: '核对华东销售并研究后续数据缺口',
      workflowRefs: ['data-quality', 'claim-validation'],
      questions: [
        { key: 'h1', kind: 'question', text: '华东销售读数是否有实际依据', queryKeys: ['q1'] },
        { key: 'h2', kind: 'hypothesis', text: '营销投入可能影响销售', queryKeys: [] }
      ]
    }
  }
}
function transport(nextPlan: NaturalReadyPlan, withDecision = true) {
  const generate = vi.fn(async (_model: AnalysisModel, prompt: string) => {
    if (!prompt.includes('EXECUTED_EVIDENCE_DATA\n')) return JSON.stringify(nextPlan)
    const evidence = JSON.parse(prompt.split('EXECUTED_EVIDENCE_DATA\n')[1])
    return JSON.stringify({
      decision: 'confirm',
      ...(withDecision
        ? {
            decisions: [
              {
                questionKey: 'h1',
                judgment: 'supported',
                next: 'stop',
                reason: '读数由当前范围内的原始单元格计算。',
                evidence: [{ queryKey: 'q1', valueId: evidence[0].values[0].id }]
              }
            ]
          }
        : {})
    })
  })
  return { models: async () => [model], generate }
}
function input(
  parent?: NaturalTurn,
  scope?: NonNullable<NaturalAsk['continuation']>['scope']
): NaturalAsk {
  return {
    requestId: randomUUID(),
    question: '继续核对当前分支',
    providerId: model.providerId,
    modelId: model.modelId,
    ...(parent
      ? {
          continuation: {
            parentTurnId: parent.id,
            parentCandidateHash: parent.answer.candidateHash,
            ...(scope ? { scope } : {})
          }
        }
      : { newRoot: true })
  }
}
async function execute(nextPlan = plan(), ask = input(), decisions = true) {
  const gateway = transport(nextPlan, decisions)
  const result = await new NaturalAnalyzer(gateway).analyze(task, ask, 1)
  result.runs.forEach((run) => {
    run.answer.candidateHash = candidateHash(run)
  })
  task.runs.push(...result.runs)
  result.turn.answer.candidateHash = naturalTurnHash(result.turn, task)
  task.turns.push(result.turn)
  return { ...result, gateway }
}
function publish(turn: NaturalTurn) {
  turn.answer.status = 'published'
  turn.answer.publishedAt = new Date().toISOString()
  turn.queryRuns.forEach((reference) => {
    const run = task.runs.find((run) => run.id === reference.runId)!
    run.answer.status = 'published'
    run.answer.publishedAt = turn.answer.publishedAt
  })
}
describe('Saved analysis framework and bounded recursive drill-down', () => {
  it('keeps a multi-query review with saved framework history inside a 16K model budget', async () => {
    let parent = (await execute()).turn
    parent = (await execute(plan(), input(parent))).turn
    parent = (await execute(plan(), input(parent))).turn
    const comparison = plan()
    comparison.queries.push({
      ...comparison.queries[0],
      key: 'q2',
      filters: [
        ...comparison.queries[0].filters,
        { column: 'A', operator: 'lt', kind: 'date', value: '2026-10-02' }
      ]
    })
    comparison.views = [
      { kind: 'comparison', queryKey: 'q1', baselineQueryKey: 'q2', chart: 'bar' }
    ]
    comparison.frame!.questions[0].queryKeys = ['q1', 'q2']
    const current = await execute(comparison, input(parent))
    const following = await execute(plan(), input(current.turn))
    for (const [, prompt] of [
      ...current.gateway.generate.mock.calls,
      ...following.gateway.generate.mock.calls
    ])
      expect(Math.ceil(Buffer.byteLength(prompt, 'utf8') / 2) + 4000).toBeLessThanOrEqual(16000)
  })
  it('does not read unrelated task workbooks during a pinned-source drill-down', async () => {
    const root = await execute()
    task.sources.push({
      ...loaded.source,
      id: randomUUID(),
      name: 'UNRELATED_SOURCE_SENTINEL.xlsx',
      path: path.join(directory, 'missing-unrelated.xlsx')
    })
    const child = await execute(plan(), input(root.turn, { queryKey: 'q1' }))
    expect(child.runs[0].values[0].value).toBe('0.3')
    expect(
      child.gateway.generate.mock.calls.every(
        ([, prompt]) => !prompt.includes('UNRELATED_SOURCE_SENTINEL')
      )
    ).toBe(true)
  })
  it('keeps result numbers in evidence references rather than free-form decision reasons', () => {
    expect(
      FrameDecisionSchema.safeParse({
        questionKey: 'h1',
        judgment: 'supported',
        next: 'stop',
        reason: '增长了 50%',
        evidence: [{ queryKey: 'q1', valueId: 'actual-value' }]
      }).success
    ).toBe(false)
    expect(
      FrameDecisionSchema.safeParse({
        questionKey: 'h1',
        judgment: 'unverified',
        next: 'needs_data',
        reason: '增长了５０％',
        evidence: []
      }).success
    ).toBe(false)
  })
  it('retains a child query additional filter on the next implicit continuation', async () => {
    const root = await execute()
    const child = await execute(
      plan({ filters: [{ column: 'A', operator: 'eq', kind: 'date', value: '2026-10-01' }] }),
      input(root.turn, { queryKey: 'q1', valueId: root.runs[0].values[0].id })
    )
    const next = await execute(
      plan({ operation: 'count', measure: '', groupBy: '', filters: [] }),
      input(child.turn)
    )
    expect(next.runs[0].values[0].value).toBe('1')
    expect(next.runs[0].plan.filters.some((filter) => filter.column === 'A')).toBe(true)
  })
  it('records stable questions, real decision evidence and unresolved hypotheses across JSON persistence', async () => {
    const { turn, runs } = await execute()
    expect(turn.framework?.questions).toHaveLength(2)
    expect(turn.framework?.questions[0]).toMatchObject({
      judgment: 'supported',
      next: 'stop',
      evidence: [{ runId: runs[0].id, valueId: runs[0].values[0].id }]
    })
    expect(turn.framework?.questions[1]).toMatchObject({
      judgment: 'unverified',
      next: 'needs_data',
      evidence: []
    })
    const saved = AnalysisTaskSchema.parse(JSON.parse(JSON.stringify(task)))
    expect(saved.turns[0].framework).toEqual(turn.framework)
    expect(naturalTurnHash(saved.turns[0], saved)).toBe(turn.answer.candidateHash)
  })
  it('does not equate a confirmed calculation with a verified business hypothesis', async () => {
    const { turn } = await execute(plan(), input(), false)
    expect(turn.framework?.questions.every((q) => q.judgment === 'unverified')).toBe(true)
  })
  it('rejects a model-supplied row selection and unknown frame query references', () => {
    const candidate = plan()
    expect(
      NaturalDecisionSchema.safeParse({
        ...candidate,
        queries: [
          { ...candidate.queries[0], rowScope: { sourceSha256: loaded.source.sha256, rows: [2] } }
        ]
      }).success
    ).toBe(false)
    candidate.frame!.questions[0].queryKeys = ['q6']
    expect(() => buildAnalysisFrame('x', candidate, new Map())).toThrow('INVALID_ANALYSIS_PLAN')
  })
  it('rejects supported/refuted decisions without real evidence or evidence from another question', async () => {
    const { runs } = await execute()
    const computed = new Map([['q1', runs[0]]])
    expect(() =>
      buildAnalysisFrame('x', plan(), computed, [
        { questionKey: 'h1', judgment: 'refuted', next: 'stop', reason: 'x', evidence: [] }
      ])
    ).toThrow('INVALID_ANALYSIS_PLAN')
    expect(() =>
      buildAnalysisFrame('x', plan(), computed, [
        {
          questionKey: 'h2',
          judgment: 'supported',
          next: 'stop',
          reason: 'x',
          evidence: [{ queryKey: 'q1', valueId: runs[0].values[0].id }]
        }
      ])
    ).toThrow('INVALID_ANALYSIS_PLAN')
    expect(() =>
      buildAnalysisFrame('x', plan(), computed, [
        {
          questionKey: 'h1',
          judgment: 'supported',
          next: 'stop',
          reason: 'x',
          evidence: [{ queryKey: 'q1', valueId: 'fabricated' }]
        }
      ])
    ).toThrow('INVALID_ANALYSIS_PLAN')
  })
  it('inherits the whole parent query, including blank measure records, even if the model omits filters', async () => {
    const root = await execute()
    const child = await execute(
      plan({ operation: 'count', measure: '', groupBy: '', filters: [] }),
      input(root.turn, { queryKey: 'q1' })
    )
    expect(child.runs[0].matchedRows).toBe(3)
    expect(child.runs[0].values[0].value).toBe('3')
    expect(child.runs[0].plan.filters).toEqual(root.runs[0].plan.filters)
  })
  it('drills into exact contributing input rows without adding blank or outside-category records', async () => {
    const root = await execute()
    expect(root.runs[0].values[0].value).toBe('0.3')
    const child = await execute(
      plan({ operation: 'count', measure: '', groupBy: '', filters: [] }),
      input(root.turn, { queryKey: 'q1', valueId: root.runs[0].values[0].id })
    )
    expect(child.runs[0].values[0].value).toBe('2')
    expect(child.runs[0].plan.rowScope?.rows).toEqual([2, 3])
    expect(child.turn.context?.scope?.selected?.value).toBe('0.3')
    expect(
      child.gateway.generate.mock.calls.every(([, prompt]) => !prompt.includes(loaded.source.path))
    ).toBe(true)
  })
  it('retains the bound row scope through another level and keeps parent hashes unchanged', async () => {
    const root = await execute()
    const hash = root.turn.answer.candidateHash
    const child = await execute(
      plan({ filters: [] }),
      input(root.turn, { queryKey: 'q1', valueId: root.runs[0].values[0].id })
    )
    const grandchild = await execute(
      plan({ operation: 'count', measure: '', groupBy: '', filters: [] }),
      input(child.turn)
    )
    expect(grandchild.runs[0].values[0].value).toBe('2')
    expect(grandchild.turn.context?.depth).toBe(2)
    expect(analysisAncestors(task, grandchild.turn).map((turn) => turn.id)).toEqual([
      root.turn.id,
      child.turn.id
    ])
    expect(naturalTurnHash(root.turn, task)).toBe(hash)
    const persisted = AnalysisTaskSchema.parse(JSON.parse(JSON.stringify(task)))
    expect(naturalTurnHash(persisted.turns.at(-1)!, persisted)).toBe(
      grandchild.turn.answer.candidateHash
    )
  })
  it('uses only the selected ancestor history, while a new root has no sibling history', async () => {
    const root = await execute()
    const siblingAsk = { ...input(), question: 'SIBLING_ONLY_SENTINEL' }
    await execute(plan(), siblingAsk)
    const child = await execute(plan(), input(root.turn))
    expect(
      child.gateway.generate.mock.calls.every(
        ([, prompt]) => !prompt.includes('SIBLING_ONLY_SENTINEL')
      )
    ).toBe(true)
    const fresh = await execute(plan(), input())
    expect(fresh.gateway.generate.mock.calls[0][1].split('HISTORY_DATA\n')[1].split('\n')[0]).toBe(
      '[]'
    )
  })
  it('rejects tampered parent content, unknown questions, stale sources and empty input selections before model calls', async () => {
    const root = await execute()
    const ask = input(root.turn, { queryKey: 'q1' })
    expect(() =>
      resolveAnalysisContext(task, {
        ...ask,
        continuation: { ...ask.continuation!, questionId: randomUUID() }
      })
    ).toThrow('INVALID_ANALYSIS_CONTEXT')
    task.sources[0] = { ...task.sources[0], sha256: '0'.repeat(64) }
    expect(() => resolveAnalysisContext(task, ask)).toThrow('SOURCE_CHANGED')
    task.sources[0] = loaded.source
    root.turn.question = 'tampered'
    expect(() => resolveAnalysisContext(task, ask)).toThrow('INVALID_ANALYSIS_CONTEXT')
  })
  it('rejects attempts to switch worksheet, header or source inside a fixed branch', async () => {
    const root = await execute()
    const context = resolveAnalysisContext(task, input(root.turn, { queryKey: 'q1' }))
    for (const patch of [{ sheet: '分页检查' }, { headerRow: 2 }, { sourceId: randomUUID() }])
      expect(() => applyAnalysisScope(plan(patch), context)).toThrow('INVALID_ANALYSIS_CONTEXT')
  })
  it('applies row scope to method execution and rejects a mismatched SHA or duplicate row IDs', () => {
    const runPlan = AnalysisPlanSchema.parse({
      ...plan().queries[0],
      rowScope: { sourceSha256: loaded.source.sha256, rows: [2, 3] },
      study: { method: 'stratification-analysis', chart: 'boxplot' }
    })
    const run = calculateWorkbook(loaded, loaded.source, runPlan)
    expect(run.matchedRows).toBe(2)
    expect(run.values.flatMap((v) => v.inputs).every((input) => [2, 3].includes(input.row))).toBe(
      true
    )
    expect(() =>
      calculateWorkbook(loaded, loaded.source, {
        ...runPlan,
        rowScope: { sourceSha256: '0'.repeat(64), rows: [2] }
      })
    ).toThrow('INVALID_ANALYSIS_CONTEXT')
    expect(() =>
      calculateWorkbook(loaded, loaded.source, {
        ...runPlan,
        rowScope: { sourceSha256: loaded.source.sha256, rows: [2, 2] }
      })
    ).toThrow('INVALID_ANALYSIS_CONTEXT')
  })
  it('enforces twelve levels from the actual parent chain rather than trusting saved depth', async () => {
    const root = await execute()
    let parent = root.turn
    for (let depth = 1; depth <= 12; depth++) {
      const context = resolveAnalysisContext(task, input(parent))!
      const child = { ...structuredClone(root.turn), id: randomUUID(), context }
      child.answer.candidateHash = naturalTurnHash(child, task)
      task.turns.push(child)
      parent = child
    }
    expect(() => resolveAnalysisContext(task, input(parent))).toThrow('ANALYSIS_DEPTH_LIMIT')
  })
  it('freezes framework, ancestor path and bound input rows into the current published report', async () => {
    const root = await execute()
    const child = await execute(
      plan({ operation: 'count', measure: '', groupBy: '', filters: [] }),
      input(root.turn, { queryKey: 'q1', valueId: root.runs[0].values[0].id })
    )
    publish(child.turn)
    const snapshot = freezeReportAnswer(task, {
      kind: 'turn',
      id: child.turn.id,
      candidateHash: child.turn.answer.candidateHash
    })
    expect(snapshot.lineage?.[0]).toMatchObject({ id: root.turn.id, status: 'draft' })
    expect(snapshot.context?.scope?.plan.rowScope?.rows).toEqual([2, 3])
    expect(snapshot.framework).toEqual(child.turn.framework)
    const html = buildReportDocument(
      snapshot,
      { format: 'a4', locale: 'zh-CN', title: 'Synthetic frame' },
      'hash'
    )
    expect(html).toContain('业务分析框架')
    expect(html).toContain('分析路径')
    expect(html).toContain('继承的输入记录范围')
    expect(html).toContain('href="#E1.1"')
    expect(JSON.stringify(snapshot)).not.toContain(loaded.source.path)
    snapshot.framework!.questions[0].evidence[0].valueId = 'missing'
    expect(() => validateReportSnapshot(snapshot)).toThrow('REPORT_INVALID_SNAPSHOT')
  })
  it('rejects a forged ancestor chain in a frozen snapshot', async () => {
    const root = await execute()
    const child = await execute(plan(), input(root.turn))
    publish(child.turn)
    const snapshot = freezeReportAnswer(task, {
      kind: 'turn',
      id: child.turn.id,
      candidateHash: child.turn.answer.candidateHash
    })
    snapshot.lineage![0].candidateHash = 'forged'
    expect(() => validateReportSnapshot(snapshot)).toThrow('REPORT_INVALID_SNAPSHOT')
  })
  it('preserves legacy candidate hashes without materializing new optional fields', async () => {
    const { turn } = await execute()
    delete turn.framework
    turn.answer.candidateHash = naturalTurnHash(turn, task)
    const before = turn.answer.candidateHash
    const restored = AnalysisTaskSchema.parse(JSON.parse(JSON.stringify(task)))
    expect(Object.hasOwn(restored.turns[0], 'framework')).toBe(false)
    expect(Object.hasOwn(restored.turns[0], 'context')).toBe(false)
    expect(naturalTurnHash(restored.turns[0], restored)).toBe(before)
  })
})
