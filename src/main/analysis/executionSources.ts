import type { AnalysisSource, AnalysisTask } from '@shared/analysis'
import { AnalysisError } from './errors'
import { assertFileFingerprint } from './sourceVersion'

// Captured code outputs remain tied to their declared input versions until publication.
// This checks provenance identity, not whether a program implemented the business rule correctly.
export async function assertAnalysisSource(
  task: AnalysisTask,
  source: AnalysisSource,
  ancestors = new Set<string>()
): Promise<void> {
  if (ancestors.has(source.id) || ancestors.size >= 16) throw new AnalysisError('SOURCE_CHANGED')
  const next = new Set(ancestors).add(source.id)
  await assertFileFingerprint(source)
  const executions = [
    source.origin?.fileExecution,
    ...(source.origin?.parents ?? []).map((p) => p.fileExecution)
  ].filter((e) => !!e)
  for (const execution of executions)
    for (const input of execution.inputs) {
      const current = task.sources.find((s) => s.id === input.sourceId && s.sha256 === input.sha256)
      if (!current) throw new AnalysisError('SOURCE_CHANGED')
      await assertAnalysisSource(task, current, next)
    }
}
