import type { DatabaseConnectionProvider } from '@/data/databaseConnection'
import type { SessionRecord } from '@shared/types/agent-interface'
import type { AnalysisWorkspaceEntry } from '@shared/analysisWorkspace'
import type { AnalysisService } from './service'
import { AnalysisSessionsTable, AnalysisToolOperationsTable } from './data/analysisWorkspace'
import { AnalysisError } from './errors'

export interface AnalysisWorkspaceSessionPort {
  get(id: string): SessionRecord | null
  list(): SessionRecord[]
  create(title: string, projectDir?: string | null): Promise<{ id: string }>
  rename(id: string, title: string): Promise<unknown>
  pin(id: string, pinned: boolean): Promise<unknown>
  project(id: string, projectDir: string | null): Promise<unknown>
}

export class AnalysisWorkspaceService {
  private readonly opening = new Map<string, Promise<string>>()
  constructor(
    private readonly connection: DatabaseConnectionProvider,
    private readonly analysis: AnalysisService,
    private readonly sessions: AnalysisWorkspaceSessionPort
  ) {}
  private get links() {
    return new AnalysisSessionsTable(this.connection.getDatabase())
  }
  metadata(taskId: string) {
    const link = this.links.forTask(taskId)
    if (!link) return null
    const session = this.sessions.get(link.sessionId)
    return session
      ? {
          title: session.title,
          sessionId: session.id,
          projectDir: session.projectDir,
          isPinned: session.isPinned
        }
      : null
  }
  async rename(taskId: string, title: string) {
    const link = this.links.forTask(taskId)
    if (link && this.sessions.get(link.sessionId)) await this.sessions.rename(link.sessionId, title)
  }
  async configure(taskId: string, input: { projectDir?: string | null; isPinned?: boolean }) {
    const link = this.links.forTask(taskId)
    if (!link || !this.sessions.get(link.sessionId)) return
    if (input.projectDir !== undefined)
      await this.sessions.project(link.sessionId, input.projectDir)
    if (input.isPinned !== undefined) await this.sessions.pin(link.sessionId, input.isPinned)
  }
  forSession(sessionId: string): string | null {
    if (!this.sessions.get(sessionId)) return null
    return this.links.forSession(sessionId)?.taskId ?? null
  }
  isRegularSession(sessionId: string) {
    return this.sessions.get(sessionId)?.sessionKind === 'regular'
  }
  ensureForSession(sessionId: string) {
    const session = this.sessions.get(sessionId)
    if (!session || session.sessionKind !== 'regular')
      throw new AnalysisError('WORKSPACE_SESSION_MISSING')
    const link = this.links.forSession(sessionId)
    if (link) return this.analysis.get(link.taskId)
    return this.connection.getDatabase().transaction(() => {
      const task = this.analysis.create(session.title)
      this.links.link(task.id, sessionId)
      return task
    })()
  }
  async openChat(taskId: string): Promise<string> {
    const existing = this.opening.get(taskId)
    if (existing) return existing
    const work = this.open(taskId).finally(() => this.opening.delete(taskId))
    this.opening.set(taskId, work)
    return work
  }
  private async open(taskId: string) {
    const task = this.analysis.get(taskId)
    const link = this.links.forTask(taskId)
    if (link) {
      if (!this.sessions.get(link.sessionId)) throw new AnalysisError('WORKSPACE_SESSION_MISSING')
      return link.sessionId
    }
    const session = await this.sessions.create(task.title, task.projectDir)
    // The task lock and UNIQUE constraints keep one stable association. A failed link never
    // silently attaches a different existing conversation or copies historic analysis data.
    this.analysis.get(taskId)
    this.links.link(taskId, session.id)
    if (task.isPinned) await this.sessions.pin(session.id, true)
    return session.id
  }
  async pin(taskId: string, pinned: boolean) {
    await this.analysis.configureTask(taskId, { isPinned: pinned })
  }
  setProject(taskId: string, projectDir: string | null) {
    return this.analysis.configureTask(taskId, { projectDir })
  }
  list(): AnalysisWorkspaceEntry[] {
    const sessions = new Map(
      this.sessions
        .list()
        .filter((s) => s.sessionKind === 'regular' && !s.isDraft)
        .map((s) => [s.id, s])
    )
    const links = new Map(this.links.list().map((l) => [l.taskId, l]))
    const linked = new Set<string>()
    const entries: AnalysisWorkspaceEntry[] = this.analysis.list().map((task) => {
      const link = links.get(task.id)
      const session = link ? this.sessions.get(link.sessionId) : null
      if (link) linked.add(link.sessionId)
      return {
        id: task.id,
        taskId: task.id,
        sessionId: link?.sessionId ?? null,
        title: session?.title ?? task.title,
        projectDir: session?.projectDir ?? task.projectDir ?? null,
        isPinned: session?.isPinned ?? task.isPinned ?? false,
        sessionMissing: !!link && !session,
        sourceCount: task.sourceCount,
        runCount: task.runCount,
        updatedAt:
          session && session.updatedAt > Date.parse(task.updatedAt)
            ? new Date(session.updatedAt).toISOString()
            : task.updatedAt
      }
    })
    for (const session of sessions.values())
      if (!linked.has(session.id))
        entries.push({
          id: `session:${session.id}`,
          taskId: null,
          sessionId: session.id,
          title: session.title,
          projectDir: session.projectDir,
          isPinned: session.isPinned,
          sessionMissing: false,
          sourceCount: 0,
          runCount: 0,
          updatedAt: new Date(session.updatedAt).toISOString()
        })
    return entries.sort(
      (a, b) =>
        Number(b.isPinned) - Number(a.isPinned) ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.id.localeCompare(b.id)
    )
  }
  operations(taskId: string) {
    this.analysis.get(taskId)
    return new AnalysisToolOperationsTable(this.connection.getDatabase()).list(taskId)
  }
}
