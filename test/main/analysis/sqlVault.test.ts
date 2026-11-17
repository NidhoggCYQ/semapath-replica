import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('fs')
vi.unmock('node:fs')
const state = vi.hoisted(() => ({ available: true, values: new Map<string, string>() }))
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => state.available,
    getSelectedStorageBackend: () => 'test-encrypted',
    encryptString: (value: string) => {
      const id = String(state.values.size)
      state.values.set(id, value)
      return Buffer.from(id)
    },
    decryptString: (value: Buffer) => {
      const text = state.values.get(value.toString())
      if (!text) throw new Error('Unavailable')
      return text
    }
  }
}))
import { SqlVault } from '@/analysis/sqlVault'

let directory: string, file: string
const taskId = randomUUID(),
  otherTaskId = randomUUID()
const config = {
  name: 'Synthetic',
  host: '127.0.0.1',
  port: 3306,
  database: 'synthetic',
  user: 'reader',
  password: 'synthetic-test-secret',
  tls: true
}
beforeEach(async () => {
  state.available = true
  state.values.clear()
  directory = await mkdtemp(path.join(tmpdir(), 'semapath-vault-'))
  file = path.join(directory, 'connections.json')
})
afterEach(async () => {
  if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir()))
    throw new Error('Unsafe fixture cleanup')
  await rm(directory, { recursive: true, force: true })
})
describe('Task-scoped encrypted connection persistence', () => {
  it('passes configuration to native encryption and returns no password after save or reload', async () => {
    const saved = new SqlVault(file).save(taskId, config)
    expect(saved.hasPassword).toBe(true)
    expect(saved).not.toHaveProperty('password')
    expect(await readFile(file, 'utf8')).not.toContain('synthetic-test-secret')
    const restored = new SqlVault(file)
    expect(restored.list(taskId)).toEqual([saved])
    expect(restored.get(taskId, saved.id).password).toBe(config.password)
    restored.save(taskId, { ...config, id: saved.id, name: 'Renamed', password: undefined })
    expect(restored.get(taskId, saved.id).password).toBe(config.password)
    restored.save(taskId, { ...config, id: saved.id, password: '' })
    expect(restored.list(taskId)[0].hasPassword).toBe(false)
  })
  it('does not let another task read, replace or remove the same connection ID', () => {
    const vault = new SqlVault(file),
      saved = vault.save(taskId, config)
    expect(vault.list(otherTaskId)).toEqual([])
    expect(() => vault.get(otherTaskId, saved.id)).toThrow('NOT_FOUND')
    expect(() => vault.save(otherTaskId, { ...config, id: saved.id })).toThrow('NOT_FOUND')
    expect(() => vault.remove(otherTaskId, saved.id)).toThrow('NOT_FOUND')
    expect(vault.list(taskId)).toHaveLength(1)
  })
  it('refuses plaintext fallback when native encryption or its key becomes unavailable', async () => {
    const vault = new SqlVault(file)
    state.available = false
    expect(() => vault.save(taskId, config)).toThrow('SQL_SECRET_UNAVAILABLE')
    state.available = true
    vault.save(taskId, config)
    state.values.clear()
    expect(() => new SqlVault(file).list(taskId)).toThrow('SQL_SECRET_UNAVAILABLE')
    expect(await readFile(file, 'utf8')).not.toContain(config.password)
  })
})
