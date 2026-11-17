import type { PbiTable } from '@shared/analysisPowerBi'
import { AnalysisError } from '../errors'

class ExactNumber {
  constructor(readonly text: string) {}
}
// V8's source context preserves both 64-bit integers and decimal literals before IEEE-754 rounding.
export function parsePowerBiJson(text: string): unknown {
  try {
    return JSON.parse(text, ((_key: string, value: unknown, context?: { source?: string }) => {
      if (typeof value !== 'number') return value
      if (!context?.source) throw new AnalysisError('PBI_PROTOCOL')
      return new ExactNumber(context.source)
    }) as Parameters<typeof JSON.parse>[1])
  } catch (error) {
    if (error instanceof AnalysisError) throw error
    throw new AnalysisError('PBI_PROTOCOL')
  }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof ExactNumber)
    throw new AnalysisError('PBI_PROTOCOL')
  return value as Record<string, unknown>
}
export function parseDaxResult(text: string): PbiTable {
  const root = record(parsePowerBiJson(text))
  if (root.error || root.errors) throw new AnalysisError('PBI_QUERY_FAILED')
  if (!Array.isArray(root.results) || root.results.length !== 1)
    throw new AnalysisError('PBI_QUERY_FAILED')
  const result = record(root.results[0])
  if (result.error || result.errors) throw new AnalysisError('PBI_QUERY_FAILED')
  if (!Array.isArray(result.tables) || result.tables.length !== 1)
    throw new AnalysisError('PBI_QUERY_FAILED')
  const table = record(result.tables[0])
  if (
    table.error ||
    table.errors ||
    table.continuationToken ||
    result.continuationToken ||
    root.continuationToken
  )
    throw new AnalysisError('PBI_QUERY_FAILED')
  if (!Array.isArray(table.rows)) throw new AnalysisError('PBI_PROTOCOL')
  if (table.rows.length > 5000) throw new AnalysisError('PBI_LIMIT')
  const names: string[] = [],
    types = new Map<string, Set<string>>()
  const objects = table.rows.map(record)
  for (const row of objects)
    for (const name of Object.keys(row)) {
      if (!types.has(name)) {
        names.push(name)
        types.set(name, new Set())
      }
      if (names.length > 40 || name.length > 1024) throw new AnalysisError('PBI_LIMIT')
    }
  const rows = objects.map((row) =>
    names.map((name) => {
      const value = row[name]
      if (value == null) return null
      if (value instanceof ExactNumber) {
        types.get(name)!.add('NUMBER_LITERAL')
        return value.text
      }
      if (typeof value === 'boolean') {
        types.get(name)!.add('BOOLEAN')
        return value ? 'TRUE' : 'FALSE'
      }
      if (typeof value === 'string') {
        types.get(name)!.add('STRING')
        return value
      }
      throw new AnalysisError('PBI_PROTOCOL')
    })
  )
  if (Buffer.byteLength(JSON.stringify(rows)) > 4 * 1024 * 1024)
    throw new AnalysisError('PBI_LIMIT')
  return {
    columns: names.map((name) => ({ name, type: [...types.get(name)!].join('|') || 'NULL' })),
    rows,
    complete: true
  }
}
