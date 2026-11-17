import { AnalysisBranchService } from '@/analysis/branchService'
import { AnalysisUiTable, AnalysisContextsTable } from '@/analysis/data/analysisInteraction'
import { randomUUID, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionRecord } from '@shared/types/agent-interface'
import type { AnalysisPlan, AnalysisTask } from '@shared/analysis'
import { AnalysisRunSchema } from '@shared/analysis'
import { AnalysisTasksTable } from '@/analysis/data/analysisTasks'
import {
  AnalysisSessionsTable,
  AnalysisToolOperationsTable
} from '@/analysis/data/analysisWorkspace'
import { AnalysisService } from '@/analysis/service'
import { AnalysisWorkspaceService } from '@/analysis/workspaceService'
import { AnalysisToolService } from '@/analysis/toolService'
import { AnalysisInteractionService } from '@/analysis/interactionService'
import { AnalysisContextsTable, AnalysisUiTable } from '@/analysis/data/analysisInteraction'
import { sqlSnapshot } from '@/analysis/sqlSnapshot'
import { freezeReportAnswer, validateReportSnapshot } from '@/analysis/reports/snapshot'
import { createAnalysisWorkbook } from '../../fixtures/analysisWorkbook'

const transport = vi.hoisted(() => ({ block: false }))
vi.mock('@/analysis/workerClient', async () => {
  const actual = await vi.importActual<typeof import('@/analysis/workbook')>('@/analysis/workbook')
  return {
    inspectWorkbook: async (file: string, id?: string) =>
      (await actual.loadWorkbook(file, id)).source,
    describeSource: async (source: AnalysisTask['sources'][number]) =>
      actual.describeWorkbook(await actual.loadWorkbook(source.path, source.id), source),
    calculateSource: async (
      source: AnalysisTask['sources'][number],
      plan: AnalysisPlan,
      signal?: AbortSignal
    ) => {
      if (transport.block)
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) reject(signal.reason)
          else signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      signal?.throwIfAborted()
      return AnalysisRunSchema.parse(
        actual.calculateWorkbook(await actual.loadWorkbook(source.path, source.id), source, plan)
      )
    }
  }
})

