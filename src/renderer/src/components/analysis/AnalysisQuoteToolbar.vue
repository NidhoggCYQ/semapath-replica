<script setup lang="ts">
import { inject, onMounted, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { FOLLOWUP_INTENTS, QuoteOriginSchema, type QuoteOrigin } from '@shared/analysisInteraction'
import { ANALYSIS_FOLLOWUP } from './interactionContext'
const props = defineProps<{ root: HTMLElement | null }>()
const followup = inject(ANALYSIS_FOLLOWUP, null)
const { t } = useI18n()
const selected = ref<{ text: string; origin: QuoteOrigin; x: number; y: number } | null>(null)
const busy = ref(false)
let frame = 0
function readSelection() {
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(() => {
    if (busy.value) return
    const selection = window.getSelection()
    if (!followup || !props.root || !selection || selection.isCollapsed || !selection.rangeCount) {
      selected.value = null
      return
    }
    const range = selection.getRangeAt(0)
    const parent =
      range.startContainer.nodeType === Node.ELEMENT_NODE
        ? (range.startContainer as Element)
        : range.startContainer.parentElement
    const region = parent?.closest<HTMLElement>('[data-analysis-quote-origin]')
    if (
      !region ||
      !props.root.contains(region) ||
      !region.contains(range.endContainer) ||
      parent?.closest('input,textarea,[contenteditable="true"]')
    ) {
      selected.value = null
      return
    }
    let origin: QuoteOrigin
    try {
      origin = QuoteOriginSchema.parse(JSON.parse(region.dataset.analysisQuoteOrigin!))
    } catch {
      selected.value = null
      return
    }
    const text = selection.toString().trim()
    if (!text) {
      selected.value = null
      return
    }
    const rect = range.getBoundingClientRect()
    selected.value = {
      text,
      origin,
      x: Math.max(8, Math.min(rect.left, window.innerWidth - 320)),
      y: rect.bottom + 48 < window.innerHeight ? rect.bottom + 8 : Math.max(8, rect.top - 44)
    }
  })
}
async function ask(intent: (typeof FOLLOWUP_INTENTS)[number]) {
  const item = selected.value
  if (!item || busy.value || item.text.length > 2000 || !followup) return
  busy.value = true
  try {
    await followup.request(item.origin, item.text, intent)
    window.getSelection()?.removeAllRanges()
    selected.value = null
  } finally {
    busy.value = false
  }
}
onMounted(() => {
  document.addEventListener('selectionchange', readSelection)
  window.addEventListener('resize', readSelection)
  document.addEventListener('scroll', readSelection, true)
})
onBeforeUnmount(() => {
  cancelAnimationFrame(frame)
  document.removeEventListener('selectionchange', readSelection)
  window.removeEventListener('resize', readSelection)
  document.removeEventListener('scroll', readSelection, true)
})
</script>
<template>
  <Teleport to="body"
    ><div
      v-if="selected"
      class="analysis-selection-toolbar"
      role="toolbar"
      data-testid="analysis-selection-toolbar"
      :aria-label="t('analysis.followup.label')"
      :style="{ left: selected.x + 'px', top: selected.y + 'px' }"
      @pointerdown.prevent
    >
      <span v-if="selected.text.length > 2000" role="status">{{
        t('analysis.followup.tooLong')
      }}</span>
      <button
        v-for="intent in selected.text.length <= 2000 ? FOLLOWUP_INTENTS : []"
        :key="intent"
        type="button"
        :disabled="busy"
        :data-testid="'analysis-followup-' + intent"
        @click="ask(intent)"
      >
        {{ t('analysis.followup.' + intent) }}
      </button>
    </div></Teleport
  >
</template>
<style scoped>
.analysis-selection-toolbar {
  position: fixed;
  z-index: var(--dc-z-modal, 100);
  display: flex;
  gap: 4px;
  max-width: calc(100vw - 16px);
  padding: 5px;
  background: var(--popover);
  color: var(--popover-foreground);
  border: 1px solid var(--border);
  border-radius: 7px;
  box-shadow: 0 5px 18px #0002;
  font-size: 12px;
}
button {
  padding: 6px 9px;
  border-radius: 4px;
  white-space: nowrap;
}
button:hover {
  background: var(--accent);
}
button:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 1px;
}
button:disabled {
  opacity: 0.5;
}
</style>
