import { AnalysisError } from '../errors'

export function readOnlyDax(value: string): string {
  const words: string[] = []
  for (let i = 0; i < value.length; ) {
    const c = value[i]
    if (c === '"' || c === "'" || c === '[') {
      const end = c === '[' ? ']' : c
      i++
      let closed = false
      while (i < value.length) {
        if (value[i++] !== end) continue
        if (value[i] === end) {
          i++
          continue
        }
        closed = true
        break
      }
      if (!closed) throw new AnalysisError('PBI_DAX_READ_ONLY')
      continue
    }
    if (
      c === ';' ||
      value.slice(i, i + 2) === '--' ||
      value.slice(i, i + 2) === '//' ||
      value.slice(i, i + 2) === '/*'
    )
      throw new AnalysisError('PBI_DAX_READ_ONLY')
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(value.slice(i))
    if (word) {
      words.push(word[0].toUpperCase())
      i += word[0].length
    } else i++
  }
  if (
    !['EVALUATE', 'DEFINE'].includes(words[0]) ||
    words.filter((w) => w === 'EVALUATE').length !== 1 ||
    words.some((w) =>
      [
        'CREATE',
        'ALTER',
        'DROP',
        'DELETE',
        'INSERT',
        'UPDATE',
        'REFRESH',
        'EXECUTE',
        'XMLA'
      ].includes(w)
    )
  )
    throw new AnalysisError('PBI_DAX_READ_ONLY')
  return value.trim()
}
export const daxTableName = (value: string) => "'" + value.replaceAll("'", "''") + "'"
