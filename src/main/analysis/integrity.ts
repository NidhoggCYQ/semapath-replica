import { createHash } from 'node:crypto'
import type { AnalysisRun, AnalysisTask, NaturalTurn } from '@shared/analysis'
import { AnalysisError } from './errors'

export function candidateHash(run: AnalysisRun): string {
  const { answer: _answer, ...content } = run
  return createHash('sha256').update(JSON.stringify(content)).digest('hex')
}
export function naturalTurnHash(turn: NaturalTurn, task: AnalysisTask): string {
  const { answer: _answer, ...content } = turn
  const runs = turn.queryRuns.map((reference) => {
    const run = task.runs.find((run) => run.id === reference.runId)
    if (!run) throw new AnalysisError('INVALID_DRAFT')
    return { key: reference.key, id: run.id, hash: candidateHash(run) }
  })
  return createHash('sha256')
    .update(JSON.stringify({ turn: content, runs }))
    .digest('hex')
}
