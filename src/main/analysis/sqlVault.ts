import { safeStorage } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  SqlConnectionInputSchema,
  type SqlConnection,
  type SqlConnectionInput
} from '@shared/analysisData'
import { AnalysisError } from './errors'

const StoredSchema = z.array(
  z.object({ id: z.string().uuid(), taskId: z.string().uuid(), sealed: z.string() })
)
export class SqlVault {
  constructor(private readonly file: string) {}
  private records() {
    try {
      return StoredSchema.parse(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new AnalysisError('STORAGE_ERROR')
    }
  }
  private available() {
    if (
      !safeStorage.isEncryptionAvailable() ||
      (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
    )
      throw new AnalysisError('SQL_SECRET_UNAVAILABLE')
  }
  private decode(record: ReturnType<SqlVault['records']>[number]) {
    this.available()
    try {
      return SqlConnectionInputSchema.parse(
        JSON.parse(safeStorage.decryptString(Buffer.from(record.sealed, 'base64')))
      )
    } catch {
      throw new AnalysisError('SQL_SECRET_UNAVAILABLE')
    }
  }
  private write(records: ReturnType<SqlVault['records']>) {
    mkdirSync(path.dirname(this.file), { recursive: true })
    const temporary = this.file + '.tmp'
    writeFileSync(temporary, JSON.stringify(records), { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, this.file)
  }
  private public(id: string, config: SqlConnectionInput): SqlConnection {
    const { password, ...visible } = config
    return { ...visible, id, hasPassword: !!password }
  }
  list(taskId: string) {
    return this.records()
      .filter((r) => r.taskId === taskId)
      .map((r) => this.public(r.id, this.decode(r)))
  }
  get(taskId: string, id: string) {
    const record = this.records().find((r) => r.taskId === taskId && r.id === id)
    if (!record) throw new AnalysisError('NOT_FOUND')
    return this.decode(record)
  }
  save(taskId: string, input: SqlConnectionInput) {
    this.available()
    const records = this.records()
    const previous = input.id ? this.get(taskId, input.id) : undefined
    const id = input.id ?? randomUUID()
    const config = SqlConnectionInputSchema.parse({
      ...input,
      id,
      password: input.password ?? previous?.password ?? ''
    })
    const sealed = safeStorage.encryptString(JSON.stringify(config)).toString('base64')
    this.write([...records.filter((r) => r.id !== id), { id, taskId, sealed }])
    return this.public(id, config)
  }
  remove(taskId: string, id: string) {
    this.get(taskId, id)
    this.write(this.records().filter((r) => r.id !== id))
  }
}
