import sqlParser from 'node-sql-parser'
import { AnalysisError } from '../errors'
import { readOnlySql } from '../sqlGuard'
import { readOnlyDax } from '../powerbi/dax'
import type { PbiSchema } from '@shared/analysisPowerBi'

export function automaticSql(query: string, database: string, tables: { name: string }[]) {
  const sql = readOnlySql(query),
    allowed = new Set(tables.map((t) => t.name))
  try {
    const ast = new sqlParser.Parser().astify(sql, { database: 'MySQL' })
    if (Array.isArray(ast) || ast.type !== 'select') throw new Error()
    let count = 0,
      nodes = 0
    const visit = (value: unknown, depth = 0) => {
      if (++nodes > 5000 || depth > 100) throw new Error()
      if (Array.isArray(value)) {
        value.forEach((v) => visit(v, depth + 1))
        return
      }
      if (!value || typeof value !== 'object') return
      const node = value as Record<string, unknown>
      if (node.type === 'select') {
        if (node.with || node.locking_read) throw new Error()
        if (node.from) {
          if (!Array.isArray(node.from)) throw new Error()
          for (const part of node.from) {
            const from = part as Record<string, unknown>
            if (typeof from.table === 'string') {
              if ((from.db != null && from.db !== database) || !allowed.has(from.table))
                throw new Error()
              count++
            } else if (
              !(
                from.expr &&
                typeof from.expr === 'object' &&
                'ast' in from.expr &&
                (from.expr.ast as { type?: string })?.type === 'select'
              )
            )
              throw new Error()
          }
        }
      }
      for (const child of Object.values(node)) visit(child, depth + 1)
    }
    visit(ast)
    if (!count) throw new Error()
  } catch {
    throw new AnalysisError('FETCH_QUERY_SCOPE')
  }
  return sql
}
export function automaticDax(query: string, schema: PbiSchema) {
  const dax = readOnlyDax(query),
    tables = new Set(schema.tables.map((t) => t.name.toLowerCase())),
    fields = new Set(
      schema.tables.flatMap((t) => [...t.columns, ...t.measures].map((c) => c.name.toLowerCase()))
    )
  // A constant-only ROW/DATATABLE cannot be presented as a model-derived business result.
  let referenced = false
  const scrub = dax.replace(/"(?:[^"]|"")*"/g, '')
  for (const match of scrub.matchAll(/'((?:[^']|'')+)'|\[((?:[^\]]|\]\])+?)\]/g)) {
    if (match[1]) {
      if (!tables.has(match[1].replaceAll("''", "'").toLowerCase()))
        throw new AnalysisError('FETCH_QUERY_SCOPE')
      referenced = true
    }
    if (match[2] && fields.has(match[2].replaceAll(']]', ']').toLowerCase())) referenced = true
  }
  for (const table of tables) {
    if (
      new RegExp(
        '(^|[^\\p{L}\\p{N}_])' +
          table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
          '(?=\\s*\\[|[^\\p{L}\\p{N}_]|$)',
        'iu'
      ).test(scrub)
    )
      referenced = true
  }
  // Bare table names must obey the same catalog scope as quoted names. Functions,
  // DAX keywords and explicitly declared local variables are not remote tables.
  const bare = scrub
    .replace(/'((?:[^']|'')+)'|\[((?:[^\]]|\]\])+?)\]/g, ' ')
    .replace(/\b\d+(?:\.\d*)?(?:e[+-]?\d+)?\b/gi, ' ')
  const variables = new Set(
    [...bare.matchAll(/\bVAR\s+([\p{L}_][\p{L}\p{N}_]*)\s*=/giu)].map((match) =>
      match[1].toLowerCase()
    )
  )
  const keywords = new Set(
    'evaluate define measure var return order by asc desc start at in not and or true false day month year quarter second minute hour week skip dense both none one single integer double string boolean datetime currency decimal table column'.split(
      ' '
    )
  )
  for (const match of bare.matchAll(/[\p{L}_][\p{L}\p{N}_]*/gu)) {
    const name = match[0].toLowerCase()
    if (
      !tables.has(name) &&
      !variables.has(name) &&
      !keywords.has(name) &&
      !/^\s*\(/.test(bare.slice(match.index! + match[0].length))
    )
      throw new AnalysisError('FETCH_QUERY_SCOPE')
  }
  if (!referenced || /\b(?:EXTERNALMEASURE|SYSTEMRESTRICTSCHEMA|INFO\s*\.)/i.test(scrub))
    throw new AnalysisError('FETCH_QUERY_SCOPE')
  return dax
}
