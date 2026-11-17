import type { DatabaseConnectionProvider } from '@/data/databaseConnection'
import { MessageDeliveryEventSchema } from '@shared/messageDelivery'
import type { z } from 'zod'

/** Timing only. Never stores prompts, provider headers, body text or credentials. */
export class MessageDeliveryTrace {
  private readonly recorded = new Set<string>()
  constructor(private readonly connection: DatabaseConnectionProvider) {
    connection.getDatabase().exec(`CREATE TABLE IF NOT EXISTS replica_message_delivery (
      message_id TEXT NOT NULL, session_id TEXT NOT NULL, stage TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY(message_id,stage)
    )`)
  }
  record(
    sessionId: string,
    messageId: string,
    stage: z.infer<typeof MessageDeliveryEventSchema>['stage'],
    at = Date.now()
  ) {
    const key = JSON.stringify([sessionId, messageId, stage])
    if (this.recorded.has(key)) return
    const event = MessageDeliveryEventSchema.parse({ stage, at })
    this.connection
      .getDatabase()
      .prepare(
        'INSERT OR IGNORE INTO replica_message_delivery(message_id,session_id,stage,at) VALUES (?,?,?,?)'
      )
      .run(messageId, sessionId, event.stage, event.at)
    this.recorded.add(key)
    if (this.recorded.size > 1000) this.recorded.delete(this.recorded.values().next().value!)
  }
  accepted(sessionId: string, messageId: string, receivedAt: number) {
    this.record(sessionId, messageId, 'submission_received', receivedAt)
    this.record(sessionId, messageId, 'submission_linked')
  }
  observe(name: string, payload: unknown) {
    if (!['chat.stream.updated', 'chat.stream.completed', 'chat.stream.failed'].includes(name))
      return
    const p = payload as { messageId?: string; sessionId?: string }
    if (!p?.messageId || !p.sessionId) return
    this.record(
      p.sessionId,
      p.messageId,
      name === 'chat.stream.updated'
        ? 'native_first_update'
        : name === 'chat.stream.completed'
          ? 'completed'
          : 'failed'
    )
  }
  list(sessionId: string, messageId: string) {
    return this.connection
      .getDatabase()
      .prepare(
        'SELECT stage,at FROM replica_message_delivery WHERE session_id=? AND message_id=? ORDER BY at, rowid'
      )
      .all(sessionId, messageId)
      .map((r) => MessageDeliveryEventSchema.parse(r))
  }
}
