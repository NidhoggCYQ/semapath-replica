<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@shadcn/components/ui/dialog'
import { Button } from '@shadcn/components/ui/button'
import { createSessionClient } from '@api/SessionClient'
import type { z } from 'zod'
import type { MessageDeliveryViewSchema } from '@shared/messageDelivery'
const props = defineProps<{ messageId: string }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const client = createSessionClient()
const loading = ref(false),
  error = ref(false)
const data = ref<z.infer<typeof MessageDeliveryViewSchema> | null>(null)
let revision = 0
async function load() {
  const token = ++revision
  loading.value = true
  error.value = false
  try {
    const result = await client.getMessageDeliveryTrace(props.messageId)
    if (token === revision) data.value = result
  } catch {
    if (token === revision) error.value = true
  } finally {
    if (token === revision) loading.value = false
  }
}
watch(() => props.messageId, load, { immediate: true })
function time(at: number) {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    fractionalSecondDigits: 3
  })
}
</script>
<template>
  <Dialog :open="true" @update:open="emit('close')">
    <DialogContent
      data-testid="message-delivery-trace"
      class="flex max-h-[80vh] max-w-xl flex-col overflow-hidden"
    >
      <DialogHeader
        ><DialogTitle>{{ t('chat.delivery.title') }}</DialogTitle
        ><DialogDescription class="text-foreground/75">{{
          t('chat.delivery.description')
        }}</DialogDescription></DialogHeader
      >
      <div class="min-h-0 overflow-auto text-sm" :aria-busy="loading">
        <p v-if="loading" role="status">{{ t('common.loading') }}</p>
        <p v-else-if="error" role="alert">{{ t('common.error.requestFailed') }}</p>
        <template v-else-if="data">
          <p v-if="!data.events.length" class="py-3 text-foreground/75">
            {{ t('chat.delivery.empty') }}
          </p>
          <p v-if="data.inherited" class="py-2 text-foreground/75">
            {{ t('chat.delivery.inherited') }}
          </p>
          <ol class="divide-y divide-border">
            <li
              v-for="event in data.events"
              :key="event.stage"
              class="flex flex-wrap justify-between gap-2 py-2"
            >
              <span>{{ t('chat.delivery.stages.' + event.stage) }}</span
              ><time class="tabular-nums">{{ time(event.at) }}</time>
            </li>
          </ol>
          <div v-if="data.requests.length" class="mt-4 border-t border-border pt-3">
            <h3 class="font-medium">{{ t('chat.delivery.requests') }}</h3>
            <p
              v-for="request in data.requests"
              :key="request.requestSeq"
              class="flex flex-wrap gap-2 py-2 break-all"
            >
              <span>#{{ request.requestSeq }} {{ request.providerId }} / {{ request.modelId }}</span
              ><time class="tabular-nums">{{ time(request.at) }}</time>
            </p>
          </div>
        </template>
      </div>
      <Button variant="outline" :disabled="loading" @click="load">{{
        t('chat.delivery.refresh')
      }}</Button>
    </DialogContent>
  </Dialog>
</template>
