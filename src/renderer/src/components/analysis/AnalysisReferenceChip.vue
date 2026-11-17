<script setup lang="ts">
import { inject } from 'vue'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { ANALYSIS_INTERACTION_SCOPE } from './interactionContext'
defineProps<{ contextId: string; label: string }>()
const scope = inject(ANALYSIS_INTERACTION_SCOPE, null)
const { t } = useI18n()
</script>
<template>
  <button
    type="button"
    class="analysis-reference-chip"
    data-testid="user-message-analysis-context"
    :title="label"
    :aria-label="t('analysis.references.inspect', { label })"
    :disabled="!scope"
    @click="scope?.open(contextId)"
  >
    <Icon icon="lucide:link" aria-hidden="true" /><span>{{ label }}</span>
  </button>
</template>
<style scoped>
.analysis-reference-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 260px;
  vertical-align: middle;
  border: 1px solid color-mix(in srgb, var(--primary) 30%, var(--border));
  border-radius: 5px;
  background: color-mix(in srgb, var(--primary) 8%, var(--background));
  color: var(--foreground);
  padding: 3px 6px;
  font-size: 12px;
  text-align: left;
}
.analysis-reference-chip span {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.analysis-reference-chip svg {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
}
.analysis-reference-chip:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
</style>
