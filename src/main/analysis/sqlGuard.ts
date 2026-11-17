import { AnalysisError } from './errors'

const forbidden = new Set(
  'INSERT UPDATE DELETE REPLACE CREATE ALTER DROP TRUNCATE GRANT REVOKE CALL DO SET USE SHOW EXPLAIN HANDLER INTO OUTFILE DUMPFILE LOAD LOAD_FILE LOCK UNLOCK FOR PROCEDURE GET_LOCK RELEASE_LOCK SLEEP BENCHMARK SQL_CALC_FOUND_ROWS'.split(
    ' '
  )
)
const functions = new Set(
  'COUNT SUM AVG MIN MAX ABS ROUND CEIL CEILING FLOOR MOD POWER SQRT SIGN COALESCE IFNULL NULLIF IF GREATEST LEAST CONCAT CONCAT_WS LOWER UPPER TRIM LTRIM RTRIM LENGTH CHAR_LENGTH SUBSTRING SUBSTR LEFT RIGHT REPLACE DATE DATE_FORMAT YEAR MONTH DAY DAYOFMONTH DAYOFWEEK WEEK QUARTER DATEDIFF TIMESTAMPDIFF DATE_ADD DATE_SUB NOW CURRENT_DATE CURRENT_TIMESTAMP CAST CONVERT DECIMAL CHAR SIGNED UNSIGNED JSON_EXTRACT JSON_UNQUOTE ROW_NUMBER RANK DENSE_RANK LAG LEAD FIRST_VALUE LAST_VALUE NTILE OVER IN EXISTS AS USING VERSION'.split(
    ' '
  )
)

export function readOnlySql(input: string): string {
  for (const clause of [
    'SELECT',
    'FROM',
    'WHERE',
    'ON',
    'AND',
    'OR',
    'NOT',
    'HAVING',
    'WHEN',
    'THEN',
    'ELSE'
  ])
    functions.add(clause)
  const tokens: { text: string; kind: string }[] = []
  let i = 0
  while (i < input.length) {
    const c = input[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === "'" || c === '"' || c === String.fromCharCode(96)) {
      const start = i++
      let closed = false
      while (i < input.length) {
        if (input[i++] !== c) continue
        if (input[i] === c) {
          i++
          continue
        }
        closed = true
        break
      }
      if (!closed) throw new AnalysisError('SQL_READ_ONLY')
      tokens.push({
        kind: c === String.fromCharCode(96) ? 'identifier' : 'string',
        text: input.slice(start, i)
      })
      continue
    }
    if (
      c === '@' ||
      c === '\\' ||
      c === '#' ||
      input.slice(i, i + 2) === '--' ||
      input.slice(i, i + 2) === '/*'
    )
      throw new AnalysisError('SQL_READ_ONLY')
    const word = /^[\p{L}_][\p{L}\p{N}_$]*/u.exec(input.slice(i))
    if (word) {
      tokens.push({ kind: 'word', text: word[0].toUpperCase() })
      i += word[0].length
    } else {
      tokens.push({ kind: 'symbol', text: c })
      i++
    }
  }
  if (tokens.at(-1)?.text === ';') tokens.pop()
  if (
    !tokens.length ||
    tokens[0].kind !== 'word' ||
    !['SELECT', 'WITH'].includes(tokens[0].text) ||
    !tokens.some((token) => token.kind === 'word' && token.text === 'SELECT') ||
    tokens.some(
      (token, index) =>
        token.text === ';' ||
        (token.kind === 'word' &&
          forbidden.has(token.text) &&
          !(token.text === 'REPLACE' && tokens[index + 1]?.text === '('))
    )
  )
    throw new AnalysisError('SQL_READ_ONLY')
  for (let j = 0; j < tokens.length - 1; j++)
    if (
      tokens[j + 1].text === '(' &&
      ['word', 'identifier'].includes(tokens[j].kind) &&
      (tokens[j].kind !== 'word' || !functions.has(tokens[j].text) || tokens[j - 1]?.text === '.')
    )
      throw new AnalysisError('SQL_READ_ONLY')
  return input.trim().replace(/;\s*$/, '')
}
export const sqlIdentifier = (value: string) =>
  String.fromCharCode(96) +
  value.replaceAll(String.fromCharCode(96), String.fromCharCode(96, 96)) +
  String.fromCharCode(96)
