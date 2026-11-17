import { randomUUID } from 'node:crypto'
import logger from '@shared/logger'
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { JoinInput, SourceOrigin } from '@shared/analysisData'
import { SourceOriginSchema } from '@shared/analysisData'
import { candidateHash, naturalTurnHash } from './integrity'
export { candidateHash, naturalTurnHash } from './integrity'
import { assertFileFingerprint } from './sourceVersion'
import { assertAnalysisSource } from './executionSources'
import type { NaturalAnalyzer } from './naturalAnalyzer'
import { validateNaturalViews } from './naturalAnalyzer'
import type { NaturalAsk } from '@shared/analysis'
import {
  NaturalTurnSchema,
  NaturalQuerySchema,
  NaturalReadyPlanSchema,
  type AnalysisModel,
  type NaturalViewSchema
} from '@shared/analysis'
import type { z } from 'zod'
import type { FrameDraft, FrameDecision } from '@shared/analysisFramework'
import { buildAnalysisFrame, validateFramePlan } from './framework'
import { buildNaturalDerived } from './naturalFacts'
import type { DatabaseConnectionProvider } from '@/data/databaseConnection'
import type { AnalysisTask, AnalysisSource, AnalysisPlan } from '@shared/analysis'
import { AnalysisTasksTable } from './data/analysisTasks'
import { AnalysisError } from './errors'
import { inspectWorkbook, previewSource, calculateSource, buildJoinedSource } from './workerClient'

