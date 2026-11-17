import { createHash } from 'node:crypto'
import { analysisAncestors } from '../framework'
import type { AnalysisTask } from '@shared/analysis'
import {
  ReportSnapshotSchema,
  type ReportAnswer,
  type ReportSnapshot,
  type ReportRun
} from '@shared/analysisReport'
import { candidateHash, naturalTurnHash } from '../service'
import { AnalysisError } from '../errors'
import { decimal, compare } from '../decimal'

export const reportHash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex')
export function freezeReportAnswer(task: AnalysisTask, reference: ReportAnswer): ReportSnapshot {
  const turn =
    reference.kind === 'turn' ? task.turns.find((turn) => turn.id === reference.id) : undefined
  const single =
    reference.kind === 'run' ? task.runs.find((run) => run.id === reference.id) : undefined
  const answer = turn ?? single
  if (!answer) throw new AnalysisError('NOT_FOUND')
  if (
    answer.answer.status !== 'published' ||
    !answer.answer.publishedAt ||
    (turn && (turn.state !== 'answered' || !turn.review.confirmed || !turn.plan))
  )
    throw new AnalysisError('REPORT_NOT_PUBLISHED')
  const hash = turn ? naturalTurnHash(turn, task) : candidateHash(single!)
  if (hash !== reference.candidateHash || hash !== answer.answer.candidateHash)
    throw new AnalysisError('INVALID_DRAFT')
  const runs = turn
    ? turn.queryRuns.map((reference) => task.runs.find((run) => run.id === reference.runId))
    : [single]
  if (
    runs.some(
      (run) =>
        !run || run.answer.status !== 'published' || candidateHash(run) !== run.answer.candidateHash
    )
  )
    throw new AnalysisError('INVALID_DRAFT')
  const validatedRuns = runs.map((run) => {
    const { path: _path, boundAt: _boundAt, ...source } = run!.source
    return { ...run!, source }
  })
  const runFor = (key: string) => {
    const run = turn?.queryRuns.find((reference) => reference.key === key)
    if (!run) throw new AnalysisError('INVALID_DRAFT')
    return run.runId
  }
  const snapshot = ReportSnapshotSchema.parse({
    version: 1,
    frozenAt: new Date().toISOString(),
    task: { id: task.id, title: task.title },
    answer: {
      ...reference,
      question: turn?.question ?? single!.plan.question,
      publishedAt: answer.answer.publishedAt,
      ...(turn ? { model: turn.model } : {})
    },
    runs: validatedRuns,
    views: turn
      ? turn.plan!.views.map(({ queryKey, baselineQueryKey, ...view }) => ({
          ...view,
          runId: runFor(queryKey),
          ...(baselineQueryKey ? { baselineRunId: runFor(baselineQueryKey) } : {})
        }))
      : [
          {
            kind: single!.study ? 'method' : 'summary',
            runId: single!.id,
            chart: single!.chart.kind
          }
        ],
    derived: turn?.derived ?? [],
    ...(turn?.framework ? { framework: turn.framework, queryRuns: turn.queryRuns } : {}),
    ...(turn?.context
      ? {
          context: turn.context,
          lineage: analysisAncestors(task, turn).map((parent) => ({
            id: parent.id,
            question: parent.question,
            candidateHash: parent.answer.candidateHash,
            status: parent.answer.status,
            ...(parent.context ? { context: parent.context } : {})
          }))
        }
      : {})
  })
  validateReportSnapshot(snapshot)
  return snapshot
}
export function validateReportSnapshot(snapshot: ReportSnapshot): void {
  const runIds = new Set(snapshot.runs.map((run) => run.id))
  if (runIds.size !== snapshot.runs.length) throw new AnalysisError('REPORT_INVALID_SNAPSHOT')
  for (const view of snapshot.views) {
    const run = snapshot.runs.find((run) => run.id === view.runId)
    if (
      !run ||
      (view.kind === 'method') !== !!run.study ||
      (run.study && !run.study.charts.some((chart) => chart.kind === view.chart)) ||
      (!run.study && !['bar', 'line', 'table'].includes(view.chart)) ||
      (view.kind === 'comparison' && !runIds.has(view.baselineRunId ?? ''))
    )
      throw new AnalysisError('REPORT_INVALID_SNAPSHOT')
  }
  for (const run of snapshot.runs) {
    validateDatasetEvidence(run)
    if (!run.study) continue
    const ids = new Set(run.values.map((value) => value.id))
    const referenced = [
      ...run.study.statistics,
      ...run.study.rows.flatMap((row) => Object.values(row.values)),
      ...run.study.charts.flatMap((chart) => [
        chart.xThresholdId,
        chart.yThresholdId,
        ...chart.points.flatMap((point) => [
          point.valueId,
          point.xId,
          point.yId,
          point.sizeId,
          point.lowerId,
          point.q1Id,
          point.medianId,
          point.q3Id,
          point.upperId,
          point.startId,
          point.endId,
          ...(point.outlierIds ?? [])
        ])
      ])
    ].filter((id): id is string => !!id)
    if (
      ids.size !== run.values.length ||
      referenced.some((id) => !ids.has(id)) ||
      run.study.method !== run.plan.study?.method
    )
      throw new AnalysisError('REPORT_INVALID_SNAPSHOT')
  }
  for (const fact of snapshot.derived) {
    if (
      fact.viewIndex < 0 ||
      fact.viewIndex >= snapshot.views.length ||
      fact.inputs.some(
        (input) =>
          !snapshot.runs.some(
            (run) =>
              run.id === input.runId &&
              run.values.some((value) => value.id === input.valueId && value.value === input.value)
          )
      )
    )
      throw new AnalysisError('REPORT_INVALID_SNAPSHOT')
  }
  if (snapshot.framework) {
    const questions = snapshot.framework.questions
    const queries = snapshot.queryRuns ?? []
    if (
      new Set(questions.map((q) => q.id)).size !== questions.length ||
      new Set(queries.map((q) => q.key)).size !== queries.length ||
      queries.some((query) => !runIds.has(query.runId)) ||
      questions.some(
        (q) =>
          q.queryKeys.some((key) => !queries.some((query) => query.key === key)) ||
          (['supported', 'refuted'].includes(q.judgment) && !q.evidence.length) ||
          q.evidence.some(
            (reference) =>
              !snapshot.runs.some(
                (run) =>
                  run.id === reference.runId &&
                  run.values.some((value) => value.id === reference.valueId)
              )
          ) ||
          q.evidence.some(
            (reference) =>
              !queries.some(
                (query) => query.runId === reference.runId && q.queryKeys.includes(query.key)
              )
          )
      )
    )
      throw new AnalysisError('REPORT_INVALID_SNAPSHOT')
  }
  if (snapshot.context) {
    const lineage = snapshot.lineage ?? []
    const all = [
      ...lineage,
      {
        id: snapshot.answer.id,
        context: snapshot.context,
        candidateHash: snapshot.answer.candidateHash
      }
    ]
    if (
      lineage.length !== snapshot.context.depth ||
      new Set(all.map((item) => item.id)).size !== all.length ||
      all.some((item, index) =>
        index === 0
          ? !!item.context
          : item.context?.parentTurnId !== all[index - 1].id ||
            item.context?.parentCandidateHash !== all[index - 1].candidateHash ||
            item.context?.depth !== index
      )
    )
      throw new AnalysisError('REPORT_INVALID_SNAPSHOT')
  }
  // Native paths are excluded. Freeze the complete row-level evidence rather than rereading Excel.
  const encoded = JSON.stringify(snapshot)
  if (Buffer.byteLength(encoded, 'utf8') > 32 * 1024 * 1024) throw new AnalysisError('REPORT_LIMIT')
  if (
    snapshot.runs.some((run) =>
      run.values.some((value) => value.category.length > 1200 || value.value.length > 1600)
    ) ||
    snapshot.derived.some((fact) => fact.formula.length > 4000)
  )
    throw new AnalysisError('REPORT_LIMIT')
}