let db: DatabaseSync
let directory: string
let connection: never
let analysis: AnalysisService
let workspace: AnalysisWorkspaceService
let tools: AnalysisToolService
let task: AnalysisTask
let sessionId: string
let file: string
let providerId: string
let modelId: string
const records = new Map<string, SessionRecord>()
const createSession = vi.fn(async (title: string, projectDir?: string | null) => {
  const id = randomUUID()
  records.set(id, {
    id,
    title,
    projectDir: projectDir ?? null,
    agentId: 'deepchat',
    isPinned: false,
    isDraft: false,
    sessionKind: 'regular',
    orchestrationPolicy: 'explicit',
    toolModeOverride: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
  return { id }
})
function setupServices(reportOverrides: Record<string, unknown> = {}) {
  analysis = new AnalysisService(connection, undefined, path.join(directory, 'datasets'))
  workspace = new AnalysisWorkspaceService(connection, analysis, {
    get: (id) => records.get(id) ?? null,
    list: () => [...records.values()],
    create: createSession,
    rename: async (id, title) => {
      records.get(id)!.title = title
    },
    pin: async (id, pinned) => {
      records.get(id)!.isPinned = pinned
    },
    project: async (id, projectDir) => {
      records.get(id)!.projectDir = projectDir
    }
  })
  analysis.setWorkspace(workspace)
  tools = new AnalysisToolService({
    connection,
    analysis,
    workspace,
    retrieval: { targets: () => ({ targets: [], issues: [] }), use: vi.fn() } as never,
    reports: { list: () => [], ...reportOverrides } as never,
    session: async (id) =>
      records.has(id)
        ? ({
            sessionId: id,
            sessionKind: 'regular',
            agentType: 'deepchat',
            providerId,
            modelId
          } as never)
        : null,
    changed: () => {}
  })
}
async function call(
  name: string,
  args: Record<string, unknown>,
  options: { id?: string; session?: string; signal?: AbortSignal } = {}
) {
  const result = await tools.call(name, args, options.session ?? sessionId, {
    messageId: 'synthetic-message',
    toolCallId: options.id ?? randomUUID(),
    signal: options.signal,
    beforeDispatch: () => {}
  })
  return { data: JSON.parse(result.content), isError: result.rawData?.isError === true }
}
const plan = () =>
  ({
    sourceId: task.sources[0].id,
    sheet: '销售明细',
    headerRow: 1,
    operation: 'sum',
    measure: 'C',
    groupBy: 'B',
    filters: [],
    question: '按区域汇总销售额',
    unit: '元',
    period: '2026年10月'
  }) as AnalysisPlan
async function calculate() {
  const result = await call('datasource_query', { kind: 'file', plan: plan() })
  expect(result.isError).toBe(false)
  return result.data.runId as string
}
async function submit(runId: string) {
  const result = await call('answer_submit', {
    question: '各区域销售额是多少？',
    runs: [{ key: 'q1', runId }],
    views: [{ kind: 'summary', queryKey: 'q1', chart: 'bar' }],
    frame: {
      objective: '核对区域销售额',
      questions: [{ key: 'h1', kind: 'question', text: '各区域销售额', queryKeys: ['q1'] }]
    }
  })
  expect(result.isError, JSON.stringify(result.data)).toBe(false)
  return {
    turnId: result.data.turnId as string,
    candidateHash: result.data.candidateHash as string,
    reviewReceiptId: randomUUID()
  }
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'semapath-workspace-'))
  db = new DatabaseSync(path.join(directory, 'tasks.sqlite'))
  db.exec('PRAGMA foreign_keys=ON')
  connection = {
    getDatabase: () => ({
      prepare: (sql: string) => db.prepare(sql),
      exec: (sql: string) => db.exec(sql),
      transaction: (fn: () => unknown) => () => {
        db.exec('BEGIN')
        try {
          const result = fn()
          db.exec('COMMIT')
          return result
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
      }
    })
  } as never
  new AnalysisTasksTable((connection as { getDatabase: () => never }).getDatabase()).createTable()
  new AnalysisSessionsTable(
    (connection as { getDatabase: () => never }).getDatabase()
  ).createTable()
  new AnalysisToolOperationsTable(
    (connection as { getDatabase: () => never }).getDatabase()
  ).createTable()
  records.clear()
  createSession.mockClear()
  transport.block = false
  providerId = 'synthetic'
  modelId = 'fixture'
  setupServices()
  task = analysis.create('合成任务')
  file = path.join(directory, '销售 数据.xlsx')
  await writeFile(file, createAnalysisWorkbook())
  task = await analysis.addSources(task.id, [file])
  sessionId = await workspace.openChat(task.id)
})
afterEach(async () => {
  transport.block = false
  await tools?.dispose()
  db?.close()
  if (directory) {
    if (
      path.dirname(path.resolve(directory)) !== path.resolve(tmpdir()) ||
      !path.basename(directory).startsWith('semapath-workspace-')
    )
      throw Error('Unexpected test directory')
    await rm(directory, { recursive: true, force: true })
  }
})

it('quotes an actual saved Excel result and returns its original source metadata', async () => {
  const native = (connection as { getDatabase: () => never }).getDatabase()
  new AnalysisContextsTable(native).createTable()
  new AnalysisUiTable(native).createTable()
  const interaction = new AnalysisInteractionService({
    connection,
    analysis,
    workspace,
    retrieval: { targets: () => ({ targets: [], issues: [] }), use: vi.fn() } as never,
    message: async () => null
  })
  try {
    const runId = await calculate()
    const run = analysis.get(task.id).runs.find((run) => run.id === runId)!
    const context = await interaction.quote(
      task.id,
      { kind: 'run', runId, candidateHash: run.answer.candidateHash },
      `${run.values[0].value} ${run.plan.unit}`
    )
    expect((await interaction.read(task.id, context.id)).source).toMatchObject({
      kind: 'run',
      id: run.id,
      runs: [{ sourceId: run.source.id }]
    })
  } finally {
    await interaction.dispose()
  }
})

