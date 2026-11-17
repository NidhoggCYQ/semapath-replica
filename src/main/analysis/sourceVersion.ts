import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { AnalysisSource } from '@shared/analysis'
import { AnalysisError } from './errors'
export async function assertFileFingerprint(source: AnalysisSource): Promise<void> {
  try {
    const info = await stat(source.path)
    if (!info.isFile() || info.size > 20 * 1024 * 1024) throw new AnalysisError('SOURCE_CHANGED')
    const bytes = await readFile(source.path)
    if (createHash('sha256').update(bytes).digest('hex') !== source.sha256)
      throw new AnalysisError('SOURCE_CHANGED')
  } catch (error) {
    if (error instanceof AnalysisError) throw error
    throw new AnalysisError('FILE_UNREADABLE')
  }
}
