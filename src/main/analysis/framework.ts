import { randomUUID } from 'node:crypto'
import type {
  AnalysisPlan,
  AnalysisRun,
  AnalysisTask,
  NaturalAsk,
  NaturalContext,
  NaturalReadyPlan,
  NaturalTurn
} from '@shared/analysis'
import { AnalysisPlanSchema } from '@shared/analysis'
import type { AnalysisFrame, FrameDecision } from '@shared/analysisFramework'
import { AnalysisError } from './errors'
import { candidateHash, naturalTurnHash } from './integrity'

const invalid = () => new AnalysisError('INVALID_ANALYSIS_CONTEXT')

export function analysisAncestors(task: AnalysisTask, turn: NaturalTurn): NaturalTurn[] {
  const path: NaturalTurn[] = []
  const seen = new Set([turn.id])
  let cursor = turn.context
  while (cursor) {
    const parent = task.turns.find((item) => item.id === cursor!.parentTurnId)
    if (
      !parent ||
      seen.has(parent.id) ||
      parent.answer.candidateHash !== cursor.parentCandidateHash ||
      naturalTurnHash(parent, task) !== cursor.parentCandidateHash
    )
      throw invalid()
    path.unshift(parent)
    seen.add(parent.id)
    if (path.length > 12) throw new AnalysisError('ANALYSIS_DEPTH_LIMIT')
    cursor = parent.context
  }
  return path
}

export function resolveAnalysisContext(
  task: AnalysisTask,
  input: NaturalAsk
): NaturalContext | undefined {
  const request = input.continuation
  if (!request) return undefined
  if (input.newRoot) throw invalid()
  const parent = task.turns.find((turn) => turn.id === request.parentTurnId)
  if (
    !parent ||
    parent.answer.candidateHash !== request.parentCandidateHash ||
    naturalTurnHash(parent, task) !== request.parentCandidateHash
  )
    throw invalid()
  const path = analysisAncestors(task, parent)
  const depth = path.length + 1
  if (depth > 12) throw new AnalysisError('ANALYSIS_DEPTH_LIMIT')
  if (request.questionId && !parent.framework?.questions.some((q) => q.id === request.questionId))
    throw invalid()
  let scope = parent.context?.scope ? structuredClone(parent.context.scope) : undefined
  if (scope && !request.scope && parent.state === 'answered') {
    const candidates = parent.queryRuns.map((reference) => {
      const run = task.runs.find((item) => item.id === reference.runId)
      if (!run || candidateHash(run) !== run.answer.candidateHash) throw invalid()
      return { key: reference.key, run }
    })
    const signature = (plan: AnalysisPlan) =>
      JSON.stringify({
        sourceId: plan.sourceId,
        sheet: plan.sheet,
        headerRow: plan.headerRow,
        filters: plan.filters.map((filter) => JSON.stringify(filter)).sort(),
        rowScope: plan.rowScope
      })
    if (
      !candidates.length ||
      candidates.some(({ run }) => signature(run.plan) !== signature(candidates[0].run.plan))
    )
      throw invalid()
    scope = {
      ...scope,
      queryKey: candidates[0].key,
      sourceSha256: candidates[0].run.source.sha256,
      plan: structuredClone(candidates[0].run.plan)
    }
  }
  if (request.scope) {
    if (parent.state !== 'answered') throw invalid()
    const reference = parent.queryRuns.find((item) => item.key === request.scope!.queryKey)
    const run = task.runs.find((run) => run.id === reference?.runId)
    if (!run || candidateHash(run) !== run.answer.candidateHash) throw invalid()
    const plan = structuredClone(run.plan)
    scope = { queryKey: request.scope.queryKey, sourceSha256: run.source.sha256, plan }
    if (request.scope.valueId) {
      const value = run.values.find((value) => value.id === request.scope!.valueId)
      if (!value || !value.inputs.length) throw invalid()
      const rows = [...new Set(value.inputs.map((input) => input.row))].sort((a, b) => a - b)
      if (rows.some((row) => row <= plan.headerRow || row > 100000)) throw invalid()
      if (plan.rowScope && rows.some((row) => !plan.rowScope!.rows.includes(row))) throw invalid()
      scope.plan.rowScope = { sourceSha256: run.source.sha256, rows }
      scope.selected = {
        valueId: value.id,
        category: value.category,
        value: value.value,
        exact: value.exact
      }
    }
  }
  if (scope) {
    const source = task.sources.find((source) => source.id === scope!.plan.sourceId)
    if (!source || source.sha256 !== scope.sourceSha256) throw new AnalysisError('SOURCE_CHANGED')
  }
  return {
    parentTurnId: parent.id,
    parentCandidateHash: parent.answer.candidateHash,
    depth,
    ...(request.questionId ? { questionId: request.questionId } : {}),
    ...(scope ? { scope } : {})
  }
}

