import { z } from 'zod'
export const MessageDeliveryStageSchema = z.enum([
  'submission_received',
  'submission_linked',
  'native_first_update',
  'client_update_received',
  'client_first_render',
  'completed',
  'failed'
])
export const MessageDeliveryEventSchema = z.object({
  stage: MessageDeliveryStageSchema,
  at: z.number().int().positive()
})
export const MessageDeliveryViewSchema = z.object({
  events: z.array(MessageDeliveryEventSchema),
  requests: z.array(
    z.object({
      requestSeq: z.number().int(),
      at: z.number().int().positive(),
      providerId: z.string(),
      modelId: z.string()
    })
  ),
  inherited: z.boolean()
})
