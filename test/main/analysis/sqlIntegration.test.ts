import { describe, expect, it } from 'vitest'
import { executeSql, withSql } from '@/analysis/sqlDriver'
import { AnalysisError } from '@/analysis/errors'
import type { SqlConnectionInput } from '@shared/analysisData'

// Explicit synthetic fixture only. Ordinary test runs never contact a user's database.
const port = Number(process.env.SEMAPATH_MYSQL_TEST_PORT ?? 0)
const config: SqlConnectionInput = {
  name: 'Synthetic MySQL',
  host: '127.0.0.1',
  port,
  database: 'replica_fixture',
  user: 'replica_reader',
  password: 'synthetic-test-secret',
  tls: false
}
describe.skipIf(!port)('MySQL real protocol and read-only snapshot boundary', () => {
  it('preserves DECIMAL and BIGINT as text without floating point conversion', async () => {
    const result = await executeSql(
      config,
      'SELECT id,amount FROM precision_values',
      new AbortController().signal
    )
    expect(result.rows).toEqual([
      ['9007199254740993123', '12345678901234567890.12345678901234567890']
    ])
    expect(result.serverVersion).toBeTruthy()
    const sum = await executeSql(
      config,
      "SELECT SUM(amount) AS total FROM orders WHERE customer='001'",
      new AbortController().signal
    )
    expect(sum.rows[0][0]).toBe('0.30000000000000000000')
  })
  it('enters a server-enforced read-only transaction even if the client guard is bypassed', async () => {
    await withSql(
      { ...config, user: 'replica_writer', password: 'synthetic-writer-secret' },
      new AbortController().signal,
      async (connection) => {
        const code = await connection
          .promise()
          .query('UPDATE orders SET amount=amount')
          .then(
            () => 'WRITE_ALLOWED',
            (error: { code: string }) => error.code
          )
        expect(code).toBe('ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION')
      }
    )
    const result = await executeSql(
      config,
      'SELECT COUNT(*) AS total FROM orders',
      new AbortController().signal
    )
    expect(result.rows).toEqual([['4']])
  })
  it('keeps zero rows distinct from query failure and rejects duplicate aliases', async () => {
    const empty = await executeSql(
      config,
      'SELECT id,amount FROM orders WHERE id=0',
      new AbortController().signal
    )
    expect(empty.rows).toEqual([])
    expect(empty.fields).toHaveLength(2)
    await expect(
      executeSql(
        config,
        'SELECT id AS duplicate,amount AS duplicate FROM orders',
        new AbortController().signal
      )
    ).rejects.toThrow('SQL_QUERY_FAILED')
  })
  it('refuses over-limit results without silently truncating', async () => {
    await expect(
      executeSql(
        config,
        'SELECT a.n,b.n AS m FROM sequence_rows a CROSS JOIN sequence_rows b LIMIT 5001',
        new AbortController().signal
      )
    ).rejects.toThrow('SQL_LIMIT')
    await expect(
      executeSql(
        config,
        'SELECT ' +
          Array.from({ length: 41 }, (_, i) => 'n AS c' + i).join(',') +
          ' FROM sequence_rows WHERE n=0',
        new AbortController().signal
      )
    ).rejects.toThrow('SQL_LIMIT')
  })
  it('returns a stable authentication error without exposing server or password details', async () => {
    await expect(
      executeSql({ ...config, password: 'wrong' }, 'SELECT 1', new AbortController().signal)
    ).rejects.toThrow(/^SQL_AUTH_FAILED$/)
  })
  it('cancels a real aggregate query and releases the connection for the next read', async () => {
    const controller = new AbortController()
    const pending = executeSql(
      config,
      'SELECT SUM(a.n*b.n*c.n) FROM sequence_rows a CROSS JOIN sequence_rows b CROSS JOIN sequence_rows c',
      controller.signal
    )
    const assertion = expect(pending).rejects.toThrow('SQL_CANCELLED')
    const timer = setTimeout(() => controller.abort(new AnalysisError('SQL_CANCELLED')), 200)
    try {
      await assertion
    } finally {
      clearTimeout(timer)
    }
    expect((await executeSql(config, 'SELECT 1', new AbortController().signal)).rows).toEqual([
      ['1']
    ])
  })
  it('enforces the server query deadline without relying on renderer cancellation', async () => {
    const start = Date.now()
    await expect(
      executeSql(
        config,
        'SELECT SUM(a.n*b.n*c.n) FROM sequence_rows a CROSS JOIN sequence_rows b CROSS JOIN sequence_rows c',
        new AbortController().signal
      )
    ).rejects.toThrow('SQL_TIMEOUT')
    expect(Date.now() - start).toBeLessThan(28000)
  }, 30000)
})
