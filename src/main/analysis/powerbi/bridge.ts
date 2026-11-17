import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { app } from 'electron'
import { z } from 'zod'
import { AnalysisErrorCodes } from '@shared/analysis'
import { AnalysisError } from '../errors'

const Frame = z.discriminatedUnion('ok', [
  z.object({ id: z.string().uuid(), ok: z.literal(true), result: z.unknown() }),
  z.object({ id: z.string().uuid(), ok: z.literal(false), error: z.enum(AnalysisErrorCodes) })
])
type Pending = { finish: (error?: AnalysisError, value?: unknown) => void }
export class PbiBridge {
  private child: ChildProcessWithoutNullStreams | undefined
  private readonly pending = new Map<string, Pending>()
  private readonly retired = new Set<string>()
  private buffer = Buffer.alloc(0)
  constructor(
    private readonly executable = app.isPackaged
      ? path.join(process.resourcesPath, 'powerbi-bridge', 'SemaPath.PowerBiBridge.exe')
      : path.join(app.getAppPath(), 'out', 'powerbi-bridge', 'SemaPath.PowerBiBridge.exe')
  ) {}
  private stop(error = new AnalysisError('PBI_CANCELLED')) {
    const child = this.child
    this.child = undefined
    this.buffer = Buffer.alloc(0)
    for (const item of this.pending.values()) item.finish(error)
    this.pending.clear()
    this.retired.clear()
    child?.kill()
  }
  dispose() {
    this.stop()
  }
  private start() {
    if (this.child) return this.child
    const child = spawn(this.executable, [], { windowsHide: true, stdio: 'pipe' })
    this.child = child
    child.stdin.on('error', () => {
      if (this.child === child) this.stop(new AnalysisError('PBI_BRIDGE_UNAVAILABLE'))
    })
    child.stderr.on('data', () => {}) // Native diagnostics must never expose access tokens.
    child.on('error', () => {
      if (this.child === child) this.stop(new AnalysisError('PBI_BRIDGE_UNAVAILABLE'))
    })
    child.on('exit', () => {
      if (this.child === child) this.stop(new AnalysisError('PBI_BRIDGE_UNAVAILABLE'))
    })
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.child !== child) return
      this.buffer = Buffer.concat([this.buffer, chunk])
      while (true) {
        const end = this.buffer.indexOf(10)
        if (end < 0) break
        if (end > 8 * 1024 * 1024) {
          this.stop(new AnalysisError('PBI_PROTOCOL'))
          return
        }
        const line = this.buffer.subarray(0, end).toString('utf8')
        this.buffer = this.buffer.subarray(end + 1)
        try {
          const frame = Frame.parse(JSON.parse(line))
          const item = this.pending.get(frame.id)
          if (!item) {
            if (this.retired.delete(frame.id)) continue
            throw new Error('Uncorrelated frame')
          }
          item.finish(
            frame.ok ? undefined : new AnalysisError(frame.error),
            frame.ok ? frame.result : undefined
          )
        } catch {
          this.stop(new AnalysisError('PBI_PROTOCOL'))
          return
        }
      }
      if (this.buffer.length > 8 * 1024 * 1024) this.stop(new AnalysisError('PBI_PROTOCOL'))
    })
    return child
  }
  request<T>(
    method: string,
    payload: object,
    schema: z.ZodType<T>,
    signal: AbortSignal
  ): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason)
    if (this.pending.size >= 4) return Promise.reject(new AnalysisError('BUSY'))
    const id = randomUUID(),
      frame = JSON.stringify({ id, method, ...payload }) + '\n'
    if (Buffer.byteLength(frame) > 64 * 1024) return Promise.reject(new AnalysisError('PBI_LIMIT'))
    return new Promise((resolve, reject) => {
      const child = this.start()
      const finish = (error?: AnalysisError, value?: unknown) => {
        if (!this.pending.delete(id)) return
        clearTimeout(timer)
        signal.removeEventListener('abort', cancel)
        if (error) reject(error)
        else {
          const parsed = schema.safeParse(value)
          if (parsed.success) resolve(parsed.data)
          else {
            reject(new AnalysisError('PBI_PROTOCOL'))
            this.stop(new AnalysisError('PBI_PROTOCOL'))
          }
        }
      }
      const cancel = () => {
        this.retired.add(id)
        const cancelId = randomUUID()
        this.retired.add(cancelId)
        child.stdin.write(JSON.stringify({ id: cancelId, method: 'cancel', requestId: id }) + '\n')
        finish(
          signal.reason instanceof AnalysisError
            ? signal.reason
            : new AnalysisError('PBI_CANCELLED')
        )
        // A wedged native provider cannot keep an orphan operation alive indefinitely.
        const deadline = setTimeout(() => {
          if (this.child === child && this.retired.has(id))
            this.stop(new AnalysisError('PBI_CANCELLED'))
        }, 2000)
        deadline.unref()
      }
      const timer = setTimeout(() => {
        finish(new AnalysisError('PBI_TIMEOUT'))
        this.stop(new AnalysisError('PBI_TIMEOUT'))
      }, 120000)
      this.pending.set(id, { finish })
      signal.addEventListener('abort', cancel, { once: true })
      child.stdin.write(frame, (error) => {
        if (error) this.stop(new AnalysisError('PBI_BRIDGE_UNAVAILABLE'))
      })
    })
  }
}