describe('Unified task persistence and metadata', () => {
  it('preserves a committed snapshot if a renderer notification fails', async () => {
    analysis.setWorkspace(workspace, () => {
      throw Error('synthetic closed renderer')
    })
    const payload = sqlSnapshot(
      {
        fields: [{ name: '金额', columnType: 246 }],
        rows: [['0.1'], ['0.2']],
        serverVersion: 'synthetic'
      } as never,
      { database: 'fixture', name: '合成连接' } as never,
      'SELECT amount FROM fixture',
      '合成快照'
    )
    const saved = await analysis.addSnapshot(task.id, payload.bytes, payload.origin)
    expect(saved.sources).toHaveLength(2)
    const source = analysis.get(task.id).sources.at(-1)!
    expect((await readFile(source.path)).length).toBeGreaterThan(0)
    expect(source.origin?.result?.rows).toEqual([
      ['1', '0.1'],
      ['2', '0.2']
    ])
  })
  it('keeps one conversation under concurrent opens and preserves existing task files across restart', async () => {
    const original = structuredClone(task)
    const ids = await Promise.all([
      workspace.openChat(task.id),
      workspace.openChat(task.id),
      workspace.openChat(task.id)
    ])
    expect(new Set(ids)).toEqual(new Set([sessionId]))
    expect(createSession).toHaveBeenCalledTimes(1)
    expect(workspace.ensureForSession(sessionId).id).toBe(task.id)
    setupServices()
    expect(await workspace.openChat(task.id)).toBe(sessionId)
    expect(analysis.get(task.id).sources).toEqual(original.sources)
    expect(analysis.get(task.id).createdAt).toBe(original.createdAt)
    expect(workspace.list().filter((e) => e.sessionId === sessionId)).toHaveLength(1)
  })
  it('adopts an existing conversation once and enforces both association uniqueness constraints', async () => {
    const other = await createSession('已有对话')
    const adopted = workspace.ensureForSession(other.id)
    expect(workspace.ensureForSession(other.id).id).toBe(adopted.id)
    const links = new AnalysisSessionsTable(
      (connection as { getDatabase: () => never }).getDatabase()
    )
    expect(() => links.link(task.id, other.id)).toThrow()
    expect(() => links.link(adopted.id, sessionId)).toThrow()
    expect(workspace.forSession(sessionId)).toBe(task.id)
  })
  it('shares rename, pin and workspace in both views, including tasks without a model conversation', async () => {
    await analysis.rename(task.id, '统一标题')
    expect(records.get(sessionId)!.title).toBe('统一标题')
    records.get(sessionId)!.title = '从聊天重命名'
    records.get(sessionId)!.projectDir = directory
    expect(analysis.get(task.id)).toMatchObject({ title: '从聊天重命名', projectDir: directory })
    await workspace.pin(task.id, true)
    expect(workspace.list().find((e) => e.taskId === task.id)?.isPinned).toBe(true)
    const unlinked = analysis.create('尚未配置模型')
    await workspace.pin(unlinked.id, true)
    await workspace.setProject(unlinked.id, directory)
    expect(workspace.list().find((e) => e.taskId === unlinked.id)).toMatchObject({
      sessionId: null,
      isPinned: true,
      projectDir: directory
    })
    expect(createSession).toHaveBeenCalledTimes(1)
  })
  it('preserves analysis when the associated conversation was deleted and never silently rebinds', async () => {
    records.delete(sessionId)
    expect(workspace.list().find((e) => e.taskId === task.id)?.sessionMissing).toBe(true)
    await expect(workspace.openChat(task.id)).rejects.toThrow('WORKSPACE_SESSION_MISSING')
    expect(analysis.get(task.id).sources).toHaveLength(1)
    expect(await tools.definitions(sessionId)).toEqual([])
    expect(createSession).toHaveBeenCalledTimes(1)
  })
})

