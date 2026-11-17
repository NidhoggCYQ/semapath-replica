import { DatabaseSync } from 'node:sqlite'
import { describe, it, expect } from 'vitest'
import { MessageDeliveryTrace } from '@/session/messageDelivery'

describe('message delivery timing', () => {
  it('persists the first occurrence across restarts, separates sessions and records only timing fields', () => {
    const db = new DatabaseSync(':memory:')
    const connection = { getDatabase: () => db } as never
    try {
      const service = new MessageDeliveryTrace(connection)
      service.record('s', 'a', 'native_first_update', 100)
      service.record('s', 'a', 'native_first_update', 200)
      service.observe('unrelated', { messageId: 'a', sessionId: 's', secret: 'ignored' })
      const restarted = new MessageDeliveryTrace(connection)
      restarted.record('s', 'a', 'native_first_update', 300)
      expect(restarted.list('s', 'a')).toEqual([{ stage: 'native_first_update', at: 100 }])
      expect(restarted.list('foreign', 'a')).toEqual([])
      expect(() => restarted.record('s', 'a', 'completed', -1)).toThrow()
    } finally {
      db.close()
    }
  })
})
