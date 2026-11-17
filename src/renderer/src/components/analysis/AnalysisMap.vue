<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import type { AnalysisTask, NaturalTurn } from '@shared/analysis'
const props = defineProps<{ task: AnalysisTask; selectedId: string; disabled: boolean }>()
const emit = defineEmits<{ select: [id: string] }>()
const { t } = useI18n()
const nodes = computed(() => {
  const result: { turn: NaturalTurn; depth: number }[] = []
  const visited = new Set<string>()
  function visit(turn: NaturalTurn, depth: number) {
    if (visited.has(turn.id)) return
    visited.add(turn.id)
    result.push({ turn, depth })
    props.task.turns
      .filter((child) => child.context?.parentTurnId === turn.id)
      .forEach((child) => visit(child, depth + 1))
  }
  props.task.turns
    .filter(
      (turn) =>
        !turn.context ||
        !props.task.turns.some((parent) => parent.id === turn.context?.parentTurnId)
    )
    .forEach((turn) => visit(turn, 0))
  props.task.turns.filter((turn) => !visited.has(turn.id)).forEach((turn) => visit(turn, 0))
  return result
})
</script>
<template>
  <details class="analysis-map" open data-testid="analysis-map">
    <summary>
      <Icon icon="lucide:git-branch" aria-hidden="true" />{{ t('analysis.framework.mapTitle') }}
    </summary>
    <nav :aria-label="t('analysis.framework.mapTitle')">
      <ol>
        <li
          v-for="node in nodes"
          :key="node.turn.id"
          :style="{ paddingInlineStart: Math.min(node.depth, 4) * 14 + 'px' }"
        >
          <button
            type="button"
            :data-testid="'analysis-map-node-' + node.turn.id"
            :aria-current="selectedId === node.turn.id ? 'step' : undefined"
            :disabled="disabled"
            @click="emit('select', node.turn.id)"
          >
            <Icon
              :icon="node.depth ? 'lucide:corner-down-right' : 'lucide:circle'"
              aria-hidden="true"
            />
            <span class="map-question">{{ node.turn.question }}</span>
            <span class="map-status"
              >{{ t('analysis.framework.depth', { depth: node.depth }) }} ·
              {{
                t(
                  node.turn.state === 'answered'
                    ? node.turn.answer.status === 'published'
                      ? 'analysis.natural.published'
                      : 'analysis.natural.draft'
                    : 'analysis.natural.' + node.turn.state
                )
              }}</span
            >
          </button>
        </li>
      </ol>
    </nav>
  </details>
</template>
<style scoped>
.analysis-map {
  margin: 0 0 22px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--border);
}
summary {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 600;
}
nav {
  margin-top: 12px;
  max-height: 280px;
  overflow: auto;
  scrollbar-color: var(--border) transparent;
}
ol {
  list-style: none;
  margin: 0;
  padding: 0;
}
button {
  width: 100%;
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) auto;
  align-items: start;
  gap: 8px;
  text-align: left;
  padding: 9px 10px;
  border-radius: 5px;
}
button:hover,
button[aria-current='step'] {
  background: var(--accent);
}
button:focus-visible,
summary:focus-visible {
  outline: 2px solid var(--analysis-blue);
  outline-offset: 2px;
}
button:disabled {
  opacity: 0.55;
  cursor: wait;
}
button svg {
  margin-top: 3px;
}
.map-question {
  overflow-wrap: anywhere;
  line-height: 1.6;
}
.map-status {
  font-size: 12px;
  color: var(--analysis-muted);
  white-space: nowrap;
}
@media (max-width: 1050px) {
  button {
    grid-template-columns: 16px minmax(0, 1fr);
  }
  .map-status {
    grid-column: 2;
  }
}
</style>
