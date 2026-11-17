import type { AnalysisErrorCode } from '@shared/analysis'
export class AnalysisError extends Error {
  constructor(readonly code: AnalysisErrorCode) {
    super(code)
  }
}
