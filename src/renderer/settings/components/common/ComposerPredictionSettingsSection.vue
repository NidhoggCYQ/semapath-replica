<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useUiSettingsStore } from '@/stores/uiSettingsStore'
import { useModelStore } from '@/stores/modelStore'
import { DcToggleRow } from '@dc-ui/components/toggle-row'
import { Button } from '@shadcn/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@shadcn/components/ui/popover'
import ModelSelect from '@/components/ModelSelect.vue'
import type { RENDERER_MODEL_META } from '@shared/types/provider'
import type { ComposerPredictionSettings } from '@shared/composerPrediction'
import { defaultComposerPredictionSettings } from '@shared/composerPrediction'
import { REASONING_EFFORT_VALUES } from '@shared/types/model-db'

const { t } = useI18n()
const settings = useUiSettingsStore()
const models = useModelStore()
const open = ref(false)
const saving = ref(false)
const failed = ref(false)
const selected = computed(() => settings.composerPredictionSettings.model)
const label = computed(() => {
  const target = selected.value
  if (!target) return t('chat.prediction.followSession')
  return (
    models.enabledModels
      .find((g) => g.providerId === target.providerId)
      ?.models.find((m) => m.id === target.modelId)?.name ?? target.modelId
  )
})
async function save(value: ComposerPredictionSettings | boolean) {
  if (saving.value) return
  saving.value = true
  failed.value = false
  try {
    if (typeof value === 'boolean') await settings.setComposerPredictionsEnabled(value)
    else await settings.setComposerPredictionSettings(value)
  } catch {
    failed.value = true
  } finally {
    saving.value = false
  }
}
function select(model: RENDERER_MODEL_META, providerId: string) {
  open.value = false
  void save({ model: { providerId, modelId: model.id }, reasoning: { mode: 'auto' } })
}
function reasoning(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  const next: ComposerPredictionSettings['reasoning'] =
    value === 'auto'
      ? { mode: 'auto' }
      : value === 'on' || value === 'off'
        ? { mode: 'enabled', value: value === 'on' }
        : { mode: 'effort', value: value as (typeof REASONING_EFFORT_VALUES)[number] }
  void save({ model: selected.value, reasoning: next })
}
</script>

<template>
  <section
    data-testid="prediction-settings"
    class="flex min-w-0 flex-col gap-3 border-b border-border pb-4"
    :aria-busy="saving"
  >
    <DcToggleRow
      class="[&_p]:text-foreground/75"
      id="composer-predictions-switch"
      icon="lucide:sparkles"
      :label="t('chat.prediction.title')"
      :description="t('chat.prediction.description')"
      :model-value="settings.composerPredictionsEnabled"
      :disabled="saving"
      @update:model-value="save"
    />
    <div v-if="settings.composerPredictionsEnabled" class="flex flex-wrap items-center gap-2">
      <span class="text-sm">{{ t('chat.prediction.model') }}</span>
      <Popover v-model:open="open">
        <PopoverTrigger as-child
          ><Button
            data-testid="prediction-model"
            variant="outline"
            :disabled="saving"
            class="min-w-0 max-w-full justify-start"
            ><span class="truncate">{{ label }}</span></Button
          ></PopoverTrigger
        >
        <PopoverContent class="w-80 max-w-[90vw] p-0" align="start"
          ><ModelSelect
            :exclude-providers="['acp']"
            :respect-chat-mode="false"
            @update:model="select"
        /></PopoverContent>
      </Popover>
      <Button
        v-if="selected"
        variant="ghost"
        :disabled="saving"
        @click="save(defaultComposerPredictionSettings())"
        >{{ t('chat.prediction.followSession') }}</Button
      >
      <label v-if="selected" class="flex flex-wrap items-center gap-2 text-sm">
        {{ t('chat.prediction.reasoning') }}
        <select
          data-testid="prediction-reasoning"
          class="min-h-8 rounded border border-border bg-background px-2 text-foreground focus-visible:outline-2 focus-visible:outline-primary"
          :disabled="saving"
          :value="
            settings.composerPredictionSettings.reasoning.mode === 'auto'
              ? 'auto'
              : settings.composerPredictionSettings.reasoning.mode === 'effort'
                ? settings.composerPredictionSettings.reasoning.value
                : settings.composerPredictionSettings.reasoning.value
                  ? 'on'
                  : 'off'
          "
          @change="reasoning"
        >
          <option value="auto">{{ t('chat.prediction.auto') }}</option>
          <option value="on">{{ t('chat.prediction.on') }}</option>
          <option value="off">{{ t('chat.prediction.off') }}</option>
          <option v-for="effort in REASONING_EFFORT_VALUES" :key="effort" :value="effort">
            {{ t('chat.prediction.efforts.' + effort) }}
          </option>
        </select>
      </label>
    </div>
    <p v-if="failed" role="alert" class="text-sm text-destructive">
      {{ t('chat.prediction.saveFailed') }}
    </p>
    <p
      v-else-if="settings.composerPredictionsEnabled && settings.composerPredictionStatus"
      role="status"
      class="text-sm text-foreground/75"
    >
      {{ t('chat.prediction.errors.' + settings.composerPredictionStatus.reason) }}
      {{
        t('chat.prediction.fallback.' + (settings.composerPredictionStatus.fallback ?? 'pending'))
      }}
    </p>
  </section>
</template>