export class AnalysisService {
  private readonly busy = new Set<string>()
  private workspace?: {
    metadata(taskId: string): { title: string; projectDir: string | null; isPinned: boolean } | null
    rename(taskId: string, title: string): Promise<unknown>
    configure(
      taskId: string,
      input: { projectDir?: string | null; isPinned?: boolean }
    ): Promise<unknown>
  }
  private changed?: (taskId: string) => void
  setWorkspace(
    workspace: NonNullable<AnalysisService['workspace']>,
    changed?: (taskId: string) => void
  ) {
    this.workspace = workspace
    this.changed = changed
  }
  private notifyChanged(taskId: string) {
    try {
      this.changed?.(taskId)
    } catch {
      logger.warn('[Analysis] Task update notification failed', { taskId })
    }
  }
  constructor(
    private readonly connection: DatabaseConnectionProvider,
    private readonly natural?: NaturalAnalyzer,
    private readonly datasetRoot?: string
  ) {}
  private get table() {
    return new AnalysisTasksTable(this.connection.getDatabase())
  }
  list() {
    return this.table.list().map((task) => ({ ...task, ...this.workspace?.metadata(task.id) }))
  }
  get(taskId: string) {
    const task = this.table.get(taskId)
    return { ...task, ...this.workspace?.metadata(taskId) }
  }
  create(title: string): AnalysisTask {
    const now = new Date().toISOString()
    const task = this.table.save({
      version: 1,
      id: randomUUID(),
      title,
      createdAt: now,
      updatedAt: now,
      sources: [],
      runs: [],
      turns: []
    })
    this.notifyChanged(task.id)
    return task
  }
  private async mutate(
    taskId: string,
    operation: (task: AnalysisTask) => Promise<void>,
    signal?: AbortSignal
  ): Promise<AnalysisTask> {
    if (this.busy.has(taskId)) throw new AnalysisError('BUSY')
    this.busy.add(taskId)
    try {
      signal?.throwIfAborted()
      const task = this.get(taskId)
      await operation(task)
      signal?.throwIfAborted()
      task.updatedAt = new Date().toISOString()
      const saved = this.table.save(task)
      this.notifyChanged(taskId)
      return saved
    } finally {
      this.busy.delete(taskId)
    }
  }
  private source(task: AnalysisTask, sourceId: string): AnalysisSource {
    const source = task.sources.find((source) => source.id === sourceId)
    if (!source) throw new AnalysisError('NOT_FOUND')
    return source
  }
  rename(taskId: string, title: string) {
    return this.mutate(taskId, async (task) => {
      await this.workspace?.rename(taskId, title)
      task.title = title
    })
  }
  configureTask(taskId: string, input: { projectDir?: string | null; isPinned?: boolean }) {
    return this.mutate(taskId, async (task) => {
      await this.workspace?.configure(taskId, input)
      Object.assign(task, input)
    })
  }
  addSources(taskId: string, paths: string[]) {
    return this.mutate(taskId, async (task) => {
      // Validate all selections first; a failed selection never leaves a half-added set.
      const sources: AnalysisSource[] = []
      for (const filePath of paths) {
        const loaded = { source: await inspectWorkbook(filePath) }
        if (
          !task.sources.some((source) => source.path.toLowerCase() === filePath.toLowerCase()) &&
          !sources.some((source) => source.path.toLowerCase() === filePath.toLowerCase())
        )
          sources.push(loaded.source)
      }
      task.sources.push(...sources)
    })
  }
  remove(taskId: string, sourceId: string) {
    return this.mutate(taskId, async (task) => {
      this.source(task, sourceId)
      task.sources = task.sources.filter((source) => source.id !== sourceId)
    })
  }
  refresh(taskId: string, sourceId: string) {
    return this.mutate(taskId, async (task) => {
      const source = this.source(task, sourceId)
      if (source.origin) throw new AnalysisError('DATA_SNAPSHOT_IMMUTABLE')
      const loaded = { source: await inspectWorkbook(source.path, source.id) }
      task.sources = task.sources.map((current) =>
        current.id === sourceId ? { ...loaded.source, boundAt: source.boundAt } : current
      )
    })
  }
  async preview(input: {
    taskId: string
    sourceId: string
    sheet: string
    headerRow: number
    page: number
  }) {
    const source = this.source(this.get(input.taskId), input.sourceId)
    return previewSource(source, input.sheet, input.headerRow, input.page)
  }
  run(taskId: string, plan: AnalysisPlan, signal?: AbortSignal) {
    return this.mutate(
      taskId,
      async (task) => {
        const source = this.source(task, plan.sourceId)
        await assertAnalysisSource(task, source)
        const run = await calculateSource(source, plan, signal)
        await assertAnalysisSource(task, source)
        run.answer.candidateHash = candidateHash(run)
        task.runs.push(run)
      },
      signal
    )
  }
  publish(taskId: string, runId: string, expectedHash: string) {
    return this.mutate(taskId, async (task) => {
      const run = task.runs.find((run) => run.id === runId)
      if (!run || expectedHash !== run.answer.candidateHash || candidateHash(run) !== expectedHash)
        throw new AnalysisError('INVALID_DRAFT')
      const currentSource = this.source(task, run.source.id)
      if (currentSource.sha256 !== run.source.sha256) throw new AnalysisError('SOURCE_CHANGED')
      await assertAnalysisSource(task, run.source)
      run.answer = {
        ...run.answer,
        status: 'published',
        publishedAt: run.answer.publishedAt ?? new Date().toISOString()
      }
    })
  }
  private get naturalAnalyzer(): NaturalAnalyzer {
    if (!this.natural) throw new AnalysisError('MODEL_NOT_CONFIGURED')
    return this.natural
  }
  models() {
    return this.naturalAnalyzer.models()
  }
  dataTargets(taskId: string) {
    this.get(taskId)
    return this.naturalAnalyzer.dataTargets(taskId)
  }
  private async withSnapshots<T>(action: (staged: string[]) => Promise<T>): Promise<T> {
    const staged: string[] = []
    try {
      return await action(staged)
    } catch (error) {
      // Only paths allocated by this operation are rolled back, never existing datasets.
      for (const file of staged) {
        const relative = path.relative(path.resolve(this.datasetRoot!), path.resolve(file))
        if (relative.startsWith('..') || path.isAbsolute(relative))
          throw new AnalysisError('STORAGE_ERROR')
        try {
          await unlink(file)
        } catch (failure) {
          if ((failure as NodeJS.ErrnoException).code !== 'ENOENT')
            throw new AnalysisError('STORAGE_ERROR')
        }
      }
      throw error
    }
  }
  private async storeSnapshot(
    task: AnalysisTask,
    bytes: Buffer,
    origin: SourceOrigin,
    staged: string[],
    signal?: AbortSignal
  ) {
    signal?.throwIfAborted()
    if (!this.datasetRoot) throw new AnalysisError('STORAGE_ERROR')
    if (bytes.length > 20 * 1024 * 1024) throw new AnalysisError('SQL_LIMIT')
    const validated = SourceOriginSchema.parse(origin)
    const directory = path.join(this.datasetRoot, task.id)
    await mkdir(directory, { recursive: true })
    const id = randomUUID()
    const file = path.join(directory, id + '.xlsx')
    await writeFile(file + '.tmp', bytes, { flag: 'wx' })
    staged.push(file + '.tmp')
    await rename(file + '.tmp', file)
    staged.push(file)
    const source = await inspectWorkbook(file, id, signal)
    signal?.throwIfAborted()
    source.name = validated.title + '.xlsx'
    source.origin = validated
    task.sources.push(source)
    return source
  }
  addSnapshot(taskId: string, bytes: Buffer, origin: SourceOrigin, signal?: AbortSignal) {
    return this.withSnapshots((staged) =>
      this.mutate(
        taskId,
        async (task) => {
          await this.storeSnapshot(task, bytes, origin, staged, signal)
        },
        signal
      )
    )
  }
  addSnapshots(
    taskId: string,
    payloads: Array<{ bytes: Buffer; origin: SourceOrigin }>,
    validate: () => Promise<void>,
    signal?: AbortSignal
  ) {
    return this.withSnapshots((staged) =>
      this.mutate(
        taskId,
        async (task) => {
          if (!payloads.length || payloads.length > 100) throw new AnalysisError('FILE_LIMIT')
          // All result tables commit together. An incomplete delivery never leaves a partial set.
          for (const payload of payloads)
            await this.storeSnapshot(task, payload.bytes, payload.origin, staged, signal)
          await validate()
          signal?.throwIfAborted()
        },
        signal
      )
    )
  }
  join(taskId: string, input: JoinInput, signal?: AbortSignal) {
    return this.withSnapshots((staged) =>
      this.mutate(
        taskId,
        async (task) => {
          const left = this.source(task, input.left.sourceId)
          const right = this.source(task, input.right.sourceId)
          const result = await buildJoinedSource(left, right, input, signal)
          await assertFileFingerprint(left)
          await assertFileFingerprint(right)
          await this.storeSnapshot(
            task,
            Buffer.from(result.base64, 'base64'),
            result.origin,
            staged,
            signal
          )
        },
        signal
      )
    )
  }
  status(taskId: string) {
    this.table.assertExists(taskId)
    return this.naturalAnalyzer.status(taskId)
  }
  cancel(taskId: string, requestId: string, owner: number) {
    this.table.assertExists(taskId)
    return this.naturalAnalyzer.cancel(taskId, requestId, owner)
  }
  cancelOwner(owner: number) {
    this.natural?.cancelOwner(owner)
  }
  ask(taskId: string, input: NaturalAsk, owner: number) {
    return this.withSnapshots((staged) =>
      this.mutate(taskId, async (task) => {
        const result = await this.naturalAnalyzer.analyze(task, input, owner, {
          snapshot: ({ bytes, origin }, signal) =>
            this.storeSnapshot(task, bytes, origin, staged, signal),
          join: async (join, signal) => {
            const left = this.source(task, join.left.sourceId)
            const right = this.source(task, join.right.sourceId)
            const built = await buildJoinedSource(left, right, join, signal)
            await assertFileFingerprint(left)
            await assertFileFingerprint(right)
            return this.storeSnapshot(
              task,
              Buffer.from(built.base64, 'base64'),
              built.origin,
              staged,
              signal
            )
          }
        })
        for (const run of result.runs) run.answer.candidateHash = candidateHash(run)
        task.runs.push(...result.runs)
        result.turn.answer.candidateHash = naturalTurnHash(result.turn, task)
        task.turns.push(result.turn)
      })
    )
  }
  publishTurn(taskId: string, turnId: string, expectedHash: string) {
    return this.mutate(taskId, async (task) => {
      const turn = task.turns.find((turn) => turn.id === turnId)
      if (
        !turn ||
        turn.state !== 'answered' ||
        !turn.review.confirmed ||
        turn.answer.candidateHash !== expectedHash ||
        naturalTurnHash(turn, task) !== expectedHash
      )
        throw new AnalysisError('INVALID_DRAFT')
      const runs = turn.queryRuns.map((reference) => {
        const run = task.runs.find((run) => run.id === reference.runId)
        if (!run || candidateHash(run) !== run.answer.candidateHash)
          throw new AnalysisError('INVALID_DRAFT')
        return run
      })
      const sources = new Map(runs.map((run) => [run.source.id, run.source]))
      for (const source of sources.values()) {
        if (this.source(task, source.id).sha256 !== source.sha256)
          throw new AnalysisError('SOURCE_CHANGED')
        await assertAnalysisSource(task, source)
      }
      const publishedAt = turn.answer.publishedAt ?? new Date().toISOString()
      turn.answer = { ...turn.answer, status: 'published', publishedAt }
      for (const run of runs)
        run.answer = {
          ...run.answer,
          status: 'published',
          publishedAt: run.answer.publishedAt ?? publishedAt
        }
    })
  }

