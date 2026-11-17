import { it, expect, vi } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
vi.unmock('fs')
vi.unmock('node:fs')
vi.mock('electron', () => ({ app: { isPackaged: false } }))
import { PbiBridge } from '@/analysis/powerbi/bridge'
import { PbiLocalModelSchema } from '@shared/analysisPowerBi'
const executable = path.resolve('out/powerbi-bridge/SemaPath.PowerBiBridge.exe')
it.skipIf(process.platform !== 'win32' || !existsSync(executable))(
  'runs the real native NDJSON bridge, correlates concurrent replies and restarts after disposal',
  async () => {
    const bridge = new PbiBridge(executable),
      signal = new AbortController().signal
    const Ping = z.object({ protocol: z.literal('semapath.powerbi/1'), runtime: z.string() })
    try {
      const [ping, models] = await Promise.all([
        bridge.request('ping', {}, Ping, signal),
        bridge.request('local.discover', {}, z.array(PbiLocalModelSchema), signal)
      ])
      expect(ping.protocol).toBe('semapath.powerbi/1')
      expect(Array.isArray(models)).toBe(true)
      await expect(
        bridge.request('local.query', { model: {}, dax: 'ALTER MODEL' }, z.unknown(), signal)
      ).rejects.toThrow('PBI_DAX_READ_ONLY')
      bridge.dispose()
      expect((await bridge.request('ping', {}, Ping, signal)).runtime).toMatch(/^10\./)
    } finally {
      bridge.dispose()
    }
  },
  20000
)
