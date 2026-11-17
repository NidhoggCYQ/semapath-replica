import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalysisSource } from '@shared/analysis'
const state = vi.hoisted(() => ({
  workers: [] as Array<EventEmitter & { terminate: ReturnType<typeof vi.fn> }>
}))
vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    terminate = vi.fn(async () => 0)
    constructor() {
      super()
      state.workers.push(this)
    }
  }
}))
const source: AnalysisSource = {
  id: 'source',
  name: 'synthetic.xlsx',
  path: 'synthetic.xlsx',
  sha256: 'fixture',
  bytes: 1,
  modifiedAt: '',
  boundAt: '',
  sheets: []
}
const catalog = { sourceId: source.id, name: source.name, sha256: source.sha256, sheets: [] }
const controllers: AbortController[] = []
const pending: Promise<unknown>[] = []
beforeEach(() => {
  vi.resetModules()
  state.workers.length = 0
})
afterEach(async () => {
  controllers.forEach((controller) => controller.abort())
  await Promise.allSettled(pending)
  controllers.length = 0
  pending.length = 0
})
describe('Workbook worker cancellation and capacity recovery', () => {
  it.each(['inspect', 'join'])('cancels %s work used by automatic acquisition', async (kind) => {
    const { inspectWorkbook, buildJoinedSource } = await import('@/analysis/workerClient')
    const controller = new AbortController()
    controllers.push(controller)
    const promise =
      kind === 'inspect'
        ? inspectWorkbook('snapshot.xlsx', undefined, controller.signal)
        : buildJoinedSource(
            source,
            source,
            {
              title: 'Joined',
              left: { sourceId: source.id, sheet: 'Data', headerRow: 1, key: 'A' },
              right: { sourceId: source.id, sheet: 'Data', headerRow: 1, key: 'A' },
              kind: 'left',
              cardinality: 'many_to_one',
              keyKind: 'text'
            },
            controller.signal
          )
    pending.push(promise)
    const assertion = expect(promise).rejects.toThrow('ANALYSIS_CANCELLED')
    await vi.waitFor(() => expect(state.workers).toHaveLength(1))
    controller.abort()
    await assertion
    expect(state.workers[0].terminate).toHaveBeenCalledOnce()
  })
  it('removes an aborted queued job, terminates active work and returns capacity to the next request', async () => {
    const { describeSource } = await import('@/analysis/workerClient')
    const start = () => {
      const controller = new AbortController()
      controllers.push(controller)
      const promise = describeSource(source, controller.signal)
      pending.push(promise)
      return { controller, promise }
    }
    const first = start()
    const second = start()
    const queued = start()
    const firstAssertion = expect(first.promise).rejects.toThrow('ANALYSIS_CANCELLED')
    const queuedAssertion = expect(queued.promise).rejects.toThrow('ANALYSIS_CANCELLED')
    await vi.waitFor(() => expect(state.workers).toHaveLength(2))
    queued.controller.abort()
    await queuedAssertion
    expect(state.workers).toHaveLength(2)
    first.controller.abort()
    await firstAssertion
    expect(state.workers[0].terminate).toHaveBeenCalledOnce()
    const recovered = start()
    await vi.waitFor(() => expect(state.workers).toHaveLength(3))
    state.workers[1].emit('message', { ok: true, data: catalog })
    state.workers[2].emit('message', { ok: true, data: catalog })
    await expect(second.promise).resolves.toEqual(catalog)
    await expect(recovered.promise).resolves.toEqual(catalog)
  })
  it('does not allocate a worker for an already cancelled request', async () => {
    const { describeSource } = await import('@/analysis/workerClient')
    const controller = new AbortController()
    controller.abort()
    await expect(describeSource(source, controller.signal)).rejects.toThrow('ANALYSIS_CANCELLED')
    expect(state.workers).toHaveLength(0)
  })
})
