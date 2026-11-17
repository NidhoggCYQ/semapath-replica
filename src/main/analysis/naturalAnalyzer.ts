import { randomUUID } from 'node:crypto'
import type { AnalysisFrame } from '@shared/analysisFramework'
import {
  resolveAnalysisContext,
  branchHistory,
  applyAnalysisScope,
  scopedQueryPlan,
  validateFramePlan,
  buildAnalysisFrame
} from './framework'
import type { z } from 'zod'
import {
  NaturalDecisionSchema,
  NaturalReviewSchema,
  NaturalTurnSchema,
  type AnalysisModel,
  type AnalysisRun,
  type AnalysisTask,
  type NaturalAsk,
  type NaturalProgress,
  type NaturalReadyPlan,
  type NaturalTurn,
  type WorkbookCatalog
} from '@shared/analysis'
import { AnalysisError } from './errors'
import { assertFileFingerprint } from './sourceVersion'
import { calculateSource, describeSource } from './workerClient'
import { buildNaturalDerived } from './naturalFacts'
import { planningPrompt, reviewPrompt } from './naturalPrompts'
import type { RetrievalGateway, RetrievalSession, RetrievalSink } from './retrieval/types'
import type { RetrievalTrace } from '@shared/analysisAcquisition'
import { retrieveData } from './retrieval/planner'

export interface NaturalModelGateway {
  models(): Promise<AnalysisModel[]>
  generate(model: AnalysisModel, prompt: string, signal: AbortSignal): Promise<string>
}
export function parseNaturalJson<T extends z.ZodTypeAny>(raw: string, schema: T): z.output<T> {
  if (raw.length > 120000) throw new AnalysisError('INVALID_ANALYSIS_PLAN')
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/, '')
  try {
    return schema.parse(JSON.parse(text))
  } catch {
    throw new AnalysisError('INVALID_ANALYSIS_PLAN')
  }
}
export function validateNaturalPlan(plan: NaturalReadyPlan, catalogs: WorkbookCatalog[]): void {
  validateFramePlan(plan)
  const keys = new Set(plan.queries.map((query) => query.key))
  if (keys.size !== plan.queries.length) throw new AnalysisError('INVALID_ANALYSIS_PLAN')
  for (const query of plan.queries) {
    const source = catalogs.find((source) => source.sourceId === query.sourceId)
    const sheet = source?.sheets.find((sheet) => sheet.name === query.sheet)
    const header = sheet?.sampleRows.find((row) => row.row === query.headerRow)
    if (!header) throw new AnalysisError('INVALID_ANALYSIS_PLAN')
    const columns = new Set(header.cells.map((cell) => cell.column))
    if (
      (query.operation !== 'count' && !columns.has(query.measure)) ||
      (query.groupBy && !columns.has(query.groupBy)) ||
      query.filters.some((filter) => !columns.has(filter.column))
    )
      throw new AnalysisError('INVALID_ANALYSIS_PLAN')
    if (query.operation === 'count' && query.measure !== '')
      throw new AnalysisError('INVALID_ANALYSIS_PLAN')
    if (query.grouping && query.grouping !== 'raw' && !query.groupBy)
      throw new AnalysisError('INVALID_ANALYSIS_PLAN')
    for (const filter of query.filters) {
      if (filter.operator === 'in' && (!filter.values?.length || filter.kind === 'number'))
        throw new AnalysisError('INVALID_ANALYSIS_PLAN')
      if (filter.kind === 'text' && !['eq', 'neq', 'contains', 'in'].includes(filter.operator))
        throw new AnalysisError('INVALID_ANALYSIS_PLAN')
      if (
        filter.kind === 'number' &&
        !['eq', 'neq', 'gt', 'gte', 'lt', 'lte'].includes(filter.operator)
      )
        throw new AnalysisError('INVALID_ANALYSIS_PLAN')
      if (filter.kind === 'date') {
        if (!['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte'].includes(filter.operator))
          throw new AnalysisError('INVALID_ANALYSIS_PLAN')
        const dates = filter.operator === 'in' ? (filter.values ?? []) : [filter.value]
        if (
          dates.some(
            (value) =>
              !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
              !Number.isFinite(Date.parse(value)) ||
              new Date(value).toISOString().slice(0, 10) !== value
          )
        )
          throw new AnalysisError('INVALID_ANALYSIS_PLAN')
      }
    }
  }
  validateNaturalViews(plan)
}

