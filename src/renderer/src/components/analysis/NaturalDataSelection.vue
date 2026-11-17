<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import type { AnalysisTask } from '@shared/analysis'
import type { RetrievalSelection, RetrievalTargets } from '@shared/analysisAcquisition'
import { createAnalysisClient } from '@api/AnalysisClient'
const props = defineProps<{ task: AnalysisTask; busy: boolean; locked: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: RetrievalSelection | undefined] }>()
const { t } = useI18n()
const client = createAnalysisClient()
const mode = ref('files')
const targets = ref<RetrievalTargets>({ targets: [], issues: [] })
const selected = ref<string[]>([])
const files = ref<string[]>([])
const transport = ref<'rest' | 'xmla'>('rest')
const loading = ref(false)
let loaded = false
const hasPowerBi = computed(() =>
  targets.value.targets.some(
    (target) => target.kind === 'powerbi' && selected.value.includes(target.id)
  )
)
const hasCloudPowerBi = computed(() =>
  targets.value.targets.some(
    (target) =>
      target.kind === 'powerbi' &&
      target.powerBiKind === 'cloud' &&
      selected.value.includes(target.id)
  )
)
function targetDisabled(id: string, kind: 'mysql' | 'powerbi') {
  return (
    props.busy ||
    (!selected.value.includes(id) &&
      (selected.value.length >= 4 ||
        (kind === 'mysql' &&
          targets.value.targets.filter((t) => t.kind === 'mysql' && selected.value.includes(t.id))
            .length >= 3)))
  )
}
async function refresh() {
  if (props.busy || loading.value) return
  loading.value = true
  try {
    targets.value = await client.dataTargets(props.task.id)
    selected.value = loaded
      ? selected.value.filter((id) => targets.value.targets.some((target) => target.id === id))
      : targets.value.targets
          .filter((target) => target.kind === 'powerbi')
          .map((target) => target.id)
          .concat(
            targets.value.targets
              .filter((target) => target.kind === 'mysql')
              .slice(0, 3)
              .map((target) => target.id)
          )
    loaded = true
  } catch {
    targets.value = { targets: [], issues: ['STORAGE_ERROR'] }
    selected.value = []
  } finally {
    loading.value = false
  }
}
watch(
  () => props.locked,
  (locked) => {
    if (locked) mode.value = 'files'
  }
)
watch(
  () => props.task.sources.map((source) => source.id),
  (ids) => {
    files.value = files.value.filter((id) => ids.includes(id))
  }
)
watch(
  [mode, selected, files, transport],
  () =>
    emit(
      'update:modelValue',
      mode.value === 'connections'
        ? {
            targetIds: [...selected.value],
            sourceIds: [...files.value],
            transport: transport.value
          }
        : undefined
    ),
  { deep: true, immediate: true }
)
onMounted(() => {
  void refresh()
  window.addEventListener('focus', refresh)
})
onBeforeUnmount(() => window.removeEventListener('focus', refresh))
</script>
<template>
  <div class="natural-data-selection" data-testid="natural-data-selection">
    <div class="mode-row">
      <label
        >{{ t('analysis.retrieval.dataMode') }}
        <select v-model="mode" data-testid="natural-data-mode" :disabled="busy || locked">
          <option value="files">{{ t('analysis.retrieval.filesOnly') }}</option>
          <option value="connections">{{ t('analysis.retrieval.connected') }}</option>
        </select>
      </label>
      <button
        v-if="mode === 'connections'"
        type="button"
        class="analysis-button"
        data-testid="natural-refresh-data"
        :disabled="busy || loading"
        @click="refresh"
      >
        <Icon icon="lucide:refresh-cw" aria-hidden="true" />{{ t('analysis.retrieval.refresh') }}
      </button>
    </div>
    <p v-if="locked" class="analysis-muted">{{ t('analysis.retrieval.locked') }}</p>
    <template v-if="mode === 'connections'">
      <p class="analysis-muted">{{ t('analysis.retrieval.readHint') }}</p>
      <p v-if="loading" role="status">{{ t('analysis.retrieval.loading') }}</p>
      <p v-else-if="!targets.targets.length" role="status">
        {{
          t('analysis.retrieval.noTarget', {
            connect: t('analysis.connect'),
            manage: t('analysis.manage')
          })
        }}
      </p>
      <fieldset v-if="targets.targets.length" :disabled="busy">
        <legend>{{ t('analysis.retrieval.allowedConnections') }}</legend>
        <label v-for="target in targets.targets" :key="target.id" class="check-row">
          <input
            v-model="selected"
            type="checkbox"
            :value="target.id"
            :disabled="targetDisabled(target.id, target.kind)"
            data-testid="natural-target"
          />
          <span
            >{{ target.kind === 'mysql' ? 'MySQL' : 'Power BI' }} · {{ target.label }}
            <span class="detail">· {{ target.detail }}</span></span
          >
        </label>
      </fieldset>
      <p v-if="targets.targets.length && !selected.length" role="status">
        {{ t('analysis.retrieval.chooseTarget') }}
      </p>
      <p v-for="issue in targets.issues" :key="issue" role="status" class="analysis-muted">
        {{ t(`analysis.errors.${issue}`) }}
      </p>
      <div v-if="hasPowerBi" class="transport">
        <label v-if="hasCloudPowerBi"
          >{{ t('analysis.pbi.transport') }}
          <select v-model="transport" data-testid="natural-data-transport" :disabled="busy">
            <option value="rest">REST</option>
            <option value="xmla">XMLA</option>
          </select>
        </label>
        <p v-else data-testid="natural-local-transport">
          {{ t('analysis.pbi.transport') }} · {{ t('analysis.retrieval.localTransport') }}
        </p>
        <span class="analysis-muted">{{ t('analysis.retrieval.pbiMetadata') }}</span>
      </div>
      <details v-if="task.sources.length" class="file-selection">
        <summary>{{ t('analysis.retrieval.optionalFiles', { count: files.length }) }}</summary>
        <div class="file-list">
          <label v-for="source in task.sources" :key="source.id" class="check-row">
            <input
              v-model="files"
              type="checkbox"
              :value="source.id"
              :disabled="busy || (files.length >= 6 && !files.includes(source.id))"
              data-testid="natural-include-file"
            /><span>{{ source.name }}</span>
          </label>
        </div>
      </details>
    </template>
  </div>
