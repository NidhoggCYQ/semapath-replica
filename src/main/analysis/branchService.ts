import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseConnectionProvider } from '@/data/databaseConnection'
import type { SessionTranscript } from '@/session/data/transcript'
import type { AnalysisWorkspaceService } from './workspaceService'
import { AnalysisTasksTable } from './data/analysisTasks'
import { AnalysisSessionsTable } from './data/analysisWorkspace'
import { AnalysisContextsTable, AnalysisUiTable } from './data/analysisInteraction'
import { TaskPanelStateSchema } from '@shared/analysisInteraction'
import type { AnalysisContext } from '@shared/analysisInteraction'
import { extractUserMessageInput } from '@/session/data/userMessageContent'
import { AnalysisError } from './errors'

/** Called inside the transcript fork transaction. No model calls or live data reads. */
export class AnalysisBranchService {
  constructor(
    private readonly deps: {
      connection: DatabaseConnectionProvider
      workspace: Pick<AnalysisWorkspaceService, 'forSession'>
      transcript: Pick<SessionTranscript, 'getMessage' | 'updateMessageContent'>
    }
  ) {}
  fork(
    sourceSessionId: string,
    targetSessionId: string,
    targetMessageId: string,
    messageIds: Map<string, string>
  ) {
    const sourceTaskId = this.deps.workspace.forSession(sourceSessionId)
    if (!sourceTaskId) return
    const db = this.deps.connection.getDatabase()
    const tasks = new AnalysisTasksTable(db)
    const contexts = new AnalysisContextsTable(db)
    const parent = tasks.get(sourceTaskId)
    const boundary = this.deps.transcript.getMessage(targetMessageId)
    if (!boundary || boundary.sessionId !== sourceSessionId)
      throw new AnalysisError('WORKSPACE_CONFLICT')
    const copied = [...messageIds.keys()]
      .map((id) => this.deps.transcript.getMessage(id))
      .filter((m) => !!m)
    const cutoff = boundary.role === 'user' ? boundary.createdAt : boundary.updatedAt
    const before = (timestamp: string) =>
      Number.isFinite(Date.parse(timestamp)) && Date.parse(timestamp) <= cutoff
    const referenced = new Set<string>()
    for (const message of copied) {
      if (message.role === 'user')
        for (const item of extractUserMessageInput(message.content).inlineItems ?? [])
          if (item.type === 'analysis') referenced.add(item.contextId)
    }
    const inherited: AnalysisContext[] = [...referenced].map((id) => {
      const context = contexts.get(sourceTaskId, id)
      if (!context) throw new AnalysisError('ANALYSIS_CONTEXT_NOT_FOUND')
      return context
    })
    const includeTurns = new Set(parent.turns.filter((t) => before(t.createdAt)).map((t) => t.id))
    const includeRuns = new Set(parent.runs.filter((r) => before(r.createdAt)).map((r) => r.id))
    for (const context of inherited) {
      if (context.quote?.origin.kind === 'run') includeRuns.add(context.quote.origin.runId)
      if (context.quote?.origin.kind === 'turn') includeTurns.add(context.quote.origin.turnId)
    }
    // Follow immutable ancestry so a copied drill-down retains its own earlier evidence.
    for (let changed = true; changed; ) {
      changed = false
      for (const turn of parent.turns.filter((t) => includeTurns.has(t.id))) {
        for (const query of turn.queryRuns) includeRuns.add(query.runId)
        const ancestor = turn.context?.parentTurnId
        if (ancestor && !includeTurns.has(ancestor)) {
          includeTurns.add(ancestor)
          changed = true
        }
      }
    }
    const runs = parent.runs.filter((r) => includeRuns.has(r.id))
    const turns = parent.turns.filter((t) => includeTurns.has(t.id))
    const sources = new Map(parent.sources.filter((s) => before(s.boundAt)).map((s) => [s.id, s]))
    for (const run of runs) sources.set(run.source.id, run.source)
    for (const context of inherited) {
      const id = context.reference?.selector.sourceId
      const source = parent.sources.find((s) => s.id === id)
      if (source && !sources.has(source.id)) sources.set(source.id, source)
    }
    const now = new Date().toISOString()
    const taskId = randomUUID()
    tasks.save({
      ...structuredClone(parent),
      id: taskId,
      title: parent.title,
      createdAt: now,
      updatedAt: now,
      isPinned: false,
      sources: [...sources.values()],
      runs,
      turns,
      branch: {
        taskId: sourceTaskId,
        sessionId: sourceSessionId,
        messageId: targetMessageId,
        createdAt: now,
        requiresReconnection:
          inherited.some((c) => !!c.reference?.selector.targetId) ||
          [...sources.values()].some(
            (s) => !!s.origin && ['mysql', 'powerbi'].includes(s.origin.kind)
          )
      }
    })
    new AnalysisSessionsTable(db).link(taskId, targetSessionId)
    const ui = new AnalysisUiTable(db)
    const panel = TaskPanelStateSchema.safeParse(ui.get('task:' + sourceTaskId))
    if (panel.success) {
      const state = panel.data
      state.tab = 'conversation'
      state.sidepanel = state.sidepanel ? { ...state.sidepanel, open: false } : undefined
      if (state.sourceId && !sources.has(state.sourceId)) state.sourceId = null
      if (state.runId && !includeRuns.has(state.runId)) state.runId = null
      if (state.turnId && !includeTurns.has(state.turnId)) state.turnId = null
      if (
        state.reportTarget &&
        !(state.reportTarget.kind === 'run' ? includeRuns : includeTurns).has(state.reportTarget.id)
      )
        state.reportTarget = null
      if (state.selectedDerived && !includeTurns.has(state.selectedDerived.turnId))
        state.selectedDerived = null
      ui.save('task:' + taskId, state)
    }
    const replacements = new Map(messageIds)
    replacements.set(sourceTaskId, taskId)
    for (const context of inherited) replacements.set(context.id, randomUUID())
    for (const context of inherited) {
      const next = structuredClone(context)
      next.id = replacements.get(context.id)!
      next.taskId = taskId
      if (next.reference)
        next.reference.id = createHash('sha256')
          .update(JSON.stringify({ taskId, selector: next.reference.selector }))
          .digest('hex')
      if (next.quote?.origin.kind === 'message') {
        const id = messageIds.get(next.quote.origin.messageId)
        // A quote may already point at a message deleted before the branch. Preserve its
        // historical provenance; strict ownership checks will show it as unavailable.
        if (id) next.quote.origin.messageId = id
      }
      contexts.save(next)
    }
    function remap(value: unknown): unknown {
      if (typeof value === 'string') {
        if (replacements.has(value)) return replacements.get(value)
        if (value.startsWith('{') || value.startsWith('[')) {
          try {
            const parsed = JSON.parse(value)
            const next = remap(parsed)
            return JSON.stringify(next) === JSON.stringify(parsed) ? value : JSON.stringify(next)
          } catch {
            return value
          }
        }
        return value
      }
      if (Array.isArray(value)) return value.map(remap)
      if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item)]))
      return value
    }
    for (const [oldId, newId] of messageIds) {
      const original = this.deps.transcript.getMessage(oldId)!
      try {
        const parsed = JSON.parse(original.content)
        const next = (
          original.role === 'user' && typeof parsed === 'string' ? parsed : remap(parsed)
        ) as typeof parsed
        // Public text is historical evidence, even when the user or assistant wrote
        // formatted JSON or a literal ID. Only structured references are re-keyed.
        if (original.role === 'user' && parsed && typeof parsed === 'object') {
          next.text = parsed.text
          next.content = parsed.content
        }
        if (original.role === 'assistant' && Array.isArray(parsed))
          for (let i = 0; i < parsed.length; i++)
            if (['content', 'reasoning_content', 'error'].includes(parsed[i]?.type))
              next[i] = parsed[i]
        this.deps.transcript.updateMessageContent(newId, JSON.stringify(next))
      } catch (error) {
        if (error instanceof SyntaxError) continue
        throw error
      }
    }
  }
}
