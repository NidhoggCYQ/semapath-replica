<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, reactive, ref, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@shadcn/components/ui/button'
import { createAnalysisClient } from '@api/AnalysisClient'
import { AnalysisErrorCodes, type AnalysisTask } from '@shared/analysis'
import type {
  PbiAuthStatus,
  PbiBinding,
  PbiLocalModel,
  PbiCloudModel,
  PbiSchema,
  PbiTable,
  PbiTarget
} from '@shared/analysisPowerBi'
const props = defineProps<{ task: AnalysisTask; globalBusy: boolean; mode: 'local' | 'cloud' }>()
const emit = defineEmits<{ updated: [task: AnalysisTask]; busy: [value: boolean] }>()
const { t } = useI18n(),
  client = createAnalysisClient()
const auth = ref<PbiAuthStatus>({ application: null, account: null }),
  binding = ref<PbiBinding | null>(null)
const application = reactive({
  clientId: '',
  tenantId: '',
  environment: 'global' as 'global' | 'china'
})
const locals = ref<PbiLocalModel[]>([]),
  models = ref<PbiCloudModel[]>([])
const workspaces = ref<Awaited<ReturnType<typeof client.pbiWorkspaces>>>([])
const selected = ref(''),
  workspace = ref(''),
  port = ref<number>(),
  scanned = ref(false)
const schema = ref<PbiSchema | null>(null),
  table = ref(''),
  preview = ref<PbiTable | null>(null)
const busy = ref(false),
  request = ref(''),
  stage = ref('connecting'),
  error = ref(''),
  notice = ref('')
const target = ref<'connection' | 'query'>('connection'),
  feedback = ref<HTMLElement | null>(null)
const dax = ref('EVALUATE ROW("Value", 1)'),
  title = ref(''),
  transport = ref<'rest' | 'xmla'>('rest')
const disabled = computed(() => busy.value || props.globalBusy)
const selectedBinding = computed(() =>
  binding.value?.target.kind === props.mode &&
  (props.mode === 'local' ||
    (binding.value.target.kind === 'cloud' &&
      binding.value.target.model.accountId === auth.value.account?.id))
    ? binding.value
    : null
)
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const validApp = computed(
  () => uuid.test(application.clientId.trim()) && uuid.test(application.tenantId.trim())
)
const validPort = computed(
  () => Number.isInteger(port.value) && port.value! > 0 && port.value! <= 65535
)
let timer: ReturnType<typeof setInterval> | undefined,
  alive = true