export function branchHistory(
  task: AnalysisTask,
  context: NaturalContext | undefined,
  newRoot?: boolean
) {
  if (newRoot) return []
  if (!context) return task.turns.slice(-4)
  const parent = task.turns.find((turn) => turn.id === context.parentTurnId)!
  return [...analysisAncestors(task, parent), parent].slice(-4)
}

export function applyAnalysisScope(
  plan: NaturalReadyPlan,
  context?: NaturalContext
): NaturalReadyPlan {
  if (!context?.scope) return plan
  const scope = context.scope.plan
  return {
    ...plan,
    queries: plan.queries.map((query) => {
      if (
        query.sourceId !== scope.sourceId ||
        query.sheet !== scope.sheet ||
        query.headerRow !== scope.headerRow
      )
        throw invalid()
      const filters = [
        ...new Map(
          [...scope.filters, ...query.filters].map((filter) => [JSON.stringify(filter), filter])
        ).values()
      ]
      if (filters.length > 10) throw new AnalysisError('ANALYSIS_CONTEXT_LIMIT')
      return { ...query, filters }
    })
  }
}

export function scopedQueryPlan(
  query: NaturalReadyPlan['queries'][number],
  question: string,
  context?: NaturalContext
): AnalysisPlan {
  const { key: _key, ...plan } = query
  return AnalysisPlanSchema.parse({
    ...plan,
    question,
    unit: '',
    period: '',
    ...(context?.scope?.plan.rowScope ? { rowScope: context.scope.plan.rowScope } : {})
  })
}

export function validateFramePlan(plan: NaturalReadyPlan): void {
  const frame = plan.frame
  if (!frame) return
  const keys = new Set(plan.queries.map((query) => query.key))
  if (
    new Set(frame.questions.map((q) => q.key)).size !== frame.questions.length ||
    frame.questions.some(
      (q) =>
        new Set(q.queryKeys).size !== q.queryKeys.length ||
        q.queryKeys.some((key) => !keys.has(key))
    ) ||
    plan.queries.some((query) => !frame.questions.some((q) => q.queryKeys.includes(query.key)))
  )
    throw new AnalysisError('INVALID_ANALYSIS_PLAN')
}

export function buildAnalysisFrame(
  question: string,
  plan: NaturalReadyPlan,
  runs: Map<string, AnalysisRun>,
  decisions: FrameDecision[] = []
): AnalysisFrame {
  validateFramePlan(plan)
  const draft = plan.frame ?? {
    objective: question,
    questions: [
      {
        key: 'h1',
        kind: 'question' as const,
        text: question,
        queryKeys: plan.queries.map((q) => q.key)
      }
    ]
  }
  if (
    new Set(decisions.map((d) => d.questionKey)).size !== decisions.length ||
    decisions.some((decision) => !draft.questions.some((q) => q.key === decision.questionKey))
  )
    throw new AnalysisError('INVALID_ANALYSIS_PLAN')
  const questions = draft.questions.map((item) => {
    const decision = decisions.find((d) => d.questionKey === item.key)
    const references = (decision?.evidence ?? []).map((reference) => {
      const run = runs.get(reference.queryKey)
      if (
        !item.queryKeys.includes(reference.queryKey) ||
        !run?.values.some((value) => value.id === reference.valueId)
      )
        throw new AnalysisError('INVALID_ANALYSIS_PLAN')
      return { runId: run.id, valueId: reference.valueId }
    })
    if (decision && ['supported', 'refuted'].includes(decision.judgment) && !references.length)
      throw new AnalysisError('INVALID_ANALYSIS_PLAN')
    if (!item.queryKeys.length && decision && decision.judgment !== 'unverified')
      throw new AnalysisError('INVALID_ANALYSIS_PLAN')
    return {
      ...item,
      id: randomUUID(),
      judgment: decision?.judgment ?? ('unverified' as const),
      next:
        decision?.next ??
        ((item.queryKeys.length ? 'stop' : 'needs_data') as 'stop' | 'needs_data'),
      reason: decision?.reason ?? '',
      evidence: references
    }
  })
  return {
    version: 'analysis-frame/1',
    objective: draft.objective,
    workflowRefs: plan.frame?.workflowRefs ?? [],
    questions
  }
}