describe('Analysis Agent contracts, evidence and publication', () => {
  it('pages original input cells without hiding the exact output or rewriting its saved evidence', async () => {
    const runId = await calculate()
    const page = await call('analysis_evidence', { runId, limit: 1, inputLimit: 1 })
    expect(page.data.values[0]).toMatchObject({ value: '0.3', inputCount: 2, hasMoreInputs: true })
    expect(page.data.values[0].inputs[0].cell).toBe('C2')
    const next = await call('analysis_evidence', {
      runId,
      valueId: page.data.values[0].id,
      inputOffset: 1,
      inputLimit: 1
    })
    expect(next.data.values[0].inputs[0].cell).toBe('C3')
    expect(next.data.values[0].hasMoreInputs).toBe(false)
    expect(analysis.get(task.id).runs[0].values[0].inputs).toHaveLength(2)
  })
  it.each([
    { kind: 'summary', queryKey: 'q1', chart: 'scatter' },
    { kind: 'comparison', queryKey: 'q1', baselineQueryKey: 'q1', chart: 'bar' },
    { kind: 'summary', queryKey: 'q1', baselineQueryKey: 'q1', chart: 'bar' }
  ])('rejects incompatible or misleading answer views: %o', async (view) => {
    const runId = await calculate()
    const result = await call('answer_submit', {
      question: '合成校验',
      runs: [{ key: 'q1', runId }],
      views: [view]
    })
    expect(result.data.error).toBe('INVALID_ANALYSIS_PLAN')
    expect(analysis.get(task.id).turns).toHaveLength(0)
  })
  it('executes real file arithmetic, requires an exact same-model candidate read, then freezes the published answer', async () => {
    const runId = await calculate()
    const evidence = await call('analysis_evidence', { runId })
    expect(evidence.data.values.map((v: { value: string }) => v.value)).toEqual(['0.3', '8'])
    expect(evidence.data.source.path).toBeUndefined()
    const candidate = await submit(runId)
    const premature = await call('answer_confirm', candidate)
    expect(premature.data.error).toBe('ANALYSIS_REVIEW_REQUIRED')
    const read = await call('analysis_get', { turnId: candidate.turnId })
    expect(read.data.runs[0].values[0].value).toBe('0.3')
    expect(read.data.candidate.review.confirmed).toBe(false)
    // A result that was executed but stripped by the context guard cannot be confirmed
    // from the hash in answer_submit. The caller must possess the delivered read receipt.
    expect((await call('answer_confirm', candidate)).data.error).toBe('ANALYSIS_REVIEW_REQUIRED')
    candidate.reviewReceiptId = read.data.reviewReceipt.id
    const confirmed = await call('answer_confirm', candidate)
    expect(confirmed.isError, JSON.stringify(confirmed.data)).toBe(false)
    expect(confirmed.data.published).toBe(true)
    const saved = analysis.get(task.id)
    const turn = saved.turns.at(-1)!
    const frozen = freezeReportAnswer(saved, {
      kind: 'turn',
      id: turn.id,
      candidateHash: turn.answer.candidateHash
    })
    expect(() => validateReportSnapshot(frozen)).not.toThrow()
    expect(frozen.runs[0].values[0].value).toBe('0.3')
    expect(JSON.stringify(frozen)).not.toContain(file)
  })
  it('replays a successful invocation without recalculating and rejects changed parameters under its ID', async () => {
    const id = 'stable-tool-call'
    const input = { kind: 'file', plan: plan() }
    const first = await call('datasource_query', input, { id })
    const replay = await call('datasource_query', { plan: plan(), kind: 'file' }, { id })
    expect(replay.data).toEqual(first.data)
    expect(analysis.get(task.id).runs).toHaveLength(1)
    await expect(
      call('datasource_query', { ...input, plan: { ...plan(), measure: 'D' } }, { id })
    ).rejects.toThrow('ANALYSIS_TOOL_REPLAY')
    expect(analysis.get(task.id).runs).toHaveLength(1)
  })
  it('records a cancelled report as a failed tool invocation rather than a generated deliverable', async () => {
    const candidate = await submit(await calculate())
    candidate.reviewReceiptId = (
      await call('analysis_get', { turnId: candidate.turnId })
    ).data.reviewReceipt.id
    expect((await call('answer_confirm', candidate)).data.published).toBe(true)
    setupServices({ create: async () => ({ id: randomUUID(), status: 'cancelled' }) })
    const result = await call('report_export', {
      turnId: candidate.turnId,
      options: { title: '合成取消验收', format: 'a4', locale: 'zh-CN' }
    })
    expect(result.isError).toBe(true)
    expect(result.data.error).toBe('REPORT_CANCELLED')
    expect(workspace.operations(task.id)).toContainEqual(
      expect.objectContaining({ tool: 'report_export', state: 'failed', error: 'REPORT_CANCELLED' })
    )
  })
  it('does not execute invalid arguments or allow another task’s run/candidate to be read', async () => {
    const runId = await calculate()
    const bad = await call('datasource_context', { taskId: task.id })
    expect(bad.data.error).toBe('ANALYSIS_TOOL_ARGUMENTS')
    const other = await createSession('另一任务')
    workspace.ensureForSession(other.id)
    expect((await call('analysis_evidence', { runId }, { session: other.id })).isError).toBe(true)
    expect((await call('analysis_get', { runId }, { session: other.id })).data.error).toBe(
      'NOT_FOUND'
    )
    const malformed = await call('datasource_query', {
      kind: 'file',
      plan: plan(),
      query: 'SELECT 1'
    })
    expect(malformed.data.error).toBe('ANALYSIS_TOOL_ARGUMENTS')
    expect(analysis.get(task.id).runs).toHaveLength(1)
  })
  it('keeps the candidate unpublished after source changes, despite a prior successful read', async () => {
    const candidate = await submit(await calculate())
    candidate.reviewReceiptId = (
      await call('analysis_get', { turnId: candidate.turnId })
    ).data.reviewReceipt.id
    await writeFile(file, Buffer.from('changed workbook'))
    const result = await call('answer_confirm', candidate)
    expect(result.data.error).toBe('SOURCE_CHANGED')
    expect(analysis.get(task.id).turns.at(-1)!.answer.status).toBe('draft')
    expect(analysis.get(task.id).turns.at(-1)!.review.confirmed).toBe(false)
  })
  it('requires a new candidate after the conversation model changes', async () => {
    const candidate = await submit(await calculate())
    candidate.reviewReceiptId = (
      await call('analysis_get', { turnId: candidate.turnId })
    ).data.reviewReceipt.id
    modelId = 'different-model'
    await call('analysis_get', { turnId: candidate.turnId })
    expect((await call('answer_confirm', candidate)).data.error).toBe('ANALYSIS_REVIEW_REQUIRED')
    expect(analysis.get(task.id).turns.at(-1)!.answer.status).toBe('draft')
  })
  it.each(['request', 'shutdown'] as const)(
    'cancels an in-flight calculation on %s without saving a run and releases the task mutation lock',
    async (reason) => {
      transport.block = true
      const controller = new AbortController()
      const pending = call(
        'datasource_query',
        { kind: 'file', plan: plan() },
        { signal: controller.signal }
      )
      await vi.waitFor(() =>
        expect(workspace.operations(task.id).some((r) => r.state === 'running')).toBe(true)
      )
      if (reason === 'shutdown') await tools.dispose()
      else controller.abort(new Error('synthetic cancellation'))
      expect((await pending).data.error).toBe('ANALYSIS_CANCELLED')
      expect(analysis.get(task.id).runs).toHaveLength(0)
      if (reason === 'shutdown') {
        await expect(call('datasource_context', {})).rejects.toThrow('ANALYSIS_CANCELLED')
        setupServices()
      }
      transport.block = false
      await calculate()
      expect(analysis.get(task.id).runs).toHaveLength(1)
    }
  )
  it('marks unknown outcomes interrupted on restart instead of replaying a possible committed operation', async () => {
    const id = 'interrupted-call'
    const key = createHash('sha256')
      .update(JSON.stringify({ messageId: 'synthetic-message', sessionId, toolCallId: id }))
      .digest('hex')
    // Use an actual previously saved operation so its normalized request digest is authoritative.
    await call('datasource_query', { kind: 'file', plan: plan() }, { id })
    const row = db
      .prepare(
        "SELECT id FROM replica_analysis_tool_operations WHERE tool='datasource_query' ORDER BY rowid DESC LIMIT 1"
      )
      .get() as { id: string }
    expect(row.id).toBe(key)
    db.prepare(
      "UPDATE replica_analysis_tool_operations SET state='running',result_json=NULL WHERE id=?"
    ).run(row.id)
    setupServices()
    tools.interruptOpen()
    await expect(call('datasource_query', { kind: 'file', plan: plan() }, { id })).rejects.toThrow(
      'ANALYSIS_TOOL_INTERRUPTED'
    )
    expect(analysis.get(task.id).runs).toHaveLength(1)
    expect(workspace.operations(task.id)[0].state).toBe('interrupted')
  })
  it('validates repair arguments without running a query and exposes only implemented tool contracts', async () => {
    const validation = await call('arguments_repair', {
      name: 'datasource_query',
      arguments: { kind: 'file', plan: plan() }
    })
    expect(validation.data).toMatchObject({ valid: true, executed: false })
    expect(analysis.get(task.id).runs).toHaveLength(0)
    const definitions = await tools.definitions(sessionId)
    expect(definitions).toHaveLength(14)
    expect(definitions.some((d) => d.function.name === 'analysis_update')).toBe(false)
    expect(
      definitions.every(
        (d) => d.server.name === 'semapath-analysis' && d.execution.mode === 'sequential'
      )
    ).toBe(true)
  })
})

