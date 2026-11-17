import { expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { createAnalysisClient } from '@api/AnalysisClient'
import type { DeepchatBridge } from '@shared/contracts/bridge'
import type { DataReference, QuoteOrigin } from '@shared/analysisInteraction'

it('sends cloneable plain reference, quotation and panel data across the Electron boundary', async () => {
  const invoke = vi.fn(async (_name, input) => {
    structuredClone(input)
    return { ok: true, data: null }
  })
  const client = createAnalysisClient({ invoke } as unknown as DeepchatBridge)
  const taskId = '11111111-1111-4111-8111-111111111111'
  const reference = reactive<DataReference>({
    id: 'a'.repeat(64),
    kind: 'column',
    label: '金额',
    description: '销售.xlsx',
    version: 'b'.repeat(64),
    selector: { kind: 'column', sourceId: taskId, sheet: '销售', column: 'C' }
  })
  await client.createReference(taskId, reference)
  await client.createQuote(
    taskId,
    reactive<QuoteOrigin>({ kind: 'run', runId: taskId, candidateHash: 'c'.repeat(64) }),
    '0.3 元'
  )
  await client.savePanels(
    taskId,
    reactive({
      tab: 'files' as const,
      selectedDerived: { turnId: taskId, factId: 'fact' },
      scroll: { files: 320 }
    })
  )
  await client.saveGuide(reactive({ topics: ['data' as const], seen: true }))
  expect(invoke).toHaveBeenCalledTimes(4)
  expect(invoke.mock.calls[0][1].reference).toEqual(reference)
})