export function validateNaturalViews(plan: NaturalReadyPlan): void {
  const keys = new Set(plan.queries.map((query) => query.key))
  if (keys.size !== plan.queries.length) throw new AnalysisError('INVALID_ANALYSIS_PLAN')
  for (const view of plan.views) {
    const query = plan.queries.find((query) => query.key === view.queryKey)
    if ((view.kind === 'method') !== !!query?.study)
      throw new AnalysisError('INVALID_ANALYSIS_PLAN')
    if (query?.study && query.study.chart !== view.chart)
      throw new AnalysisError('INVALID_ANALYSIS_PLAN')
    if (!query?.study && !['bar', 'line', 'table'].includes(view.chart))
      throw new AnalysisError('INVALID_ANALYSIS_PLAN')
    if (
      !keys.has(view.queryKey) ||
      (view.kind === 'comparison' &&
        (!view.baselineQueryKey ||
          !keys.has(view.baselineQueryKey) ||
          view.baselineQueryKey === view.queryKey))
    )
      throw new AnalysisError('INVALID_ANALYSIS_PLAN')
    if (view.kind !== 'comparison' && view.baselineQueryKey)
      throw new AnalysisError('INVALID_ANALYSIS_PLAN')
    if (
      view.kind === 'ranking' &&
      !plan.queries.find((query) => query.key === view.queryKey)?.groupBy
    )
      throw new AnalysisError('INVALID_ANALYSIS_PLAN')
  }
  if (
    plan.queries.some(
      (query) =>
        !plan.views.some(
          (view) => view.queryKey === query.key || view.baselineQueryKey === query.key
        )
    )
  )
    throw new AnalysisError('INVALID_ANALYSIS_PLAN')
}
type ActiveJob = { owner: number; controller: AbortController; progress: NaturalProgress }
export class NaturalAnalyzer {
  private retrieval: RetrievalGateway | undefined
  setRetrieval(gateway: RetrievalGateway) {
    this.retrieval = gateway
  }
  dataTargets(taskId: string) {
    return this.retrieval?.targets(taskId) ?? { targets: [], issues: [] }
  }
  private readonly active = new Map<string, ActiveJob>()
  private readonly unsettled = new Map<string, number>()
  constructor(private readonly gateway: NaturalModelGateway) {}
  models() {
    return this.gateway.models()
  }
  status(taskId: string) {
    return this.active.get(taskId)?.progress ?? null
  }
  cancel(taskId: string, requestId: string, owner: number) {
    const job = this.active.get(taskId)
    if (
      !job ||
      job.progress.requestId !== requestId ||
      job.owner !== owner ||
      job.progress.stage === 'saving'
    )
      return false
    job.controller.abort(new AnalysisError('ANALYSIS_CANCELLED'))
    return true
  }
  cancelOwner(owner: number) {
    for (const job of this.active.values())
      if (job.owner === owner) job.controller.abort(new AnalysisError('ANALYSIS_CANCELLED'))
  }
  dispose() {
    for (const job of this.active.values())
      job.controller.abort(new AnalysisError('ANALYSIS_CANCELLED'))
  }
  private check(signal: AbortSignal) {
    if (signal.aborted)
      throw signal.reason instanceof AnalysisError
        ? signal.reason
        : new AnalysisError('ANALYSIS_CANCELLED')
  }
  private async complete(
    model: AnalysisModel,
    prompt: string,
    signal: AbortSignal
  ): Promise<string> {
    this.check(signal)
    if (prompt.length > 80000) throw new AnalysisError('ANALYSIS_CONTEXT_LIMIT')
    const key = `${model.providerId}\0${model.modelId}`
    if ((this.unsettled.get(key) ?? 0) >= 2) throw new AnalysisError('BUSY')
    this.unsettled.set(key, (this.unsettled.get(key) ?? 0) + 1)
    const pending = Promise.resolve()
      .then(() => {
        this.check(signal)
        return this.gateway.generate(model, prompt, signal)
      })
      .finally(() => {
        const remaining = (this.unsettled.get(key) ?? 1) - 1
        if (remaining) this.unsettled.set(key, remaining)
        else this.unsettled.delete(key)
      })
    let abort: (() => void) | undefined
    const cancelled = new Promise<never>((_, reject) => {
      abort = () =>
        reject(
          signal.reason instanceof AnalysisError
            ? signal.reason
            : new AnalysisError('ANALYSIS_CANCELLED')
        )
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
    try {
      return await Promise.race([pending, cancelled])
    } catch (error) {
      this.check(signal)
      if (error instanceof AnalysisError) throw error
      throw new AnalysisError('MODEL_FAILED')
    } finally {
      if (abort) signal.removeEventListener('abort', abort)
    }
  }
  async analyze(
    task: AnalysisTask,
    input: NaturalAsk,
    owner: number,
    sink?: RetrievalSink
  ): Promise<{ turn: NaturalTurn; runs: AnalysisRun[] }> {
    if (this.active.has(task.id)) throw new AnalysisError('BUSY')
    const context = resolveAnalysisContext(task, input)
    if (input.retrieval && context?.scope) throw new AnalysisError('FETCH_SCOPE_LOCKED')
    if (input.retrieval && (!this.retrieval || !sink))
      throw new AnalysisError('FETCH_NOT_CONFIGURED')
    const promptTask = { ...task, turns: branchHistory(task, context, input.newRoot) }
    let sources = context?.scope
      ? task.sources.filter((source) => source.id === context.scope!.plan.sourceId)
      : task.sources

    if (!input.retrieval && !sources.length) throw new AnalysisError('NOT_FOUND')
    if (!input.retrieval && sources.length > 6) throw new AnalysisError('ANALYSIS_CONTEXT_LIMIT')
    const controller = new AbortController()
    const job: ActiveJob = {
      owner,
      controller,
      progress: {
        requestId: input.requestId,
        stage: 'preparing',
        startedAt: new Date().toISOString()
      }
    }
    this.active.set(task.id, job)
    const timer = setTimeout(
      () => {
        if (job.progress.stage !== 'saving') controller.abort(new AnalysisError('MODEL_TIMEOUT'))
      },
      input.retrieval ? 300000 : 180000
    )
    let calls = 0
    let model: AnalysisModel
    let retrieval: RetrievalTrace | undefined
    const maxCalls = input.retrieval ? 10 : 4
    const complete = async <T extends z.ZodTypeAny>(
      prompt: string,
      schema: T
    ): Promise<z.output<T>> => {
      if (calls >= maxCalls) throw new AnalysisError('INVALID_ANALYSIS_PLAN')
      calls++
      const raw = await this.complete(model, prompt, controller.signal)
      try {
        return parseNaturalJson(raw, schema)
      } catch {
        if (calls >= maxCalls) throw new AnalysisError('INVALID_ANALYSIS_PLAN')
        calls++
        return parseNaturalJson(
          await this.complete(
            model,
            `${prompt}\nYour previous response was invalid JSON or did not match the required schema. Return only valid schema-conforming JSON. Do not add fields.`,
            controller.signal
          ),
          schema
        )
      }
    }
    const makeTurn = (
      state: NaturalTurn['state'],
      message: string,
      plan: NaturalReadyPlan | null,
      runs: Map<string, AnalysisRun>,
      confirmed: boolean,
      framework?: AnalysisFrame
    ): NaturalTurn =>
      NaturalTurnSchema.parse({
        id: randomUUID(),
        ...(retrieval ? { retrieval } : {}),
        createdAt: new Date().toISOString(),
        question: input.question,
        ...(context ? { context } : {}),
        ...(framework ? { framework } : {}),
        model,
        state,
        message,
        plan,
        queryRuns: [...runs].map(([key, run]) => ({ key, runId: run.id })),
        derived: plan ? buildNaturalDerived(plan, runs) : [],
        review: { version: 'natural/1', modelCalls: calls, confirmed },
        answer: { status: 'draft', candidateHash: '', publishedAt: null }
      })
    try {
      const selected = (await this.models()).find(
        (model) => model.providerId === input.providerId && model.modelId === input.modelId
      )
      this.check(controller.signal)
      if (!selected) throw new AnalysisError('MODEL_NOT_CONFIGURED')
      model = selected
      const work = async (session?: RetrievalSession) => {
        if (session) {
          const data = await retrieveData({
            task: promptTask,
            ask: input,
            model,
            session,
            sink: sink!,
            signal: controller.signal,
            complete,
            stage: (stage) => {
              job.progress.stage = stage
            }
          })
          retrieval = data.trace
          if (data.decision)
            return {
              turn: makeTurn(data.decision.status, data.decision.message, null, new Map(), false),
              runs: []
            }
          sources = data.sources
        }
        if (!sources.length) throw new AnalysisError('NOT_FOUND')
        const catalogs: WorkbookCatalog[] = []
        for (const source of sources) {
          this.check(controller.signal)
          catalogs.push(await describeSource(source, controller.signal))
        }
        job.progress.stage = 'planning'
        const decision = await complete(
          planningPrompt(input.question, promptTask, catalogs, context, retrieval),
          NaturalDecisionSchema
        )
        this.check(controller.signal)
        if (decision.status !== 'ready')
          return {
            turn: makeTurn(decision.status, decision.message, null, new Map(), false),
            runs: []
          }
        let plan = decision
        for (let attempt = 0; attempt < 2; attempt++) {
          plan = applyAnalysisScope(plan, context)
          validateNaturalPlan(plan, catalogs)
          job.progress.stage = 'calculating'
          const runs = new Map<string, AnalysisRun>()
          for (const query of plan.queries) {
            this.check(controller.signal)
            const source = task.sources.find((source) => source.id === query.sourceId)!
            const run = await calculateSource(
              source,
              scopedQueryPlan(query, input.question, context),
              controller.signal
            )
            runs.set(query.key, run)
          }
          this.check(controller.signal)
          buildNaturalDerived(plan, runs)
          job.progress.stage = 'reviewing'
          const review = await complete(
            reviewPrompt(input.question, promptTask, plan, runs, context, retrieval),
            NaturalReviewSchema
          )
          this.check(controller.signal)
          if (review.decision === 'clarify')
            return { turn: makeTurn('clarify', review.message, null, new Map(), false), runs: [] }
          if (review.decision === 'confirm') {
            for (const source of new Map(
              [...runs.values()].map((run) => [run.source.id, run.source])
            ).values()) {
              await assertFileFingerprint(source)
              this.check(controller.signal)
            }
            return {
              turn: makeTurn(
                'answered',
                '',
                plan,
                runs,
                true,
                buildAnalysisFrame(input.question, plan, runs, review.decisions)
              ),
              runs: [...runs.values()]
            }
          }
          plan = review.plan
        }
        throw new AnalysisError('INVALID_ANALYSIS_PLAN')
      }
      const finish = async (session?: RetrievalSession) => {
        const relay = () => controller.abort(session!.signal.reason)
        session?.signal.addEventListener('abort', relay, { once: true })
        if (session?.signal.aborted) relay()
        try {
          const result = await work(session)
          for (const step of retrieval?.steps ?? []) {
            const source = task.sources.find((s) => s.id === step.sourceId)
            if (!source) throw new AnalysisError('FETCH_TARGET_CHANGED')
            await assertFileFingerprint(source)
            this.check(controller.signal)
          }
          this.check(controller.signal)
          session?.seal()
          job.progress.stage = 'saving'
          return result
        } finally {
          session?.signal.removeEventListener('abort', relay)
        }
      }
      if (input.retrieval) {
        job.progress.stage = 'reading_structure'
        return await this.retrieval!.use(
          task.id,
          input.retrieval,
          input.requestId,
          owner,
          controller.signal,
          finish
        )
      }
      return await finish()
    } finally {
      clearTimeout(timer)
      if (this.active.get(task.id) === job) this.active.delete(task.id)
    }
  }
}
