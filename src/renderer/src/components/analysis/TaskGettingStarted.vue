<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { Button } from '@shadcn/components/ui/button'
import { createAnalysisClient } from '@api/AnalysisClient'
import { GuideStateSchema } from '@shared/analysisInteraction'
const props = defineProps<{
  taskId?: string
  hasTask: boolean
  hasFiles: boolean
  hasResults: boolean
}>()
defineEmits<{ action: [kind: 'model' | 'task' | 'data' | 'file' | 'advanced']; back: [] }>()
const { t } = useI18n()
const client = createAnalysisClient()
const state = ref(GuideStateSchema.parse({}))
const loading = ref(true)
const error = ref(false)
const modelReady = ref(false)
type Availability = 'checking' | 'ready' | 'pending' | 'partial' | 'unavailable'
const dataAvailability = ref<Availability>('pending')
const fileAvailability = ref<Availability>('pending')
let availabilityRequest = 0
let disposed = false
async function refreshAvailability() {
  const taskId = props.taskId
  const request = ++availabilityRequest
  if (!taskId) {
    dataAvailability.value = 'pending'
    fileAvailability.value = 'pending'
    return
  }
  dataAvailability.value = 'checking'
  fileAvailability.value = props.hasFiles ? 'checking' : 'pending'
  try {
    // Read registered file/connection schemas, without materializing data or running analysis.
    const catalog = await client.referenceCatalog(taskId)
    if (disposed || request !== availabilityRequest || taskId !== props.taskId) return
    const files = catalog.items.some((item) => item.selector.sourceId)
    dataAvailability.value = catalog.items.length
      ? catalog.issues.length
        ? 'partial'
        : 'ready'
      : catalog.issues.length
        ? 'unavailable'
        : 'pending'
    fileAvailability.value = files ? 'ready' : props.hasFiles ? 'unavailable' : 'pending'
  } catch {
    if (!disposed && request === availabilityRequest) {
      dataAvailability.value = 'unavailable'
      fileAvailability.value = props.hasFiles ? 'unavailable' : 'pending'
    }
  }
}
watch(
  () => [props.taskId, props.hasFiles],
  () => {
    void refreshAvailability()
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  disposed = true
  ++availabilityRequest
})
const topics = ['model', 'task', 'data', 'file', 'advanced'] as const
async function load() {
  loading.value = true
  error.value = false
  try {
    const [saved, models] = await Promise.all([client.guide(), client.models()])
    state.value = saved
    modelReady.value = models.some((model) => model.isDefault)
    await client.saveGuide({ seen: true })
  } catch {
    error.value = true
  } finally {
    loading.value = false
  }
}
async function toggle(topic: (typeof topics)[number]) {
  const next = state.value.topics.includes(topic)
    ? state.value.topics.filter((item) => item !== topic)
    : [...state.value.topics, topic]
  state.value = { ...state.value, topics: next }
  try {
    await client.saveGuide({ topics: next })
  } catch {
    error.value = true
  }
}
async function toggleExample() {
  state.value.exampleOpen = !state.value.exampleOpen
  try {
    await client.saveGuide({ exampleOpen: state.value.exampleOpen })
  } catch {
    error.value = true
  }
}
const availability = (topic: (typeof topics)[number]): Availability =>
  topic === 'data'
    ? dataAvailability.value
    : topic === 'file'
      ? fileAvailability.value
      : (topic === 'model' ? modelReady.value : topic === 'task' ? props.hasTask : props.hasResults)
        ? 'ready'
        : 'pending'
