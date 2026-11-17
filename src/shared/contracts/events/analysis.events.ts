import { z } from 'zod'
import { defineEventContract } from '../common'

export const analysisTaskChangedEvent = defineEventContract({
  name: 'analysis.task.changed',
  payload: z.object({ taskId: z.string().uuid() })
})
