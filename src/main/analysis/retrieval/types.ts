import type { AnalysisSource } from '@shared/analysis'
import type { SourceOrigin, JoinInput } from '@shared/analysisData'
import type { RetrievalSelection, RetrievalTargets } from '@shared/analysisAcquisition'

export type SnapshotPayload = { bytes: Buffer; origin: SourceOrigin }
export type RawDataSession<S> = {
  signal: AbortSignal
  schema: () => Promise<S>
  query: (query: string, title: string) => Promise<SnapshotPayload>
  validate: () => void
  seal: () => void
}
export type RemoteCatalog = {
  id: string
  kind: 'mysql' | 'powerbi'
  label: string
  database: string
  structure: unknown
  structureSha256: string
  issue?: string
}
export type RetrievalSession = {
  signal: AbortSignal
  catalogs: RemoteCatalog[]
  query: (id: string, query: string, title: string) => Promise<SnapshotPayload>
  validate: () => void
  seal: () => void
}
export interface RetrievalGateway {
  targets(taskId: string): RetrievalTargets
  use<T>(
    taskId: string,
    selection: RetrievalSelection,
    requestId: string,
    owner: number,
    signal: AbortSignal,
    action: (session: RetrievalSession) => Promise<T>
  ): Promise<T>
}
export type RetrievalSink = {
  snapshot: (payload: SnapshotPayload, signal: AbortSignal) => Promise<AnalysisSource>
  join: (input: JoinInput, signal: AbortSignal) => Promise<AnalysisSource>
}
