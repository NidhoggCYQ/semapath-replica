<script setup lang="ts">
import { computed, ref, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@shadcn/components/ui/button'
import { createAnalysisClient } from '@api/AnalysisClient'
import { AnalysisErrorCodes, type AnalysisTask } from '@shared/analysis'
import type { JoinInput } from '@shared/analysisData'
const props = defineProps<{ task: AnalysisTask; globalBusy: boolean }>()
const emit = defineEmits<{ updated: [task: AnalysisTask]; busy: [value: boolean] }>()
const { t } = useI18n(),
  client = createAnalysisClient()
const left = reactive({ sourceId: '', sheet: '', headerRow: 1, key: '' })
const right = reactive({ sourceId: '', sheet: '', headerRow: 1, key: '' })
const title = ref(''),
  kind = ref<JoinInput['kind']>('left'),
  cardinality = ref<JoinInput['cardinality']>('many_to_one'),
  keyKind = ref<JoinInput['keyKind']>('text')
const sides = { left, right }
const columns = reactive<{
  left: { key: string; label: string }[]
  right: { key: string; label: string }[]
}>({ left: [], right: [] })
const loading = reactive({ left: false, right: false })
const tokens = { left: 0, right: 0 }
const busy = ref(false),
  error = ref('')
const disabled = computed(() => props.globalBusy || busy.value)
function report(cause: unknown) {
  const code =
    cause instanceof Error &&
    AnalysisErrorCodes.includes(cause.message as (typeof AnalysisErrorCodes)[number])
      ? cause.message
      : 'STORAGE_ERROR'
  error.value = t('analysis.errors.' + code)
}
function sourceChanged(side: 'left' | 'right') {
  const value = sides[side],
    source = props.task.sources.find((s) => s.id === value.sourceId)
  value.sheet = source?.sheets[0]?.name ?? ''
  value.headerRow = source?.sheets[0]?.firstRow ?? 1
  value.key = ''
}
async function headers(side: 'left' | 'right') {
  const value = sides[side],
    token = ++tokens[side]
  columns[side] = []
  value.key = ''
  if (!value.sourceId || !value.sheet || !Number.isInteger(value.headerRow) || value.headerRow < 1)
    return
  loading[side] = true
  try {
    const result = await client.preview({
      taskId: props.task.id,
      sourceId: value.sourceId,
      sheet: value.sheet,
      headerRow: value.headerRow,
      page: 1
    })
    if (token !== tokens[side]) return
    if (result.changed) throw new Error('SOURCE_CHANGED')
    columns[side] = result.columns
  } catch (cause) {
    if (token === tokens[side]) report(cause)
  } finally {
    if (token === tokens[side]) loading[side] = false
  }
}
for (const side of ['left', 'right'] as const)
  watch(
    () => [sides[side].sourceId, sides[side].sheet, sides[side].headerRow],
    () => {
      void headers(side)
    }
  )
async function join() {
  if (disabled.value) return
  busy.value = true
  emit('busy', true)
  error.value = ''
  try {
    emit(
      'updated',
      await client.join(props.task.id, {
        title: title.value,
        left: { ...left },
        right: { ...right },
        kind: kind.value,
        cardinality: cardinality.value,
        keyKind: keyKind.value
      })
    )
  } catch (cause) {
    report(cause)
  } finally {
    busy.value = false
    emit('busy', false)
  }
}
</script>
<template>
  <details class="join-panel" data-testid="join-panel">
    <summary>{{ t('analysis.data.joinTitle') }}</summary>
    <p class="muted">{{ t('analysis.data.joinHint') }}</p>
    <form @submit.prevent="join">
      <div class="join-sides">
        <fieldset v-for="side in ['left', 'right'] as const" :key="side" :disabled="disabled">
          <legend>{{ t('analysis.data.' + side) }}</legend>
          <label
            >{{ t('analysis.source')
            }}<select
              v-model="sides[side].sourceId"
              :data-testid="'join-' + side + '-source'"
              required
              @change="sourceChanged(side)"
            >
              <option value="">{{ t('analysis.data.chooseSource') }}</option>
              <option v-for="source in task.sources" :key="source.id" :value="source.id">
                {{ source.name }}
              </option>
            </select></label
          >
          <label
            >{{ t('analysis.sheet')
            }}<select v-model="sides[side].sheet" :data-testid="'join-' + side + '-sheet'" required>
              <option
                v-for="sheet in task.sources.find((s) => s.id === sides[side].sourceId)?.sheets"
                :key="sheet.name"
                :value="sheet.name"
              >
                {{ sheet.name }}
              </option>
            </select></label
          >
          <label
            >{{ t('analysis.headerRow')
            }}<input
              v-model.number="sides[side].headerRow"
              type="number"
              min="1"
              max="50000"
              :data-testid="'join-' + side + '-header'"
              required
          /></label>
          <label
            >{{ t('analysis.data.joinKey')
            }}<select
              v-model="sides[side].key"
              :disabled="loading[side]"
              :data-testid="'join-' + side + '-key'"
              required
            >
              <option value="">{{ t('analysis.data.chooseColumn') }}</option>
              <option v-for="column in columns[side]" :key="column.key" :value="column.key">
                {{ column.key }} · {{ column.label }}
              </option>
            </select></label
          >
        </fieldset>
      </div>
      <div class="join-options">
        <label
          >{{ t('analysis.data.snapshotName')
          }}<input
            v-model="title"
            data-testid="join-name"
            maxlength="100"
            :disabled="disabled"
            required
        /></label>
        <label
          >{{ t('analysis.data.joinKind')
          }}<select v-model="kind" data-testid="join-kind" :disabled="disabled">
            <option value="left">{{ t('analysis.data.leftJoin') }}</option>
            <option value="inner">{{ t('analysis.data.innerJoin') }}</option>
          </select></label
        >
        <label
          >{{ t('analysis.data.cardinality')
          }}<select v-model="cardinality" :disabled="disabled">
            <option value="many_to_one">{{ t('analysis.data.manyOne') }}</option>
            <option value="one_to_one">{{ t('analysis.data.oneOne') }}</option>
          </select></label
        >
        <label
          >{{ t('analysis.data.keyKind')
          }}<select v-model="keyKind" data-testid="join-key-kind" :disabled="disabled">
            <option value="text">{{ t('analysis.data.textKey') }}</option>
            <option value="number">{{ t('analysis.data.numberKey') }}</option>
          </select></label
        >
      </div>
      <p v-if="error" role="alert" class="analysis-error" data-testid="join-error">{{ error }}</p>
      <Button
        type="submit"
        data-testid="join-create"
        :disabled="
          disabled || loading.left || loading.right || !title.trim() || !left.key || !right.key
        "
        >{{ t(busy ? 'analysis.data.joining' : 'analysis.data.joinCreate') }}</Button
      >
    </form>
  </details>
</template>
<style scoped>
.join-panel {
  margin: 20px 0 0;
  padding: 18px 0;
  border-top: 1px solid var(--border);
}
summary {
  cursor: pointer;
  font-weight: 600;
  font-size: 14px;
  padding: 6px 0;
}
.muted {
  color: var(--analysis-muted);
  font-size: 12px;
  line-height: 1.7;
  max-width: 80ch;
  margin: 12px 0;
}
.join-sides {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 24px;
}
fieldset {
  min-width: 0;
  border: 0;
  padding: 0;
}
legend {
  font-size: 13px;
  font-weight: 600;
  margin: 12px 0;
}
label {
  display: grid;
  gap: 6px;
  font-size: 12px;
  margin: 12px 0;
  min-width: 0;
}
input,
select {
  min-width: 0;
  width: 100%;
  background: var(--background);
  color: var(--foreground);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 8px;
  font-size: 13px;
}
input:focus-visible,
select:focus-visible,
summary:focus-visible {
  outline: 2px solid var(--analysis-blue);
  outline-offset: 2px;
}
.join-options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 20px;
  margin: 14px 0;
}
@media (max-width: 1000px) {
  .join-sides,
  .join-options {
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
  }
}
</style>
