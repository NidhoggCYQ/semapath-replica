<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { Button } from '@shadcn/components/ui/button'
import type { AnalysisContextViewSchema, AnalysisContext } from '@shared/analysisInteraction'
import type { z } from 'zod'
defineProps<{
  view: z.infer<typeof AnalysisContextViewSchema> | null
  loading: boolean
  error: string
}>()
defineEmits<{ close: []; locate: [context: AnalysisContext] }>()
const { t } = useI18n()
</script>
<template>
  <aside
    class="analysis-context-details"
    data-testid="analysis-context-details"
    :aria-label="t('analysis.references.details')"
    :aria-busy="loading"
  >
    <header>
      <h2>{{ t('analysis.references.details') }}</h2>
      <button type="button" :aria-label="t('analysis.references.close')" @click="$emit('close')">
        <Icon icon="lucide:x" />
      </button>
    </header>
    <p v-if="loading" role="status">{{ t('analysis.references.loading') }}</p>
    <p v-else-if="error" role="alert">{{ error }}</p>
    <template v-else-if="view">
      <p v-if="view.status !== 'current'" class="context-notice" role="status">
        {{
          t(
            'analysis.references.' +
              (view.context.kind === 'data'
                ? 'data' + view.status[0].toUpperCase() + view.status.slice(1)
                : view.status)
          )
        }}
      </p>
      <blockquote v-if="view.context.quote">{{ view.context.quote.text }}</blockquote>
      <h3 v-else>{{ view.context.label }}</h3>
      <dl>
        <dt>{{ t('analysis.references.recorded') }}</dt>
        <dd>{{ new Date(view.context.createdAt).toLocaleString() }}</dd>
        <template v-if="view.context.reference"
          ><dt>{{ t('analysis.references.source') }}</dt>
          <dd>{{ view.context.reference.description }}</dd>
          <dt>{{ t('analysis.references.kind') }}</dt>
          <dd>{{ t('analysis.references.kinds.' + view.context.reference.kind) }}</dd>
          <dt>{{ t('analysis.references.version') }}</dt>
          <dd class="fingerprint">{{ view.context.reference.version }}</dd></template
        >
        <template v-if="view.context.quote"
          ><dt>{{ t('analysis.references.originalVersion') }}</dt>
          <dd class="fingerprint">{{ view.context.quote.sourceHash }}</dd></template
        >
      </dl>
      <p>
        {{
          t(
            view.context.kind === 'quote'
              ? 'analysis.references.quoteNotice'
              : 'analysis.references.dataNotice'
          )
        }}
      </p>
      <Button
        v-if="view.status === 'current'"
        variant="outline"
        @click="$emit('locate', view.context)"
        >{{
          t(
            view.context.kind === 'quote'
              ? 'analysis.references.locateAnswer'
              : 'analysis.references.locateData'
          )
        }}</Button
      >
    </template>
  </aside>
</template>
<style scoped>
.analysis-context-details {
  width: 340px;
  max-width: 50%;
  flex-shrink: 0;
  border-left: 1px solid var(--border);
  padding: 18px;
  overflow: auto;
  overflow-wrap: anywhere;
  color: var(--foreground);
  background: var(--background);
  font-size: 13px;
}
header {
  display: flex;
  gap: 12px;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 18px;
}
h2 {
  font-size: 16px;
  font-weight: 600;
}
header svg {
  width: 17px;
  height: 17px;
}
h3 {
  font-weight: 600;
  margin-bottom: 12px;
}
blockquote {
  white-space: pre-wrap;
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 12px;
  line-height: 1.8;
  margin-bottom: 16px;
}
dt {
  color: color-mix(in srgb, var(--foreground) 68%, var(--background));
  margin-top: 14px;
}
dd {
  margin-top: 4px;
}
.fingerprint {
  font-size: 11px;
  word-break: break-all;
  font-variant-numeric: tabular-nums;
}
.context-notice {
  border: 1px solid var(--border);
  padding: 10px;
  margin-bottom: 14px;
}
p {
  line-height: 1.7;
  margin-block: 12px;
}
button:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
</style>
