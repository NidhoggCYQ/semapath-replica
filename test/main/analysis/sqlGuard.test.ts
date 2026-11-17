import { describe, expect, it } from 'vitest'
import { readOnlySql, sqlIdentifier } from '@/analysis/sqlGuard'

describe('MySQL read-only query boundary', () => {
  it.each([
    'SELECT id, SUM(amount) FROM orders GROUP BY id;',
    'WITH totals AS (SELECT customer,SUM(amount) AS total FROM orders GROUP BY customer) SELECT * FROM totals WHERE total>0',
    "SELECT 'delete; @x -- literal', REPLACE('a','a','b'), COUNT(*) FROM `order``lines`",
    'SELECT ROW_NUMBER() OVER (PARTITION BY customer ORDER BY id), CAST(amount AS DECIMAL(65,20)) FROM orders',
    'SELECT * FROM orders WHERE customer IN (SELECT customer FROM orders) AND (amount>0 OR amount IS NULL)',
    "SELECT 'it''s safe', 'back\\slash'"
  ])('accepts a single bounded read: %s', (query) => {
    expect(readOnlySql(query)).toBe(query.replace(/;$/, ''))
  })
  it.each([
    'DELETE FROM orders',
    'SELECT 1; SELECT 2',
    'SELECT 1;;',
    "SELECT * INTO OUTFILE 'C:/test' FROM orders",
    'WITH t AS (SELECT 1) UPDATE orders SET amount=0',
    'SELECT * FROM orders FOR UPDATE',
    'SELECT @secret',
    'SELECT SLEEP(30)',
    "SELECT LOAD_FILE('/etc/passwd')",
    'SELECT custom_function()',
    'SELECT 恶意函数()',
    'SELECT `SUM`(amount) FROM orders',
    'SELECT other_database.SUM(amount) FROM orders',
    'SELECT 1 /* hidden */',
    'SELECT 1 -- hidden',
    'SELECT 1 # hidden',
    "SELECT 'unclosed",
    'SELECT 1 \\ G'
  ])('rejects writes, side effects and ambiguous syntax: %s', (query) => {
    expect(() => readOnlySql(query)).toThrow('SQL_READ_ONLY')
  })
  it('quotes selected database and table names as identifiers', () => {
    expect(sqlIdentifier('a`b')).toBe('`a``b`')
  })
})