  captureSnapshot(
    taskId: string,
    fetch: () => Promise<{ bytes: Buffer; origin: SourceOrigin }>,
    seal: () => void,
    signal: AbortSignal
  ) {
    return this.withSnapshots((staged) =>
      this.mutate(
        taskId,
        async (task) => {
          const payload = await fetch()
          await this.storeSnapshot(task, payload.bytes, payload.origin, staged, signal)
          seal()
        },
        signal
      )
    )
  }

  submitToolAnswer(
    taskId: string,
    input: {
      question: string
      runs: Array<{ key: string; runId: string }>
      views: Array<z.infer<typeof NaturalViewSchema>>
      frame?: FrameDraft
      decisions?: FrameDecision[]
    },
    model: AnalysisModel,
    signal?: AbortSignal
  ) {
    return this.mutate(
      taskId,
      async (task) => {
        const runs = new Map(
          input.runs.map((ref) => {
            const run = task.runs.find((r) => r.id === ref.runId)
            if (!run || run.plan.rowScope || candidateHash(run) !== run.answer.candidateHash)
              throw new AnalysisError('INVALID_DRAFT')
            return [ref.key, run] as const
          })
        )
        if (
          runs.size !== input.runs.length ||
          new Set(input.runs.map((r) => r.runId)).size !== input.runs.length
        )
          throw new AnalysisError('INVALID_DRAFT')
        for (const run of runs.values()) {
          if (this.source(task, run.source.id).sha256 !== run.source.sha256)
            throw new AnalysisError('SOURCE_CHANGED')
          await assertAnalysisSource(task, run.source)
        }
        const plan = NaturalReadyPlanSchema.parse({
          status: 'ready',
          queries: [...runs].map(([key, run]) => {
            const {
              question: _question,
              unit: _unit,
              period: _period,
              rowScope: _scope,
              ...query
            } = run.plan
            return NaturalQuerySchema.parse({ ...query, key })
          }),
          views: input.views,
          ...(input.frame ? { frame: input.frame } : {})
        })
        validateNaturalViews(plan)
        validateFramePlan(plan)
        const turn = NaturalTurnSchema.parse({
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          question: input.question,
          model,
          state: 'answered',
          message: '',
          plan,
          queryRuns: input.runs,
          derived: buildNaturalDerived(plan, runs),
          framework: buildAnalysisFrame(input.question, plan, runs, input.decisions),
          review: { version: 'natural/1', modelCalls: 0, confirmed: false },
          answer: { status: 'draft', candidateHash: '', publishedAt: null }
        })
        turn.answer.candidateHash = naturalTurnHash(turn, task)
        task.turns.push(turn)
      },
      signal
    )
  }

