import { createHash, randomUUID } from 'node:crypto'
import {
  DataReferenceSelectorSchema,
  TaskPanelStateSchema,
  GuideStateSchema,
  normalizeQuoteText,
  type AnalysisContext,
  type DataReference,
  type DataReferenceSelector,
  type QuoteOrigin,
  type TaskPanelState,
  type GuideState
} from '@shared/analysisInteraction'
import type { ChatMessageRecord, SendMessageInput } from '@shared/types/agent-interface'
import type { DatabaseConnectionProvider } from '@/data/databaseConnection'
import type { AnalysisService } from './service'
import type { AnalysisWorkspaceService } from './workspaceService'
import type { RetrievalGateway } from './retrieval/types'
import type { PbiSchema } from '@shared/analysisPowerBi'
import { AnalysisContextsTable, AnalysisUiTable } from './data/analysisInteraction'
import { AnalysisError } from './errors'

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const textValues = (value: unknown): string[] => {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(textValues)
  if (value && typeof value === 'object')
    return Object.entries(value)
      .filter(([key]) => !['path', 'inputs', 'origin', 'execution'].includes(key))
      .flatMap(([, item]) => textValues(item))
  return []
}

export class AnalysisInteractionService {
  private owner = -1000000
  private readonly lifetime = new AbortController()
  private readonly jobs = new Set<Promise<unknown>>()
  constructor(
    private readonly deps: {
      connection: DatabaseConnectionProvider
      analysis: AnalysisService
      workspace: AnalysisWorkspaceService
      retrieval: RetrievalGateway
      message: (id: string) => Promise<ChatMessageRecord | null>
    }
  ) {}
  private assertOpen() {
    this.lifetime.signal.throwIfAborted()
  }
  private get contexts() {
    this.assertOpen()
    return new AnalysisContextsTable(this.deps.connection.getDatabase())
  }
  private get ui() {
    this.assertOpen()
    return new AnalysisUiTable(this.deps.connection.getDatabase())
  }
  async dispose() {
    this.lifetime.abort(new AnalysisError('ANALYSIS_CANCELLED'))
    await Promise.allSettled(this.jobs)
  }
  panels(taskId: string): TaskPanelState {
    this.deps.analysis.get(taskId)
    const parsed = TaskPanelStateSchema.safeParse(this.ui.get('task:' + taskId))
    return parsed.success ? parsed.data : TaskPanelStateSchema.parse({})
  }
  savePanels(taskId: string, patch: Partial<TaskPanelState>) {
    const state = TaskPanelStateSchema.parse({ ...this.panels(taskId), ...patch })
    this.ui.save('task:' + taskId, state)
    return state
  }
  guide(): GuideState {
    const parsed = GuideStateSchema.safeParse(this.ui.get('guide'))
    return parsed.success ? parsed.data : GuideStateSchema.parse({})
  }
  saveGuide(patch: Partial<GuideState>) {
    const state = GuideStateSchema.parse({ ...this.guide(), ...patch })
    this.ui.save('guide', state)
    return state
  }
  private item(
    taskId: string,
    selector: DataReferenceSelector,
    version: string,
    label: string,
    description: string
  ): DataReference {
    const normalized = DataReferenceSelectorSchema.parse(selector)
    return {
      id: sha({ taskId, selector: normalized }),
      kind: selector.kind,
      label,
      description,
      version,
      selector: normalized
    }
  }
  async catalog(
    taskId: string,
    query = '',
    selector?: DataReferenceSelector,
    parent?: AbortSignal
  ) {
    this.assertOpen()
    const signal = AbortSignal.any([
      this.lifetime.signal,
      AbortSignal.timeout(30000),
      ...(parent ? [parent] : [])
    ])
    const job = this.buildCatalog(taskId, query, selector, signal)
    this.jobs.add(job)
    try {
      return await job
    } finally {
      this.jobs.delete(job)
    }
  }
  private async buildCatalog(
    taskId: string,
    query: string,
    selector: DataReferenceSelector | undefined,
    signal: AbortSignal
  ) {
    const task = this.deps.analysis.get(taskId)
    const items: DataReference[] = []
    const issues: { source: string; code: string }[] = []
    for (const source of task.sources) {
      if (selector?.targetId || (selector?.sourceId && selector.sourceId !== source.id)) continue
      try {
        const panels = this.panels(taskId)
        for (const sheet of source.sheets) {
          if (selector?.sheet && selector.sheet !== sheet.name) continue
          signal.throwIfAborted()
          const headerRow =
            selector?.headerRow ??
            (panels.sourceId === source.id && panels.sheet === sheet.name
              ? panels.headerRow
              : sheet.firstRow)
          const preview = await this.deps.analysis.preview({
            taskId,
            sourceId: source.id,
            sheet: sheet.name,
            headerRow,
            page: 1
          })
          signal.throwIfAborted()
          if (preview.changed) throw new AnalysisError('ANALYSIS_REFERENCE_STALE')
          const version = sha({
            sha256: source.sha256,
            sheet: sheet.name,
            headerRow,
            columns: preview.columns
          })
          const base = { sourceId: source.id, sheet: sheet.name, headerRow }
          if (!items.some((item) => item.selector.sourceId === source.id && item.kind === 'source'))
            items.push(
              this.item(
                taskId,
                { kind: 'source', sourceId: source.id },
                source.sha256,
                source.name,
                source.name
              )
            )
          items.push(
            this.item(taskId, { kind: 'table', ...base }, version, sheet.name, source.name)
          )
          for (const column of preview.columns)
            items.push(
              this.item(
                taskId,
                { kind: 'column', ...base, column: column.key },
                version,
                column.label,
                `${source.name} › ${sheet.name} · ${column.key}`
              )
            )
        }
      } catch (error) {
        signal.throwIfAborted()
        issues.push({
          source: source.name,
          code: error instanceof AnalysisError ? error.code : 'ANALYSIS_REFERENCE_UNAVAILABLE'
        })
      }
    }
    const connected = this.deps.retrieval.targets(taskId)
    issues.push(...connected.issues.map((code) => ({ source: 'connections', code })))
    for (const target of connected.targets) {
      if (selector?.sourceId || (selector?.targetId && selector.targetId !== target.id)) continue
      try {
        const transport =
          selector?.transport ??
          (target.kind === 'powerbi' && target.powerBiKind === 'local' ? 'xmla' : 'rest')
        await this.deps.retrieval.use(
          taskId,
          { targetIds: [target.id], sourceIds: [], transport },
          randomUUID(),
          this.owner--,
          signal,
          async (lease) => {
            const catalog = lease.catalogs[0]
            if (!catalog || catalog.issue) throw new AnalysisError('ANALYSIS_REFERENCE_UNAVAILABLE')
            lease.validate()
            const base = { targetId: target.id, transport }
            items.push(
              this.item(
                taskId,
                { kind: 'source', ...base },
                catalog.structureSha256,
                target.label,
                target.detail
              )
            )
            const tables =
              target.kind === 'mysql'
                ? (catalog.structure as {
                    name: string
                    columns: { name: string; type: string }[]
                  }[])
                : (catalog.structure as PbiSchema).tables
            for (const table of tables) {
              if (selector?.table && selector.table !== table.name) continue
              items.push(
                this.item(
                  taskId,
                  { kind: 'table', ...base, table: table.name },
                  catalog.structureSha256,
                  table.name,
                  target.label
                )
              )
              for (const column of table.columns)
                items.push(
                  this.item(
                    taskId,
                    { kind: 'column', ...base, table: table.name, column: column.name },
                    catalog.structureSha256,
                    column.name,
                    `${target.label} › ${table.name} · ${column.type}`
                  )
                )
              if ('measures' in table && Array.isArray(table.measures))
                for (const measure of table.measures as { name: string }[])
                  items.push(
                    this.item(
                      taskId,
                      { kind: 'measure', ...base, table: table.name, measure: measure.name },
                      catalog.structureSha256,
                      measure.name,
                      `${target.label} › ${table.name}`
                    )
                  )
            }
          }
        )
      } catch (error) {
        signal.throwIfAborted()
        issues.push({
          source: target.label,
          code: error instanceof AnalysisError ? error.code : 'ANALYSIS_REFERENCE_UNAVAILABLE'
        })
      }
    }
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    const selectedId = selector
      ? sha({ taskId, selector: DataReferenceSelectorSchema.parse(selector) })
      : null
    const filtered = items.filter(
      (item) =>
        (!selectedId || item.id === selectedId) &&
        words.every((word) =>
          `${item.label} ${item.description}`.toLocaleLowerCase().includes(word)
        )
    )
    signal.throwIfAborted()
    return {
      items: filtered.slice(0, 80),
      total: filtered.length,
      hasMore: filtered.length > 80,
      issues
    }
  }
  private async resolveReference(taskId: string, reference: DataReference, signal?: AbortSignal) {
    const catalog = await this.catalog(taskId, '', reference.selector, signal)
    const current = catalog.items.find((item) => item.id === reference.id)
    if (!current && catalog.issues.some((issue) => issue.code !== 'ANALYSIS_REFERENCE_STALE'))
      throw new AnalysisError('ANALYSIS_REFERENCE_UNAVAILABLE')
    if (!current || current.version !== reference.version)
      throw new AnalysisError('ANALYSIS_REFERENCE_STALE')
    return current
  }
  async reference(taskId: string, reference: DataReference) {
    const current = await this.resolveReference(taskId, reference)
    const context: AnalysisContext = {
      id: randomUUID(),
      taskId,
      kind: 'data',
      label: current.label,
      createdAt: new Date().toISOString(),
      reference: current
    }
    this.contexts.save(context)
    return context
  }
  private async quoteSource(taskId: string, origin: QuoteOrigin, requireVersion = true) {
    this.assertOpen()
    const task = this.deps.analysis.get(taskId)
    if (origin.kind === 'message') {
      const record = await this.deps.message(origin.messageId)
      if (
        !record ||
        record.sessionId !== this.deps.workspace.metadata(taskId)?.sessionId ||
        record.role !== 'assistant'
      )
        return null
      let blocks: { type: string; content?: string }[]
      try {
        blocks = JSON.parse(record.content)
        if (!Array.isArray(blocks)) return null
      } catch {
        return null
      }
      const body = blocks
        .filter((b) => b.type === 'content')
        .map((b) => b.content ?? '')
        .join('\n')
      return {
        corpus: normalizeQuoteText(body),
        sourceHash: sha(body),
        source: { kind: 'message', messageId: record.id, updatedAt: record.updatedAt }
      }
    }
    const turn =
      origin.kind === 'turn' ? task.turns.find((item) => item.id === origin.turnId) : null
    const run = origin.kind === 'run' ? task.runs.find((item) => item.id === origin.runId) : null
    const answer = turn ?? run
    if (!answer || (requireVersion && answer.answer.candidateHash !== origin.candidateHash))
      return null
    const runs = turn
      ? turn.queryRuns.flatMap((ref) => {
          const found = task.runs.find((r) => r.id === ref.runId)
          return found ? [found] : []
        })
      : [run!]
    const extra = runs.flatMap((r) =>
      r.values.flatMap((v) => [
        `${v.category} ${v.value} ${v.unit ?? r.plan.unit}`,
        `${v.category}${v.value} ${v.unit ?? r.plan.unit}`,
        `${v.category} ${v.value}`,
        `${v.category}${v.value}`,
        `${v.value} ${v.unit ?? r.plan.unit}`,
        `${v.value}${v.unit ?? r.plan.unit}`,
        String(v.value)
      ])
    )
    return {
      corpus: normalizeQuoteText([...textValues(answer), ...extra].join('\n')),
      sourceHash: answer.answer.candidateHash,
      source: {
        kind: origin.kind,
        id: answer.id,
        question: turn?.question ?? run?.plan.question,
        createdAt: answer.createdAt,
        runs: runs.map((r) => ({
          id: r.id,
          sourceId: r.source.id,
          sourceName: r.source.name,
          sha256: r.source.sha256,
          sheet: r.plan.sheet,
          filters: r.plan.filters,
          unit: r.plan.unit,
          period: r.plan.period
        }))
      }
    }
  }
  async quote(taskId: string, origin: QuoteOrigin, text: string) {
    const normalized = normalizeQuoteText(text)
    const source = await this.quoteSource(taskId, origin)
    const start = source?.corpus.indexOf(normalized) ?? -1
    if (!normalized || text.length > 2000 || !source || start < 0)
      throw new AnalysisError('ANALYSIS_QUOTE_INVALID')
    const context: AnalysisContext = {
      id: randomUUID(),
      taskId,
      kind: 'quote',
      label: text.trim(),
      createdAt: new Date().toISOString(),
      quote: {
        text: text.trim(),
        origin,
        sourceHash: source.sourceHash,
        start,
        end: start + normalized.length
      }
    }
    this.contexts.save(context)
    return context
  }
  async read(taskId: string, contextId: string, signal?: AbortSignal, strict = true) {
    this.deps.analysis.get(taskId)
    const context = this.contexts.get(taskId, contextId)
    if (!context) throw new AnalysisError('ANALYSIS_CONTEXT_NOT_FOUND')
    if (context.reference) {
      try {
        await this.resolveReference(taskId, context.reference, signal)
      } catch (error) {
        if (strict || !(error instanceof AnalysisError)) throw error
        const selector = context.reference.selector
        const task = this.deps.analysis.get(taskId)
        const removed = selector.sourceId
          ? !task.sources.some((source) => source.id === selector.sourceId)
          : !this.deps.retrieval
              .targets(taskId)
              .targets.some((target) => target.id === selector.targetId)
        return {
          context,
          status:
            error.code === 'ANALYSIS_REFERENCE_UNAVAILABLE'
              ? ('unavailable' as const)
              : removed
                ? ('missing' as const)
                : ('changed' as const)
        }
      }
      return {
        context,
        status: 'current' as const,
        source: { ...context.reference.selector, version: context.reference.version }
      }
    }
    const source = await this.quoteSource(taskId, context.quote!.origin, false)
    return {
      context,
      status: !source
        ? ('missing' as const)
        : source.sourceHash === context.quote!.sourceHash
          ? ('current' as const)
          : ('changed' as const),
      ...(source ? { source: source.source } : {})
    }
  }
  async validateInput(sessionId: string, input: SendMessageInput, signal?: AbortSignal) {
    const references = input.inlineItems?.filter((item) => item.type === 'analysis') ?? []
    if (!references.length) return
    if (references.length > 20) throw new AnalysisError('ANALYSIS_CONTEXT_LIMIT')
    const taskId = this.deps.workspace.forSession(sessionId)
    if (!taskId) throw new AnalysisError('ANALYSIS_CONTEXT_NOT_FOUND')
    for (const item of references) {
      signal?.throwIfAborted()
      if (item.offset > input.text.length) throw new AnalysisError('ANALYSIS_CONTEXT_NOT_FOUND')
      const view = await this.read(taskId, item.contextId, signal)
      item.label = view.context.label
    }
  }
}
