<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import type { AnalysisContext, TaskPanelState } from '@shared/analysisInteraction'
import type { AnalysisInsertion } from './interactionContext'
import { useSidepanelStore } from '@/stores/ui/sidepanel'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { Button } from '@shadcn/components/ui/button'
import { createAnalysisClient } from '@api/AnalysisClient'
import { createConfigClient } from '@api/ConfigClient'
import ChatPage from '@/features/chat-page/ChatPage.vue'
import ChatSidePanel from '@/components/sidepanel/ChatSidePanel.vue'
import AgentBrowserPiP from '@/components/browser/AgentBrowserPiP.vue'
import AgentComputerUsePiP from '@/components/computerUse/AgentComputerUsePiP.vue'
import { useSessionStore } from '@/stores/ui/session'
import { useAgentStore } from '@/stores/ui/agent'
import { useProjectStore } from '@/stores/ui/project'
import { useModelStore } from '@/stores/modelStore'
import { markStartupInteractive } from '@/lib/startupDeferred'

const props = defineProps<{
  taskId: string
  insertion?: AnalysisInsertion | null
  panelState?: TaskPanelState['sidepanel']
}>()
const emit = defineEmits<{
  ready: [sessionId: string]
  loading: [busy: boolean]
  'analysis-inserted': [key: string]
  'analysis-locate': [context: AnalysisContext]
  'session-forked': [sessionId: string]
  'panel-state': [state: NonNullable<TaskPanelState['sidepanel']>]
}>()
const { t } = useI18n()
const client = createAnalysisClient()
const config = createConfigClient()
const sessions = useSessionStore()
const agents = useAgentStore()
const projects = useProjectStore()
const models = useModelStore()
const sidepanel = useSidepanelStore()
let restoringPanel = true
watch(
  () => [
    sidepanel.open,
    sidepanel.activeTab,
    sidepanel.width,
    sidepanel.navWidth,
    sidepanel.navCollapsed
  ],
  () => {
    if (restoringPanel || disposed || !sessionId.value) return
    emit('panel-state', {
      open: sidepanel.open,
      tab: sidepanel.activeTab === 'browser' ? 'browser' : 'workspace',
      width: Math.min(960, Math.max(240, sidepanel.width)),
      navWidth: sidepanel.navWidth,
      navCollapsed: sidepanel.navCollapsed
    })
  }
)
const sessionId = ref('')
const error = ref('')
const loading = ref(false)
let disposed = false

async function open() {
  if (loading.value) return
  error.value = ''
  loading.value = true
  emit('loading', true)
  try {
    const id = await client.workspaceChat(props.taskId)
    if (disposed) return
    await Promise.all([agents.fetchAgents(), models.initialize(), projects.fetchProjects()])
    if (disposed) return
    await sessions.selectSession(id)
    if (disposed) return
    if (sessions.activeSessionId !== id || sessions.error)
      throw new Error('WORKSPACE_SESSION_MISSING')
    markStartupInteractive()
    const state = props.panelState
    sidepanel.closePanel()
    if (state) {
      sidepanel.setWidth(state.width)
      sidepanel.setNavWidth(state.navWidth)
      sidepanel.setNavCollapsed(state.navCollapsed)
      if (state.open) {
        if (state.tab === 'browser') sidepanel.openBrowser()
        else sidepanel.openWorkspace(id)
      }
    }
    sessionId.value = id
    queueMicrotask(() => {
      restoringPanel = false
    })
    emit('ready', id)
  } catch (cause) {
    if (!disposed)
      error.value =
        cause instanceof Error && cause.message === 'MODEL_NOT_CONFIGURED'
          ? 'MODEL_NOT_CONFIGURED'
          : 'WORKSPACE_SESSION_MISSING'
  } finally {
    loading.value = false
    if (!disposed) emit('loading', false)
  }
}
onMounted(() => {
  void open()
})
onBeforeUnmount(() => {
  disposed = true
  emit('loading', false)
})
</script>

<template>
  <section
    class="task-conversation"
    data-testid="task-conversation"
    :aria-label="t('analysis.workspace.conversation')"
    :aria-busy="loading"
  >
    <div v-if="loading || error" class="conversation-state" :role="error ? 'alert' : 'status'">
      <Icon
        :icon="loading ? 'lucide:loader-circle' : 'lucide:message-square-warning'"
        aria-hidden="true"
        :class="{ spinning: loading }"
      />
      <p>{{ t(loading ? 'analysis.workspace.opening' : 'analysis.errors.' + error) }}</p>
      <div v-if="error" class="conversation-actions">
        <Button
          type="button"
          variant="outline"
          data-testid="task-conversation-retry"
          @click="open"
          >{{ t('analysis.workspace.retry') }}</Button
        >
        <Button type="button" variant="outline" @click="config.openSettings()">{{
          t('analysis.openSettings')
        }}</Button>
      </div>
    </div>
    <template v-else-if="sessionId">
      <div class="conversation-content">
        <ChatPage
          :key="sessionId"
          :session-id="sessionId"
          :analysis-task-id="taskId"
          :analysis-insertion="insertion"
          @analysis-inserted="emit('analysis-inserted', $event)"
          @analysis-locate="emit('analysis-locate', $event)"
          @session-forked="emit('session-forked', $event)"
        />
        <AgentBrowserPiP :session-id="sessionId" />
        <AgentComputerUsePiP :session-id="sessionId" />
      </div>
      <ChatSidePanel
        :session-id="sessionId"
        :workspace-path="sessions.activeSession?.projectDir ?? null"
      />
    </template>
  </section>
</template>

<style scoped>
.task-conversation {
  display: flex;
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.conversation-content {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
}
.task-conversation
  :deep(
    .chat-side-panel-shell:not([data-workspace-fullscreen='true']):not(
        [data-browser-fullscreen='true']
      ):not([data-tape-inspector-fullscreen='true'])
  ) {
  max-width: 52%;
}
.conversation-state {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 16px;
  align-items: center;
  justify-content: center;
  padding: 32px;
  text-align: center;
}
.conversation-state > svg {
  width: 28px;
  height: 28px;
  color: var(--analysis-blue);
}
.conversation-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  justify-content: center;
}
.task-conversation :focus-visible {
  outline: 2px solid var(--analysis-blue);
  outline-offset: 3px;
}
.task-conversation :deep(.chat-input-editor .tiptap p.is-editor-empty:first-child::before) {
  color: var(--analysis-muted);
  opacity: 1;
}
.spinning {
  animation: conversation-spin 1s linear infinite;
}
@keyframes conversation-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spinning {
    animation: none;
  }
}
</style>