  async confirmToolAnswer(
    taskId: string,
    turnId: string,
    expectedHash: string,
    signal?: AbortSignal
  ) {
    return this.mutate(
      taskId,
      async (task) => {
        const turn = task.turns.find((t) => t.id === turnId)
        if (
          !turn ||
          turn.state !== 'answered' ||
          turn.answer.candidateHash !== expectedHash ||
          naturalTurnHash(turn, task) !== expectedHash
        )
          throw new AnalysisError('INVALID_DRAFT')
        for (const ref of turn.queryRuns) {
          const run = task.runs.find((r) => r.id === ref.runId)
          if (!run || candidateHash(run) !== run.answer.candidateHash)
            throw new AnalysisError('INVALID_DRAFT')
          if (this.source(task, run.source.id).sha256 !== run.source.sha256)
            throw new AnalysisError('SOURCE_CHANGED')
          await assertAnalysisSource(task, run.source)
        }
        turn.review.confirmed = true
        turn.answer.candidateHash = naturalTurnHash(turn, task)
        const publishedAt = turn.answer.publishedAt ?? new Date().toISOString()
        turn.answer = { ...turn.answer, status: 'published', publishedAt }
        for (const ref of turn.queryRuns) {
          const run = task.runs.find((r) => r.id === ref.runId)!
          run.answer = {
            ...run.answer,
            status: 'published',
            publishedAt: run.answer.publishedAt ?? publishedAt
          }
        }
      },
      signal
    )
  }
}