describe('analysis task branches', () => {
  it('copies only the transcript prefix and its evidence into an independently linked task', async () => {
    const runId = await calculate()
    const targetId = randomUUID(),
      newMessageId = randomUUID(),
      userId = randomUUID(),
      newUserId = randomUUID()
    const ctxId = randomUUID()
    const source = analysis.get(task.id).sources[0]
    const contextTable = new AnalysisContextsTable(
      (connection as { getDatabase: () => never }).getDatabase()
    )
    contextTable.createTable()
    new AnalysisUiTable((connection as { getDatabase: () => never }).getDatabase()).createTable()
    contextTable.save({
      id: ctxId,
      taskId: task.id,
      kind: 'data',
      label: source.name,
      createdAt: new Date().toISOString(),
      reference: {
        id: 'a'.repeat(64),
        kind: 'source',
        label: source.name,
        description: source.name,
        version: source.sha256,
        selector: { kind: 'source', sourceId: source.id }
      }
    })
    const boundary = Date.now() + 100
    const fake = new Map<string, any>([
      [
        targetId,
        {
          id: targetId,
          sessionId,
          role: 'assistant',
          content: JSON.stringify([
            { type: 'content', content: '{\n  "taskId": "' + task.id + '"\n}' }
          ]),
          createdAt: boundary - 100,
          updatedAt: boundary
        }
      ],
      [
        userId,
        {
          id: userId,
          sessionId,
          role: 'user',
          content: JSON.stringify({
            text: '销售额',
            inlineItems: [{ type: 'analysis', offset: 0, contextId: ctxId, label: source.name }]
          }),
          createdAt: boundary - 100,
          updatedAt: boundary - 100
        }
      ]
    ])
    const child = await createSession('分支任务')
    const branch = new AnalysisBranchService({
      connection,
      workspace,
      transcript: {
        getMessage: (id) => fake.get(id),
        updateMessageContent: (id, content) => fake.set(id, { ...fake.get(id), content })
      } as never
    })
    const taskBefore = analysis.get(task.id)
    const future = structuredClone(taskBefore.runs[0])
    future.id = randomUUID()
    future.createdAt = new Date(boundary + 10000).toISOString()
    new AnalysisTasksTable((connection as { getDatabase: () => never }).getDatabase()).save({
      ...taskBefore,
      runs: [...taskBefore.runs, future]
    })
    branch.fork(
      sessionId,
      child.id,
      targetId,
      new Map([
        [userId, newUserId],
        [targetId, newMessageId]
      ])
    )
    const childId = workspace.forSession(child.id)!
    expect(childId).not.toBe(task.id)
    const childTask = analysis.get(childId)
    expect(childTask.runs.map((r) => r.id)).toEqual([runId])
    expect(childTask.branch).toMatchObject({ taskId: task.id, messageId: targetId })
    expect(childTask.sources[0].sha256).toBe(source.sha256)
    expect(JSON.parse(fake.get(newMessageId).content)[0].content).toBe(
      JSON.parse(fake.get(targetId).content)[0].content
    )
    const remapped = JSON.parse(fake.get(newUserId).content).inlineItems[0]
    expect(remapped.contextId).not.toBe(ctxId)
    expect(contextTable.get(childId, remapped.contextId)?.taskId).toBe(childId)
    expect(contextTable.get(childId, ctxId)).toBeNull()
    expect(workspace.operations(childId)).toEqual([])
    await analysis.rename(childId, '独立分支')
    expect(analysis.get(task.id).title).toBe(taskBefore.title)
    expect(analysis.get(task.id).runs.map((r) => r.id)).toContain(future.id)
  })
})