function report(cause: unknown) {
  const code =
    cause instanceof Error &&
    AnalysisErrorCodes.includes(cause.message as (typeof AnalysisErrorCodes)[number])
      ? cause.message
      : 'PBI_CONNECT_FAILED'
  error.value = t('analysis.errors.' + code)
}
function reveal() {
  void nextTick(() => feedback.value?.scrollIntoView({ block: 'nearest' }))
}
async function act(
  action: (id: string) => Promise<void>,
  at: 'connection' | 'query' = 'connection',
  network = true
) {
  if (disabled.value) return
  busy.value = true
  emit('busy', true)
  error.value = ''
  notice.value = ''
  target.value = at
  const id = crypto.randomUUID()
  if (network) {
    request.value = id
    stage.value = 'connecting'
    timer = setInterval(() => {
      void client
        .pbiStatus(props.task.id)
        .then((p) => {
          if (p && request.value === id) stage.value = p.stage
        })
        .catch(() => {})
    }, 800)
  }
  reveal()
  try {
    await action(id)
  } catch (cause) {
    if (alive) report(cause)
  } finally {
    if (timer) clearInterval(timer)
    timer = undefined
    request.value = ''
    if (alive) {
      busy.value = false
      emit('busy', false)
      reveal()
    }
  }
}
function clearModel() {
  schema.value = null
  table.value = ''
  preview.value = null
  error.value = ''
  notice.value = ''
}
function changeWorkspace() {
  models.value = []
  selected.value = ''
  clearModel()
}
function discover(manual = false) {
  void act(async (id) => {
    locals.value = await client.pbiDiscover(props.task.id, id, manual ? port.value : undefined)
    scanned.value = true
    selected.value = locals.value.length === 1 ? locals.value[0].id : ''
    clearModel()
  })
}
function configure() {
  void act(
    async () => {
      auth.value = await client.pbiConfigure({
        ...application,
        clientId: application.clientId.trim(),
        tenantId: application.tenantId.trim()
      })
      models.value = []
      workspaces.value = []
      selected.value = ''
      clearModel()
      notice.value = t('analysis.pbi.configured')
    },
    'connection',
    false
  )
}
function login() {
  void act(async (id) => {
    auth.value = await client.pbiLogin(props.task.id, id)
    models.value = []
    workspaces.value = []
    selected.value = ''
    clearModel()
    notice.value = t('analysis.pbi.signedIn')
  })
}
function logout() {
  void act(
    async () => {
      auth.value = await client.pbiLogout()
      models.value = []
      workspaces.value = []
      selected.value = ''
      clearModel()
    },
    'connection',
    false
  )
}
function loadWorkspaces() {
  void act(async (id) => {
    if (auth.value.account)
      workspaces.value = await client.pbiWorkspaces(props.task.id, id, auth.value.account.id)
  })
}
function loadModels() {
  void act(async (id) => {
    if (!auth.value.account) return
    models.value = await client.pbiModels(
      props.task.id,
      id,
      auth.value.account.id,
      workspace.value || null
    )
    selected.value = ''
    clearModel()
  })
}
function connect() {
  void act(
    async () => {
      let chosen: PbiTarget | undefined
      if (props.mode === 'local') {
        const model = locals.value.find((m) => m.id === selected.value)
        if (model) chosen = { kind: 'local', model }
      } else {
        const model = models.value.find((m) => m.datasetId === selected.value)
        if (model) chosen = { kind: 'cloud', model }
      }
      if (!chosen) return
      binding.value = await client.pbiBind(props.task.id, chosen)
      clearModel()
      title.value = chosen.model.name
      notice.value = t('analysis.pbi.bound')
    },
    'connection',
    false
  )
}
function readSchema() {
  void act(async (id) => {
    if (!selectedBinding.value) return
    schema.value = await client.pbiSchema(props.task.id, id, selectedBinding.value.id)
    table.value = ''
    preview.value = null
  })
}
function selectTable() {
  preview.value = null
  dax.value = "EVALUATE '" + table.value.replaceAll("'", "''") + "'"
  title.value = table.value
}
function showPreview() {
  void act(async (id) => {
    if (selectedBinding.value)
      preview.value = await client.pbiPreview(
        props.task.id,
        id,
        selectedBinding.value.id,
        table.value,
        transport.value
      )
  })
}
function query() {
  void act(async (id) => {
    if (selectedBinding.value)
      emit(
        'updated',
        await client.pbiQuery(props.task.id, {
          requestId: id,
          bindingId: selectedBinding.value.id,
          title: title.value.trim(),
          dax: dax.value.trim(),
          transport: transport.value
        })
      )
  }, 'query')
}
async function cancel() {
  if (!request.value) return
  try {
    if (!(await client.pbiCancel(props.task.id, request.value)))
      notice.value = t('analysis.data.commitInProgress')
  } catch (cause) {
    report(cause)
  }
}
onMounted(() => {
  void Promise.allSettled([client.pbiAuth(), client.pbiBinding(props.task.id)])
    .then(([a, b]) => {
      if (!alive) return
      if (a.status === 'fulfilled') {
        auth.value = a.value
        if (a.value.application) Object.assign(application, a.value.application)
      } else if (props.mode === 'cloud') report(a.reason)
      if (b.status === 'fulfilled') {
        binding.value = b.value
        if (b.value?.target.kind === props.mode) title.value = b.value.target.model.name
      } else report(b.reason)
    })
    .catch(report)
})
onBeforeUnmount(() => {
  alive = false
  if (timer) clearInterval(timer)
  if (request.value) void client.pbiCancel(props.task.id, request.value).catch(() => {})
})
</script>
<template>
  <section
    class="pbi-panel"
    data-testid="pbi-panel"
    :aria-label="t(mode === 'local' ? 'analysis.localPbi' : 'analysis.cloudPbi')"
  >
    <h2>{{ t(mode === 'local' ? 'analysis.pbi.localTitle' : 'analysis.pbi.cloudTitle') }}</h2>
    <p class="muted">
      {{ t(mode === 'local' ? 'analysis.pbi.localHint' : 'analysis.pbi.cloudHint') }}
    </p>
    <template v-if="mode === 'local'">
      <div class="actions">
        <Button
          variant="outline"
          :disabled="disabled"
          data-testid="pbi-discover"
          @click="discover()"
          >{{ t('analysis.pbi.discover') }}</Button
        >
      </div>
      <p v-if="scanned && !locals.length" class="muted" data-testid="pbi-empty">
        {{ t('analysis.pbi.empty') }}
      </p>
      <details class="manual">
        <summary>{{ t('analysis.pbi.manualPort') }}</summary>
        <div class="actions">
          <label
            >{{ t('analysis.data.port')
            }}<input
              v-model.number="port"
              type="number"
              min="1"
              max="65535"
              :disabled="disabled"
              data-testid="pbi-port" /></label
          ><Button variant="outline" :disabled="disabled || !validPort" @click="discover(true)">{{
            t('analysis.pbi.connectPort')
          }}</Button>
        </div>
      </details>
      <label
        >{{ t('analysis.pbi.model')
        }}<select
          v-model="selected"
          :disabled="disabled || !locals.length"
          data-testid="pbi-local-model"
        >
          <option value="">{{ t('analysis.pbi.chooseModel') }}</option>
          <option v-for="m in locals" :key="m.id" :value="m.id">
            {{ m.name }} · {{ m.port }} · {{ m.databaseId }}
          </option>
        </select></label
      >
    </template>
    <template v-else>
      <details :open="!auth.application" class="application">
        <summary>{{ t('analysis.pbi.application') }}</summary>
        <div class="fields">
          <label
            >{{ t('analysis.pbi.environment')
            }}<select
              v-model="application.environment"
              :disabled="disabled"
              data-testid="pbi-environment"
            >
              <option value="global">{{ t('analysis.pbi.global') }}</option>
              <option value="china">{{ t('analysis.pbi.china') }}</option>
            </select></label
          ><label
            >Client ID<input
              v-model="application.clientId"
              :disabled="disabled"
              spellcheck="false"
              data-testid="pbi-client-id" /></label
          ><label
            >Tenant ID<input
              v-model="application.tenantId"
              :disabled="disabled"
              spellcheck="false"
              data-testid="pbi-tenant-id"
          /></label>
        </div>
        <p class="muted">{{ t('analysis.pbi.applicationHint') }}</p>
        <Button
          variant="outline"
          :disabled="disabled || !validApp"
          data-testid="pbi-configure"
          @click="configure"
          >{{ t('analysis.pbi.saveApplication') }}</Button
        >
      </details>
      <div class="account">
        <p v-if="auth.account" data-testid="pbi-account">
          {{ auth.account.name }} · {{ auth.account.username }}
        </p>
        <p v-else class="muted">{{ t('analysis.pbi.notSignedIn') }}</p>
        <div class="actions">
          <Button
            variant="outline"
            :disabled="disabled || !auth.application"
            data-testid="pbi-login"
            @click="login"
            >{{ t(auth.account ? 'analysis.pbi.switchAccount' : 'analysis.pbi.login') }}</Button
          ><Button v-if="auth.account" variant="ghost" :disabled="disabled" @click="logout">{{
            t('analysis.pbi.logout')
          }}</Button>
        </div>
      </div>
      <div class="actions">
        <Button
          variant="outline"
          :disabled="disabled || !auth.account"
          data-testid="pbi-workspaces"
          @click="loadWorkspaces"
          >{{ t('analysis.pbi.loadWorkspaces') }}</Button
        >
      </div>
      <label
        >{{ t('analysis.pbi.workspace')
        }}<select
          v-model="workspace"
          :disabled="disabled || !auth.account"
          data-testid="pbi-workspace"
          @change="changeWorkspace"
        >
          <option value="">{{ t('analysis.pbi.personal') }}</option>
          <option v-for="w in workspaces" :key="w.id" :value="w.id">
            {{ w.name }} · {{ w.id }}
          </option>
        </select></label
      >
      <div class="actions">
        <Button
          variant="outline"
          :disabled="disabled || !auth.account"
          data-testid="pbi-load-models"
          @click="loadModels"
          >{{ t('analysis.pbi.loadModels') }}</Button
        >
      </div>
      <label
        >{{ t('analysis.pbi.model')
        }}<select
          v-model="selected"
          :disabled="disabled || !models.length"
          data-testid="pbi-cloud-model"
        >
          <option value="">{{ t('analysis.pbi.chooseModel') }}</option>
          <option v-for="m in models" :key="m.datasetId" :value="m.datasetId">
            {{ m.name }} · {{ m.datasetId }}
          </option>
        </select></label
      >
    </template>
    <div class="actions">
      <Button
        variant="outline"
        :disabled="disabled || !selected"
        data-testid="pbi-bind"
        @click="connect"
        >{{ t('analysis.pbi.bind') }}</Button
      >
    </div>
    <p v-if="selectedBinding" class="bound" data-testid="pbi-bound">
      {{ t('analysis.pbi.currentModel') }} · {{ selectedBinding.target.model.name }}<br /><span
        class="muted"
        >{{
          selectedBinding.target.kind === 'local'
            ? selectedBinding.target.model.databaseId
            : selectedBinding.target.model.datasetId
        }}</span
      >
    </p>
    <div v-if="target === 'connection'" ref="feedback" class="feedback" aria-live="polite">
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <p v-if="notice">{{ notice }}</p>
      <div v-if="busy" class="actions">
        <span>{{ t('analysis.pbi.stages.' + stage) }}</span
        ><Button v-if="request" variant="ghost" :disabled="stage === 'saving'" @click="cancel">{{
          t('analysis.cancel')
        }}</Button>
      </div>
    </div>
    <template v-if="selectedBinding">
      <div class="metadata">
        <h3>{{ t('analysis.pbi.schema') }}</h3>
        <p v-if="mode === 'cloud'" class="muted">{{ t('analysis.pbi.xmlaHint') }}</p>
        <Button
          variant="outline"
          :disabled="disabled"
          data-testid="pbi-schema"
          @click="readSchema"
          >{{ t('analysis.pbi.readSchema') }}</Button
        >
        <div v-if="schema" class="schema" data-testid="pbi-schema-result">
          <p class="muted">
            {{ schema.source }} · {{ new Date(schema.fetchedAt).toLocaleString() }}
          </p>
          <p class="muted">
            {{ t('analysis.pbi.coverage') }} ·
            {{
              ['tables', 'columns', 'measures', 'relationships']
                .map(
                  (k) =>
                    t('analysis.pbi.' + k) +
                    ': ' +
                    t('analysis.pbi.' + schema!.coverage[k as keyof typeof schema.coverage])
                )
                .join(' · ')
            }}
          </p>
          <details v-for="s in schema.tables" :key="s.name">
            <summary>
              {{ s.name }} · {{ t('analysis.pbi.columnCount', { count: s.columns.length }) }} ·
              {{ t('analysis.pbi.measureCount', { count: s.measures.length }) }}
            </summary>
            <ul>
              <li v-for="c in s.columns" :key="'c-' + c.name">
                {{ c.name }} · {{ c.type
                }}<span v-if="c.hidden"> · {{ t('analysis.pbi.hidden') }}</span>
              </li>
              <li v-for="m in s.measures" :key="'m-' + m.name">
                <strong>{{ m.name }}</strong> · {{ t('analysis.pbi.measure') }}
                <pre>{{ m.expression }}</pre>
              </li>
            </ul>
          </details>
          <details v-if="schema.relationships.length">
            <summary>
              {{ t('analysis.pbi.relationships') }} · {{ schema.relationships.length }}
            </summary>
            <p v-for="r in schema.relationships" :key="r.name">
              {{ r.fromTable }}.{{ r.fromColumn }} → {{ r.toTable }}.{{ r.toColumn }} ·
              {{ t(r.active ? 'analysis.pbi.active' : 'analysis.pbi.inactive') }}
            </p>
          </details>
          <label v-if="schema.tables.length"
            >{{ t('analysis.pbi.previewTable')
            }}<select v-model="table" :disabled="disabled" @change="selectTable">
              <option value="">{{ t('analysis.pbi.chooseTable') }}</option>
              <option v-for="s in schema.tables" :key="s.name" :value="s.name">{{ s.name }}</option>
            </select></label
          ><Button
            v-if="table"
            variant="outline"
            :disabled="disabled"
            data-testid="pbi-preview"
            @click="showPreview"
            >{{ t('analysis.pbi.preview') }}</Button
          >
        </div>
        <div
          v-if="preview"
          class="table-scroll"
          tabindex="0"
          :aria-label="t('analysis.pbi.preview')"
        >
          <table>
            <thead>
              <tr>
                <th v-for="c in preview.columns" :key="c.name" scope="col">{{ c.name }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, i) in preview.rows" :key="i">
                <td v-for="(cell, j) in row" :key="j">{{ cell ?? '—' }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="!preview.rows.length">{{ t('analysis.pbi.noRows') }}</p>
        </div>
      </div>
      <div class="query">
        <h3>{{ t('analysis.pbi.queryTitle') }}</h3>
        <p class="muted">{{ t('analysis.pbi.queryHint') }}</p>
        <label v-if="mode === 'cloud'"
          >{{ t('analysis.pbi.transport')
          }}<select v-model="transport" :disabled="disabled" data-testid="pbi-transport">
            <option value="rest">REST · ExecuteQueries</option>
            <option value="xmla">XMLA · ADOMD</option>
          </select></label
        ><label
          >{{ t('analysis.data.snapshotName')
          }}<input
            v-model="title"
            maxlength="100"
            :disabled="disabled"
            data-testid="pbi-title" /></label
        ><label
          >DAX<textarea
            v-model="dax"
            rows="7"
            maxlength="20000"
            :disabled="disabled"
            spellcheck="false"
            data-testid="pbi-dax"
          />
        </label>
        <div
          v-if="target === 'query'"
          ref="feedback"
          class="feedback"
          aria-live="polite"
          data-testid="pbi-query-feedback"
        >
          <p v-if="error" role="alert" class="error">{{ error }}</p>
          <p v-if="notice">{{ notice }}</p>
          <div v-if="busy" class="actions">
            <span>{{ t('analysis.pbi.stages.' + stage) }}</span
            ><Button
              v-if="request"
              variant="ghost"
              :disabled="stage === 'saving'"
              data-testid="pbi-cancel"
              @click="cancel"
              >{{ t('analysis.cancel') }}</Button
            >
          </div>
        </div>
        <Button
          :disabled="disabled || !title.trim() || !dax.trim()"
          data-testid="pbi-query"
          @click="query"
          >{{ t('analysis.pbi.saveSnapshot') }}</Button
        >
      </div>
    </template>
  </section>
</template>
<style scoped>
.pbi-panel {
  padding-top: 16px;
  max-width: 100%;
  font-size: 13px;
  line-height: 1.7;
  color: var(--foreground);
}
h2 {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 8px;
}
h3 {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 8px;
}
.muted {
  color: var(--analysis-muted);
}
p {
  margin: 8px 0;
  overflow-wrap: anywhere;
}
.fields {
  display: grid;
  grid-template-columns: 1fr;
  gap: 10px;
  margin: 12px 0;
}
label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 12px 0;
  font-weight: 500;
  min-width: 0;
}
input,
select,
textarea {
  width: 100%;
  min-width: 0;
  border: 1px solid var(--border);
  background: var(--background);
  color: var(--foreground);
  border-radius: 5px;
  padding: 8px 10px;
  font-size: 13px;
  font-weight: 400;
  caret-color: var(--analysis-blue);
  accent-color: var(--analysis-blue);
}
input::placeholder,
textarea::placeholder {
  color: var(--analysis-muted);
}
textarea {
  resize: vertical;
  font-family: Consolas, monospace;
  line-height: 1.7;
  tab-size: 2;
}
select {
  overflow: hidden;
  text-overflow: ellipsis;
}
input:disabled,
select:disabled,
textarea:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
input:focus-visible,
select:focus-visible,
textarea:focus-visible,
summary:focus-visible,
.table-scroll:focus-visible {
  outline: 2px solid var(--analysis-blue);
  outline-offset: 2px;
}
.actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin: 12px 0;
}
.manual,
.application {
  margin: 16px 0;
}
summary {
  cursor: pointer;
  overflow-wrap: anywhere;
}
summary:hover {
  color: var(--analysis-blue);
}
.account,
.metadata,
.query {
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}
.bound {
  padding: 12px;
  background: color-mix(in srgb, var(--analysis-blue) 5%, var(--background));
  border: 1px solid var(--border);
  border-radius: 5px;
}
.schema {
  margin-top: 12px;
}
.schema details {
  margin: 10px 0;
}
.schema ul {
  padding-left: 20px;
}
.schema li {
  margin: 4px 0;
  overflow-wrap: anywhere;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font:
    12px/1.7 Consolas,
    monospace;
  margin: 6px 0;
}
.feedback:empty {
  display: none;
}
.error {
  color: color-mix(in srgb, var(--destructive) 72%, var(--foreground));
}
:global(.dark .pbi-panel .error) {
  color: color-mix(in srgb, var(--destructive) 50%, var(--foreground));
}
.table-scroll {
  overflow: auto;
  max-width: 100%;
  max-height: 280px;
  margin: 16px 0;
  scrollbar-color: var(--analysis-muted) transparent;
}
table {
  border-collapse: collapse;
  width: max-content;
  min-width: 100%;
  font-variant-numeric: tabular-nums;
}
th,
td {
  text-align: left;
  vertical-align: top;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  max-width: 300px;
  overflow-wrap: anywhere;
}
th {
  font-weight: 600;
  position: sticky;
  top: 0;
  background: var(--background);
}
::selection {
  background: color-mix(in srgb, var(--analysis-blue) 22%, transparent);
  color: var(--foreground);
}
</style>