function validateDatasetEvidence(run: ReportRun) {
  const origin = run.source.origin
  if (!origin) return
  const fail = () => {
    throw new AnalysisError('REPORT_INVALID_SNAPSHOT')
  }
  const columnIndex = (column: string) =>
    /^[A-Z]{1,3}$/.test(column)
      ? [...column].reduce((sum, c) => sum * 26 + c.charCodeAt(0) - 64, 0) - 1
      : -1
  const validResult = (result: NonNullable<typeof origin.result>) =>
    result.columns.length > 0 &&
    new Set(result.columns).size === result.columns.length &&
    result.rows.every((row) => row.length === result.columns.length)
  const validExecution = (execution: typeof origin.fileExecution) =>
    !!execution &&
    execution.verification === 'recorded_result' &&
    execution.replay === 'not_captured' &&
    execution.tableSha256 === reportHash(JSON.stringify(execution.table)) &&
    execution.table.columns.length === execution.table.columnTypes.length &&
    new Set(execution.table.columns).size === execution.table.columns.length &&
    execution.table.rows.every((row) => row.length === execution.table.columns.length)
  if (origin.kind === 'file_execution') {
    if (
      !validExecution(origin.fileExecution) ||
      origin.fileExecution!.table.rows.length !== origin.rows
    )
      fail()
    const table = origin.fileExecution!.table
    const sameCell = (actual: string | null, recorded: string) => {
      if ((actual ?? '') === recorded) return true
      if (actual === null) return false
      try {
        return compare(decimal(actual), decimal(recorded)) === 0
      } catch {
        return false
      }
    }
    for (const value of run.values)
      for (const input of value.inputs) {
        const match = /^([A-Z]{1,3})([1-9]\d*)$/.exec(input.cell)
        if (
          !match ||
          !table.rows[input.row - 2] ||
          Number(match[2]) !== input.row ||
          columnIndex(match[1]) >= table.columns.length ||
          (run.plan.operation !== 'count' &&
            !sameCell(table.rows[input.row - 2][columnIndex(match[1])], input.value))
        )
          fail()
      }
    return
  }
  const validPowerBi = (query: string | undefined, powerBi: typeof origin.powerBi) =>
    !!query &&
    !!powerBi &&
    powerBi.complete === true &&
    powerBi.querySha256 === reportHash(query) &&
    (!powerBi.schema ||
      powerBi.schemaSha256 ===
        reportHash(
          JSON.stringify({
            tables: powerBi.schema.tables,
            relationships: powerBi.schema.relationships
          })
        )) &&
    (powerBi.kind === 'local'
      ? !!powerBi.local && powerBi.transport === 'adomd'
      : !!powerBi.accountId &&
        !!powerBi.tenantId &&
        !!powerBi.environment &&
        powerBi.transport !== 'adomd')
  if (origin.kind === 'mysql' || origin.kind === 'powerbi') {
    if (
      (origin.acquisition && origin.acquisition.querySha256 !== reportHash(origin.query ?? '')) ||
      !origin.query ||
      !origin.database ||
      !origin.result ||
      !validResult(origin.result) ||
      origin.result.rows.length !== origin.rows ||
      (origin.kind === 'powerbi' &&
        (!validPowerBi(origin.query, origin.powerBi) ||
          origin.database !== origin.powerBi?.modelId))
    )
      fail()
    return
  }
  const parents = origin.parents ?? [],
    columns = origin.columns ?? [],
    rows = origin.rowMap ?? []
  if (
    !parents.length ||
    !columns.length ||
    !origin.steps?.length ||
    !origin.join ||
    rows.length !== origin.rows ||
    new Set(columns.map((c) => c.output)).size !== columns.length ||
    new Set(rows.map((r) => r.output)).size !== rows.length ||
    parents.some(
      (p) =>
        (p.kind === 'file_execution' && !validExecution(p.fileExecution)) ||
        (p.acquisition && p.acquisition.querySha256 !== reportHash(p.query ?? '')) ||
        !/^[a-f0-9]{64}$/.test(p.sha256) ||
        (['mysql', 'powerbi'].includes(p.kind) &&
          (!p.query || !p.result || !validResult(p.result))) ||
        (p.kind === 'powerbi' &&
          (!validPowerBi(p.query, p.powerBi) || p.database !== p.powerBi?.modelId))
    ) ||
    columns.some(
      (c) => !parents[c.parent] || columnIndex(c.input) < 0 || columnIndex(c.output) < 0
    ) ||
    rows.some(
      (r) =>
        r.output < 2 ||
        r.output > origin.rows + 1 ||
        new Set(r.sources.map((s) => s.parent)).size !== r.sources.length ||
        r.sources.some(
          (s) =>
            !parents[s.parent] ||
            s.row < 2 ||
            (parents[s.parent].result &&
              (!parents[s.parent].result!.rows[s.row - 2] ||
                Object.entries(s.cells ?? {}).some(
                  ([col, value]) =>
                    parents[s.parent].result!.rows[s.row - 2][columnIndex(col)] !== value
                )))
        )
    )
  )
    fail()
  const rowMap = new Map(rows.map((r) => [r.output, r]))
  for (const value of run.values)
    for (const input of value.inputs) {
      const row = rowMap.get(input.row)
      if (!row) fail()
      for (const cell of input.origin ?? []) {
        const parent = parents.findIndex(
          (p) =>
            p.id === cell.sourceId &&
            p.sha256 === cell.sha256 &&
            p.sheet === cell.sheet &&
            p.name === cell.source
        )
        const match = /^([A-Z]{1,3})([1-9]\d*)$/.exec(cell.cell)
        const record = row!.sources.find((s) => s.parent === parent)
        if (
          parent < 0 ||
          !match ||
          !record ||
          record.row !== Number(match[2]) ||
          (record.cells && (record.cells[match[1]] ?? '') !== cell.value)
        )
          fail()
      }
      const mapping = columns.find((c) => c.output === input.cell.replace(/\d+$/, ''))
      const record = row!.sources.find((s) => s.parent === mapping?.parent)
      if (
        mapping &&
        record &&
        !(input.origin ?? []).some(
          (cell) =>
            cell.sourceId === parents[mapping.parent].id &&
            cell.sha256 === parents[mapping.parent].sha256 &&
            cell.sheet === parents[mapping.parent].sheet &&
            cell.cell === mapping.input + record.row
        )
      )
        fail()
    }
}
