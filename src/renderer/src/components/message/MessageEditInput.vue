<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Editor, EditorContent } from '@tiptap/vue-3'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import HardBreak from '@tiptap/extension-hard-break'
import History from '@tiptap/extension-history'
import type { JSONContent } from '@tiptap/core'
import type { UserMessageInlineItem } from '@shared/types/agent-interface'
import { AnalysisContextNode } from '@/components/editor/AnalysisContextNode'
import { useI18n } from 'vue-i18n'

const props = withDefaults(
  defineProps<{ text: string; inlineItems: UserMessageInlineItem[]; editable?: boolean }>(),
  { editable: true }
)
const emit = defineEmits<{
  change: [value: { text: string; inlineItems: UserMessageInlineItem[] }]
  save: []
  cancel: []
}>()
const { t } = useI18n()
const root = ref<HTMLElement | null>(null)
let resizeObserver: ResizeObserver | null = null
let scrollFrame = 0
function keepVisible() {
  cancelAnimationFrame(scrollFrame)
  scrollFrame = requestAnimationFrame(() =>
    root.value?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  )
}
// The editor changes text and opaque references as one document. Other attachment/skill
// nodes remain in the parent message; their membership is not inferred from text edits.
const nodes: JSONContent[] = []
let cursor = 0
for (const item of props.inlineItems
  .filter((i) => i.type === 'analysis')
  .sort((a, b) => a.offset - b.offset)) {
  const offset = Math.max(cursor, Math.min(props.text.length, item.offset))
  if (offset > cursor) nodes.push({ type: 'text', text: props.text.slice(cursor, offset) })
  if (item.type === 'analysis')
    nodes.push({ type: 'analysisContext', attrs: { contextId: item.contextId, label: item.label } })
  cursor = offset
}
if (cursor < props.text.length) nodes.push({ type: 'text', text: props.text.slice(cursor) })
const editor = new Editor({
  editable: props.editable,
  extensions: [Document, Paragraph, Text, HardBreak, History, AnalysisContextNode],
  content: { type: 'doc', content: [{ type: 'paragraph', content: nodes }] },
  editorProps: {
    attributes: {
      'aria-label': t('chat.messageActions.editing'),
      role: 'textbox',
      'aria-multiline': 'true'
    }
  },
  onUpdate: publish
})
watch(
  () => props.editable,
  (value) => editor.setEditable(value)
)
function publish() {
  let text = ''
  const inlineItems: UserMessageInlineItem[] = []
  editor.state.doc.forEach((block, _offset, index) => {
    if (index) text += '\n'
    block.forEach((node) => {
      if (node.type.name === 'text') text += node.text ?? ''
      else if (node.type.name === 'hardBreak') text += '\n'
      else if (node.type.name === 'analysisContext')
        inlineItems.push({
          type: 'analysis',
          contextId: node.attrs.contextId,
          label: node.attrs.label,
          offset: text.length
        })
    })
  })
  const leading = text.length - text.trimStart().length
  const trimmed = text.trim()
  emit('change', {
    text: trimmed,
    inlineItems: [
      ...inlineItems,
      ...props.inlineItems
        .filter((i) => i.type !== 'analysis')
        .map((i) => ({ ...i, offset: Math.min(text.length, i.offset) }))
    ].map((i) => ({ ...i, offset: Math.max(0, Math.min(trimmed.length, i.offset - leading)) }))
  })
}
onMounted(() => {
  publish()
  editor.commands.focus('end')
  const viewport = root.value?.closest('.message-list-container')
  if (viewport && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(keepVisible)
    resizeObserver.observe(viewport)
  }
  keepVisible()
})
onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  cancelAnimationFrame(scrollFrame)
  editor.destroy()
})
function keydown(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    emit('cancel')
  }
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    event.stopPropagation()
    emit('save')
  }
}
</script>
<template>
  <div
    ref="root"
    data-testid="message-edit-input"
    class="message-edit-input min-w-0 w-full"
    @keydown="keydown"
  >
    <EditorContent :editor="editor" />
    <p class="mt-2 text-xs text-foreground/75">{{ t('chat.messageActions.editHint') }}</p>
  </div>
</template>
<style scoped>
.message-edit-input :deep(.tiptap) {
  min-height: 60px;
  max-height: 50vh;
  overflow-y: auto;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.message-edit-input :deep(.tiptap:focus-visible) {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
.message-edit-input :deep(.analysis-context-node) {
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 4px;
  color: var(--primary);
}
.message-edit-input :deep(.ProseMirror-selectednode) {
  outline: 2px solid var(--primary);
}
</style>