</template>
<style scoped>
.natural-data-selection {
  border-bottom: 1px solid var(--border);
  padding-bottom: 16px;
  margin-bottom: 18px;
  font-size: 12px;
  line-height: 1.8;
}
.mode-row {
  display: flex;
  align-items: end;
  flex-wrap: wrap;
  gap: 12px;
}
.mode-row > label {
  min-width: min(100%, 280px);
  display: grid;
  gap: 6px;
}
select {
  width: 100%;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 8px;
  background: var(--background);
  color: var(--foreground);
  font-size: 13px;
}
select:focus-visible,
summary:focus-visible,
input:focus-visible {
  outline: 2px solid var(--analysis-blue);
  outline-offset: 2px;
}
input {
  accent-color: var(--analysis-blue);
  flex: none;
  margin-top: 4px;
}
p {
  margin: 10px 0 0;
}
fieldset {
  margin-top: 14px;
}
legend {
  font-weight: 600;
  margin-bottom: 6px;
}
.check-row {
  display: flex;
  flex-direction: row;
  gap: 9px;
  align-items: flex-start;
  min-height: 32px;
  padding-block: 5px;
  overflow-wrap: anywhere;
}
.check-row > span {
  min-width: 0;
}
.detail {
  color: var(--analysis-muted);
}
.transport {
  margin-top: 12px;
  display: grid;
  gap: 6px;
  max-width: 700px;
}
.transport select {
  max-width: 280px;
}
.file-selection {
  margin-top: 12px;
}
summary {
  cursor: pointer;
  padding-block: 5px;
  color: var(--analysis-blue);
}
.file-list {
  max-height: 220px;
  overflow: auto;
  margin-top: 6px;
}
</style>
