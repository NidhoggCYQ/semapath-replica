<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, reactive, ref, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@shadcn/components/ui/button'
import { createAnalysisClient } from '@api/AnalysisClient'
import { AnalysisErrorCodes, type AnalysisTask } from '@shared/analysis'
import type { SqlConnection, SqlConnectionInput } from '@shared/analysisData'
const props = defineProps<{ task: AnalysisTask; globalBusy: boolean }>()
const emit = defineEmits<{ updated: [task: AnalysisTask]; busy: [value: boolean] }>()
const { t } = useI18n()
const client = createAnalysisClient()
const connections = ref<SqlConnection[]>([])
const selected = ref('')
const defaults = () => ({
  name: '',
  host: '127.0.0.1',
  port: 3306,
  database: '',
  user: '',
  password: '',
  tls: true
})
const form = reactive(defaults())
const passwordTouched = ref(false)
const busy = ref(false),
  requestId = ref(''),
  error = ref(''),
  notice = ref(''),
  query = ref(''),
  title = ref('')
const stage = ref('connecting')
const feedbackAt = ref<'connection' | 'query'>('connection')
const queryFeedback = ref<HTMLElement | null>(null)
const tables = ref<Awaited<ReturnType<typeof client.sqlSchema>>>([])
const table = ref('')
const preview = ref<Awaited<ReturnType<typeof client.sqlPreview>> | null>(null)
const disabled = computed(() => busy.value || props.globalBusy)
const valid = computed(
  () =>
    form.name.trim() &&
    form.host.trim() &&
    form.database.trim() &&
    form.user.trim() &&
    Number.isInteger(form.port) &&
    form.port > 0 &&
    form.port <= 65535
)
let timer: ReturnType<typeof setInterval> | undefined
function report(cause: unknown) {
  const code =
    cause instanceof Error &&
    AnalysisErrorCodes.includes(cause.message as (typeof AnalysisErrorCodes)[number])
      ? cause.message
      : 'STORAGE_ERROR'
  error.value = t('analysis.errors.' + code)
}
function config(): SqlConnectionInput {
  return {
    name: form.name,
    host: form.host,
    port: form.port,
    database: form.database,
    user: form.user,
    tls: form.tls,
    ...(selected.value ? { id: selected.value } : {}),
    ...(!selected.value || passwordTouched.value ? { password: form.password } : {})
  }
}
function choose(id: string) {
  selected.value = id
  const saved = connections.value.find((c) => c.id === id)
  Object.assign(form, saved ? { ...saved, password: '' } : defaults())
  passwordTouched.value = false
  tables.value = []
  table.value = ''
  preview.value = null
  query.value = ''
  title.value = ''
  notice.value = ''
  error.value = ''
  feedbackAt.value = 'connection'
}
async function load() {
  connections.value = await client.sqlList(props.task.id)
}
function revealQueryFeedback() {
  if (feedbackAt.value === 'query')
    void nextTick(() => queryFeedback.value?.scrollIntoView({ block: 'nearest' }))
}
async function act(
  action: (id: string) => Promise<void>,
  network = true,
  target: 'connection' | 'query' = 'connection'
) {
  if (disabled.value) return
  feedbackAt.value = target
  busy.value = true
  emit('busy', true)
  error.value = ''
  notice.value = ''
  const id = crypto.randomUUID()
  if (network) {
    requestId.value = id
    stage.value = 'connecting'
    timer = setInterval(() => {
      void client
        .sqlStatus(props.task.id)
        .then((s) => {
          if (s) stage.value = s.stage
        })
        .catch(() => {})
    }, 800)
  }
  revealQueryFeedback()
  try {
    await action(id)
  } catch (cause) {
    report(cause)
  } finally {
    if (timer) clearInterval(timer)
    timer = undefined
    requestId.value = ''
    busy.value = false
    emit('busy', false)
    revealQueryFeedback()
  }
}
function save() {
  void act(async () => {
    const result = await client.sqlSave(props.task.id, config())
    await load()
    choose(result.id)
    notice.value = t('analysis.data.saved')
  }, false)
}
function testConnection() {
  void act(async (id) => {
    notice.value = t('analysis.data.connected', {
      version: await client.sqlTest(props.task.id, id, config())
    })
  })
}
function schema() {
  void act(async (id) => {
    tables.value = await client.sqlSchema(props.task.id, id, selected.value)
  })
}
function selectTable() {
  preview.value = null
  const quote = (v: string) =>
    String.fromCharCode(96) +
    v.replaceAll(String.fromCharCode(96), String.fromCharCode(96, 96)) +
    String.fromCharCode(96)
  query.value = 'SELECT * FROM ' + quote(form.database) + '.' + quote(table.value)
  title.value = table.value
}
function showPreview() {
  void act(async (id) => {
    preview.value = await client.sqlPreview(props.task.id, id, selected.value, table.value)
  })
}
function runQuery() {
  void act(
    async (id) => {
      emit(
        'updated',
        await client.sqlQuery(props.task.id, {
          requestId: id,
          connectionId: selected.value,
          query: query.value,
          title: title.value
        })
      )
    },
    true,
    'query'
  )
}
function remove() {
  void act(async () => {
    connections.value = await client.sqlRemove(props.task.id, selected.value)
    choose('')
  }, false)
}
async function stop() {
  if (!requestId.value) return
  try {
    if (!(await client.sqlCancel(props.task.id, requestId.value)))
      notice.value = t('analysis.data.commitInProgress')
  } catch (cause) {
    report(cause)
  }
}
onMounted(() => {
  void load().catch(report)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
  if (requestId.value) void client.sqlCancel(props.task.id, requestId.value).catch(() => {})
  form.password = ''
})
</script>
<template>
  <section class="sql-panel" data-testid="sql-panel" :aria-label="t('analysis.sql')">
    <h2>{{ t('analysis.data.mysqlTitle') }}</h2>
    <p class="muted">{{ t('analysis.data.sqlScope') }}</p>
    <label
      >{{ t('analysis.data.savedConnections') }}
      <select
        :value="selected"
        data-testid="sql-connections"
        :disabled="disabled"
        @change="choose(($event.target as HTMLSelectElement).value)"
      >
        <option value="">{{ t('analysis.data.newConnection') }}</option>
        <option v-for="connection in connections" :key="connection.id" :value="connection.id">
          {{ connection.name }} · {{ connection.database }}
        </option>
      </select>
    </label>
    <form class="connection-fields" @submit.prevent="save">
      <label
        >{{ t('analysis.data.name')
        }}<input
          v-model="form.name"
          data-testid="sql-name"
          maxlength="100"
          :disabled="disabled"
          required
      /></label>
      <label
        >{{ t('analysis.data.host')
        }}<input
          v-model="form.host"
          data-testid="sql-host"
          maxlength="255"
          :disabled="disabled"
          required
      /></label>
      <label
        >{{ t('analysis.data.port')
        }}<input
          v-model.number="form.port"
          data-testid="sql-port"
          type="number"
          min="1"
          max="65535"
          :disabled="disabled"
          required
      /></label>
      <label
        >{{ t('analysis.data.database')
        }}<input
          v-model="form.database"
          data-testid="sql-database"
          maxlength="100"
          :disabled="disabled"
          required
      /></label>
      <label
        >{{ t('analysis.data.user')
        }}<input
          v-model="form.user"
          data-testid="sql-user"
          maxlength="100"
          :disabled="disabled"
          autocomplete="off"
          required
      /></label>
      <label
        >{{ t('analysis.data.password')
        }}<input
          v-model="form.password"
          data-testid="sql-password"
          type="password"
          maxlength="4096"
          :disabled="disabled"
          autocomplete="new-password"
          @input="passwordTouched = true"
        /><span v-if="selected" class="muted">{{ t('analysis.data.passwordKeep') }}</span></label
      >
      <label class="checkbox"
        ><input v-model="form.tls" data-testid="sql-tls" type="checkbox" :disabled="disabled" />{{
          t('analysis.data.tls')
        }}</label
      >
      <div class="actions">
        <Button
          type="button"
          variant="outline"
          data-testid="sql-test"
          :disabled="disabled || !valid"
          @click="testConnection"
          >{{ t('analysis.data.test') }}</Button
        >
        <Button type="submit" data-testid="sql-save" :disabled="disabled || !valid">{{
          t('analysis.save')
        }}</Button>
        <Button
          v-if="selected"
          type="button"
          variant="outline"
          :disabled="disabled"
          @click="remove"
          >{{ t('analysis.remove') }}</Button
        >
      </div>
    </form>
    <p
      v-if="feedbackAt === 'connection' && error"
      role="alert"
      class="analysis-error"
      data-testid="sql-error"
    >
      {{ error }}
    </p>
    <p v-if="feedbackAt === 'connection' && notice" role="status" data-testid="sql-notice">
      {{ notice }}
    </p>
    <div v-if="feedbackAt === 'connection' && requestId" class="actions" role="status">
      <span>{{ t('analysis.data.' + stage) }}</span>
      <Button
        type="button"
        variant="outline"
        data-testid="sql-stop"
        :disabled="stage === 'saving'"
        @click="stop"
        >{{ t('analysis.cancel') }}</Button
      >
    </div>
    <section v-if="selected" class="query-section">
      <h3>{{ t('analysis.data.schema') }}</h3>
      <Button
        type="button"
        variant="outline"
        data-testid="sql-schema"
        :disabled="disabled"
        @click="schema"
        >{{ t('analysis.data.loadSchema') }}</Button
      >
      <template v-if="tables.length">
        <label
          >{{ t('analysis.data.table') }}
          <select
            v-model="table"
            data-testid="sql-table"
            :disabled="disabled"
            @change="selectTable"
          >
            <option value="">{{ t('analysis.data.chooseTable') }}</option>
            <option v-for="item in tables" :key="item.name" :value="item.name">
              {{ item.name }}
            </option>
          </select>
        </label>
        <div v-if="table" class="table-wrap">
          <table data-testid="sql-schema-table">
            <thead>
              <tr>
                <th>{{ t('analysis.data.column') }}</th>
                <th>{{ t('analysis.data.type') }}</th>
                <th>{{ t('analysis.data.nullable') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="column in tables.find((s) => s.name === table)?.columns"
                :key="column.name"
              >
                <td>{{ column.name }}</td>
                <td>{{ column.type }}</td>
                <td>{{ column.nullable ? 'NULL' : 'NOT NULL' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <Button
          v-if="table"
          type="button"
          variant="outline"
          data-testid="sql-preview"
          :disabled="disabled"
          @click="showPreview"
          >{{ t('analysis.data.preview') }}</Button
        >
      </template>
      <div v-if="preview" class="table-wrap">
        <p class="muted">{{ t('analysis.data.previewHint') }}</p>
        <table data-testid="sql-preview-table">
          <thead>
            <tr>
              <th v-for="(column, i) in preview.columns" :key="i">{{ column }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, i) in preview.rows" :key="i">
              <td v-for="(cell, j) in row" :key="j">{{ cell ?? 'NULL' }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="!preview.rows.length">{{ t('analysis.data.empty') }}</p>
      </div>
      <h3>{{ t('analysis.data.queryTitle') }}</h3>
      <p class="muted">{{ t('analysis.data.queryHint') }}</p>
      <label
        >{{ t('analysis.data.snapshotName')
        }}<input
          v-model="title"
          data-testid="sql-snapshot-name"
          maxlength="100"
          :disabled="disabled"
      /></label>
      <label
        >{{ t('analysis.data.query')
        }}<textarea
          v-model="query"
          data-testid="sql-query"
          rows="5"
          maxlength="20000"
          :disabled="disabled"
          spellcheck="false"
        />
      </label>
      <div v-if="feedbackAt === 'query'" ref="queryFeedback" data-testid="sql-query-feedback">
        <p v-if="error" role="alert" class="analysis-error" data-testid="sql-error">{{ error }}</p>
        <p v-if="notice" role="status" data-testid="sql-notice">{{ notice }}</p>
        <div v-if="requestId" class="actions" role="status">
          <span>{{ t('analysis.data.' + stage) }}</span>
          <Button
            type="button"
            variant="outline"
            data-testid="sql-stop"
            :disabled="stage === 'saving'"
            @click="stop"
            >{{ t('analysis.cancel') }}</Button
          >
        </div>
      </div>
      <Button
        type="button"
        data-testid="sql-run"
        :disabled="disabled || !title.trim() || !query.trim()"
        @click="runQuery"
        >{{ t('analysis.data.queryRun') }}</Button
      >
    </section>
  </section>
</template>
<style scoped>
.sql-panel {
  padding: 18px 0;
  max-width: 1100px;
}
h2 {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 12px;
}
h3 {
  font-size: 14px;
  font-weight: 600;
  margin: 24px 0 14px;
}
.muted {
  color: var(--analysis-muted);
  font-size: 12px;
  line-height: 1.7;
}
label {
  display: grid;
  gap: 6px;
  font-size: 12px;
  min-width: 0;
  margin: 12px 0;
}
input,
select,
textarea {
  background: var(--background);
  color: var(--foreground);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 8px;
  min-width: 0;
  width: 100%;
  font-size: 13px;
}
input:focus-visible,
select:focus-visible,
textarea:focus-visible {
  outline: 2px solid var(--analysis-blue);
  outline-offset: 2px;
}
textarea {
  resize: vertical;
  font-family: Consolas, monospace;
}
.connection-fields {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0 16px;
}
.checkbox {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
}
.checkbox input {
  width: auto;
  accent-color: var(--analysis-blue);
}
.actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  grid-column: 1/-1;
  margin: 12px 0;
}
.query-section {
  border-top: 1px solid var(--border);
  margin-top: 18px;
}
.table-wrap {
  overflow: auto;
  max-width: 100%;
  margin: 16px 0;
  max-height: 360px;
  scrollbar-color: var(--border) transparent;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
th,
td {
  padding: 8px;
  border-bottom: 1px solid var(--border);
  text-align: left;
  overflow-wrap: anywhere;
  min-width: 90px;
}
th {
  font-weight: 600;
}
td {
  font-variant-numeric: tabular-nums;
}
@media (max-width: 1100px) {
  .connection-fields {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 750px) {
  .connection-fields {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