onMounted(() => void load())
</script>
<template>
  <section
    class="task-getting-started"
    data-testid="getting-started-page"
    :aria-label="t('analysis.guide.title')"
    :aria-busy="loading"
  >
    <Button variant="ghost" class="back" @click="$emit('back')"
      ><Icon icon="lucide:arrow-left" aria-hidden="true" />{{ t('analysis.guide.back') }}</Button
    >
    <h1>{{ t('analysis.guide.title') }}</h1>
    <p class="intro">{{ t('analysis.guide.intro') }}</p>
    <p v-if="loading" role="status">{{ t('analysis.guide.loading') }}</p>
    <div v-if="error" class="guide-error" role="alert">
      {{ t('analysis.guide.error') }}
      <Button variant="outline" @click="load">{{ t('analysis.workspace.retry') }}</Button>
    </div>
    <section class="guide-topics" :aria-label="t('analysis.guide.topics')">
      <div v-for="topic in topics" :key="topic" :data-testid="'getting-started-topic-' + topic">
        <button
          class="topic-toggle"
          :disabled="loading"
          type="button"
          :aria-expanded="state.topics.includes(topic)"
          :aria-controls="'guide-topic-' + topic"
          @click="toggle(topic)"
        >
          <span>{{ t('analysis.guide.' + topic + 'Help') }}</span
          ><span class="topic-state">{{ t('analysis.guide.' + availability(topic)) }}</span
          ><Icon
            :icon="state.topics.includes(topic) ? 'lucide:chevron-up' : 'lucide:chevron-down'"
            aria-hidden="true"
          />
        </button>
        <div v-if="state.topics.includes(topic)" :id="'guide-topic-' + topic" class="topic-body">
          <p>{{ t('analysis.guide.' + topic + 'Body') }}</p>
          <p
            v-if="topic === 'data' && ['partial', 'unavailable'].includes(dataAvailability)"
            role="status"
          >
            {{ t('analysis.guide.connectionIssue') }}
          </p>
          <Button
            variant="outline"
            :data-testid="'guide-action-' + topic"
            @click="$emit('action', topic)"
            >{{ t('analysis.guide.' + topic + 'Action') }}</Button
          >
          <Button
            v-if="topic === 'data' && taskId"
            class="recheck"
            variant="outline"
            :disabled="dataAvailability === 'checking'"
            data-testid="guide-recheck-data"
            @click="refreshAvailability"
            >{{ t('analysis.guide.recheck') }}</Button
          >
        </div>
      </div>
    </section>
    <section class="offline-example" data-testid="offline-examples">
      <h2>{{ t('analysis.guide.demo') }}</h2>
      <p>{{ t('analysis.guide.demoIntro') }}</p>
      <h3>{{ t('analysis.guide.reportTitle') }}</h3>
      <table>
        <thead>
          <tr>
            <th>{{ t('analysis.guide.metric') }}</th>
            <th>{{ t('analysis.guide.amount') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="[key, value] in [
              ['actual', 80],
              ['target', 100],
              ['gap', 20]
            ]"
            :key="key"
          >
            <td>{{ t('analysis.guide.' + key) }}</td>
            <td>{{ value }}</td>
          </tr>
        </tbody>
      </table>
      <p>{{ t('analysis.guide.reportBody') }}</p>
      <button
        class="example-source"
        :disabled="loading"
        type="button"
        data-testid="getting-started-source-trigger"
        :aria-expanded="state.exampleOpen"
        @click="toggleExample"
      >
        <Icon icon="lucide:database" aria-hidden="true" />{{ t('analysis.guide.source') }}
      </button>
      <p v-if="state.exampleOpen" class="example-detail">{{ t('analysis.guide.sourceBody') }}</p>
      <h3>{{ t('analysis.guide.noteTitle') }}</h3>
      <p>{{ t('analysis.guide.noteBody') }}</p>
    </section>
  </section>
</template>
<style scoped>
.task-getting-started {
  max-width: 860px;
  width: 100%;
  margin: 0 auto;
  padding: 28px 32px 48px;
  color: var(--foreground);
  font-size: 13px;
  overflow-wrap: anywhere;
}
.back {
  gap: 6px;
  margin-bottom: 18px;
}
.back svg {
  width: 15px;
  height: 15px;
}
h1 {
  font-size: 24px;
  font-weight: 600;
  margin-bottom: 12px;
}
h2 {
  font-size: 18px;
  font-weight: 600;
  margin-bottom: 10px;
}
h3 {
  font-size: 15px;
  font-weight: 600;
  margin-block: 22px 10px;
}
p {
  line-height: 1.8;
  max-width: 75ch;
}
.intro,
.topic-state,
.offline-example > p,
.topic-body > p {
  color: color-mix(in srgb, var(--foreground) 68%, var(--background));
}
.intro {
  margin-bottom: 24px;
}
.guide-topics {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.guide-topics > div + div {
  border-top: 1px solid var(--border);
}
.topic-toggle {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 15px 16px;
  text-align: left;
  font-weight: 500;
}
.topic-toggle > span:first-child {
  flex: 1;
}
.topic-toggle > svg {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}
.topic-toggle:hover {
  background: var(--accent);
}
.topic-state {
  font-size: 12px;
  font-weight: 400;
}
.topic-body {
  padding: 0 16px 18px;
}
.topic-body > p {
  margin-bottom: 14px;
}
.recheck {
  margin-inline-start: 8px;
}
.offline-example {
  margin-top: 28px;
  padding-top: 24px;
  border-top: 1px solid var(--border);
}
table {
  width: 100%;
  max-width: 340px;
  margin-block: 16px;
  border-collapse: collapse;
}
th,
td {
  padding: 9px 8px;
  border-bottom: 1px solid var(--border);
  text-align: left;
}
th:last-child,
td:last-child {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.example-source {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 0;
  margin-top: 10px;
  color: var(--analysis-blue, var(--primary));
}
.example-source svg {
  width: 14px;
  height: 14px;
}
.example-detail {
  border: 1px solid var(--border);
  padding: 12px;
  border-radius: 5px;
}
.guide-error {
  margin-block: 14px;
  display: flex;
  align-items: center;
  gap: 10px;
}
button:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: -2px;
}
@media (max-width: 1000px) {
  .task-getting-started {
    padding: 24px 20px;
  }
}
</style>
