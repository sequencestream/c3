<script setup lang="ts">
/*
 * Files.vue — 文件浏览页容器。
 *
 * 桌面三栏:左 FileTree(搜索框 + 懒加载树)/ 中 FileTabs(多 tab 文件查看)/ 右
 * 内嵌 ChatColumn(按需显示的修改会话,与 Works 共用控制层单一活动会话)。右侧会话栏
 * 由 FileTree 标题栏的开关按钮控制显隐,状态经 `usePersistentToggle` 跨刷新保持,默认关闭。
 * 中右之间一根可拖拽垂直分隔条 `.files-col-splitter` 调节会话栏宽度(像素,按 workspace 持久化)。
 * 移动端经 MobileStack 退化为 树 → 文件 两级 drill-down,不渲染 ChatColumn(屏幕宽度不足)。
 *
 * 所有状态由 App.vue 持有、经 props 注入,动作经 emit 上抛(controls/files-actions 落地
 * 服务端往返)。前端仅持有并透传 workspace 相对路径 + 不透明 workspaceName;任何越界判断
 * 由服务端 guard 决定,本页不存在构造绝对路径/越界路径的入口。
 */
import { computed, onUnmounted, ref } from 'vue'
import MobileStack from '../../components/MobileStack/MobileStack.vue'
import ChatColumn from '../../components/ChatColumn/ChatColumn.vue'
import FileTree from './components/FileTree/FileTree.vue'
import FileTabs from './components/FileTabs/FileTabs.vue'
import { useIsMobile } from '../../composables/useBreakpoint'
import { usePersistentToggle } from '@/composables/usePersistentToggle'
import { useTypedI18n } from '@/i18n'
import {
  FILES_CHAT_WIDTH_MIN,
  FILES_CHAT_WIDTH_MAX,
  FILES_CHAT_WIDTH_DEFAULT,
} from '../../controls/state'
import type { FileEntry, FileGitStatus, FileSearchHit, FileSearchMode } from '@ccc/shared/protocol'
import type {
  CodexPolicy,
  ModeToken,
  PromptImage,
  SessionAgentSwitch,
  SlashCommandInfo,
  VendorId,
} from '@ccc/shared/protocol'
import type { FileTab, FilesSearchResultView } from '@/lib/files-view'
import type { PendingItem } from '../../lib/pending-queue'
import type { TaskListModel } from '../../lib/task-list'
import type { ChatMsg, PermissionMsg, RunActivity } from '../../lib/chat-types'

const props = defineProps<{
  // left/middle: file browser
  dirs: Record<string, FileEntry[]>
  expanded: Set<string>
  loadingDirs: Set<string>
  /** Workspace Git-status snapshot (changed-file path → flags) decorating the tree. */
  gitStatus: Record<string, FileGitStatus>
  tabs: FileTab[]
  activePath: string | null
  activeTab: FileTab | null
  searchMode: FileSearchMode
  searchQuery: string
  searchPattern: string
  searchResult: FilesSearchResultView | null
  searchLoading: boolean
  // right: embedded ChatColumn (desktop only)
  /** This workspace's bound embedded-chat session id, or null when none (empty state). */
  filesBoundSessionId: string | null
  /** The persisted splitter width in pixels for this workspace. */
  filesChatWidth: number
  /** The control layer's single active session id (global), for content gating. */
  activeSession: string | null
  activeTitle: string
  vendor: VendorId | null
  agentSwitch: SessionAgentSwitch | null
  /** Permission-mode dropdown state for the bound session's title bar. */
  mode: ModeToken
  modeOptions: { value: ModeToken; label: string }[]
  codexPolicy: CodexPolicy | null
  messages: ChatMsg[]
  actionablePermissionId: string | null
  taskModel: TaskListModel
  hasTaskStore: boolean
  running: boolean
  teamActive: boolean
  connection: 'connecting' | 'open' | 'closed'
  activity: RunActivity
  currentAgentName: string
  reconnecting: boolean
  sideEffectPending: boolean
  queue: PendingItem[]
  availableCommands: SlashCommandInfo[]
  voiceLang: string
}>()

const emit = defineEmits<{
  // file browser
  'toggle-dir': [rel: string]
  'open-file': [path: string]
  'open-hit': [hit: FileSearchHit]
  'close-tab': [path: string]
  'select-tab': [path: string]
  'set-search-mode': [mode: FileSearchMode]
  'update:searchQuery': [value: string]
  'update:searchPattern': [value: string]
  'run-search': []
  'refresh-tree': []
  toast: [message: string]
  // embedded chat lifecycle
  'create-files-chat': []
  'reset-files-chat': []
  'files-chat-width': [px: number]
  // embedded chat passthrough (mirrors Works.vue → ChatColumn wiring)
  'set-mode': [mode: ModeToken]
  'set-codex-policy': [policy: CodexPolicy]
  'set-session-agent': [agentId: string]
  respond: [m: PermissionMsg, decision: 'allow' | 'deny']
  'submit-ask': [m: PermissionMsg, answers: Record<string, string>]
  refresh: []
  'edit-queued': [item: PendingItem]
  'delete-queued': [id: number]
  submit: [text: string, images: PromptImage[]]
  enqueue: [text: string, images: PromptImage[]]
  stop: []
  continue: []
  'list-commands': []
}>()

const { t } = useTypedI18n()

const rootEntries = computed<FileEntry[] | null>(() => props.dirs[''] ?? null)

const mobilePanes = [
  { key: 'tree', title: 'Files' },
  { key: 'viewer', title: 'Viewer' },
] as const
type MobilePaneKey = (typeof mobilePanes)[number]['key']

const mobileActiveKey = ref<MobilePaneKey>('tree')
const mobileActiveToken = computed(() => props.activePath ?? 'tree')

function openFile(path: string): void {
  mobileActiveKey.value = 'viewer'
  emit('open-file', path)
}
function openHit(hit: FileSearchHit): void {
  if (hit.type === 'file') mobileActiveKey.value = 'viewer'
  emit('open-hit', hit)
}
function handleMobileBack(targetKey: string): void {
  if (targetKey === 'tree') mobileActiveKey.value = 'tree'
}

// ---- Embedded ChatColumn (desktop only) ----
const isMobile = useIsMobile()

// 右侧修改会话是否显示。默认关闭:纯浏览文件时不占用横向空间。跨刷新持久化到
// localStorage(localStorage 不可用时 composable 内置降级为内存 ref)。关闭仅隐藏容器,
// 不清空会话绑定(filesBoundSessionId 等由控制层持有),再次打开直接复用既有会话。
const filesChatVisible = usePersistentToggle('c3.filesChatVisible')

// Whether this workspace has an embedded chat bound (drives create-vs-reset button).
const hasFilesSession = computed(() => props.filesBoundSessionId != null)
// Whether the bound session is actually the live active session — false during the
// brief select_session round-trip, so we never flash the previous session's content.
const chatActive = computed(
  () => hasFilesSession.value && props.activeSession === props.filesBoundSessionId,
)

// ---- Splitter drag / keyboard resize ----
const dragWidth = ref<number | null>(null)
const displayWidth = computed(() => dragWidth.value ?? props.filesChatWidth)

function clampWidth(px: number): number {
  return Math.min(FILES_CHAT_WIDTH_MAX, Math.max(FILES_CHAT_WIDTH_MIN, Math.round(px)))
}

let dragStartX = 0
let dragStartW = 0

function onSplitterDown(e: MouseEvent): void {
  dragStartX = e.clientX
  dragStartW = displayWidth.value
  dragWidth.value = dragStartW
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', onDragEnd)
  window.addEventListener('keydown', onDragKey)
  e.preventDefault()
}
function onDragMove(e: MouseEvent): void {
  // Chat is on the right: dragging left widens it.
  dragWidth.value = clampWidth(dragStartW + (dragStartX - e.clientX))
}
function onDragKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  dragWidth.value = dragStartW
  finishDrag()
}
function onDragEnd(): void {
  finishDrag()
}
function detachDragListeners(): void {
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', onDragEnd)
  window.removeEventListener('keydown', onDragKey)
}
function finishDrag(): void {
  detachDragListeners()
  const px = clampWidth(dragWidth.value ?? props.filesChatWidth)
  dragWidth.value = null
  emit('files-chat-width', px)
}

// Keyboard resize on the focused separator: ←/→ ±16px, Home = min, End = default.
function onSplitterKey(e: KeyboardEvent): void {
  let px = displayWidth.value
  if (e.key === 'ArrowLeft') px += 16
  else if (e.key === 'ArrowRight') px -= 16
  else if (e.key === 'Home') px = FILES_CHAT_WIDTH_MIN
  else if (e.key === 'End') px = FILES_CHAT_WIDTH_DEFAULT
  else return
  e.preventDefault()
  emit('files-chat-width', clampWidth(px))
}

onUnmounted(detachDragListeners)

// Forward the embedded ChatColumn's prefill so App.vue's queue-edit can fold text
// + images back into the composer (mirrors Works.vue / Intents.vue).
const chat = ref<InstanceType<typeof ChatColumn> | null>(null)
defineExpose({
  prefill: (text: string, images?: PromptImage[]) => chat.value?.prefill(text, images),
})
</script>

<template>
  <MobileStack
    :panes="mobilePanes"
    :active-key="mobileActiveKey"
    :active-token="mobileActiveToken"
    back-label="Files"
    @back="handleMobileBack"
  >
    <template #tree>
      <FileTree
        :root-entries="rootEntries"
        :dirs="dirs"
        :expanded="expanded"
        :loading-dirs="loadingDirs"
        :active-path="activePath"
        :git-status="gitStatus"
        :search-mode="searchMode"
        :search-query="searchQuery"
        :search-pattern="searchPattern"
        :search-result="searchResult"
        :search-loading="searchLoading"
        :show-chat="filesChatVisible"
        @toggle-dir="(rel: string) => emit('toggle-dir', rel)"
        @open-file="openFile"
        @open-hit="openHit"
        @set-search-mode="(m: FileSearchMode) => emit('set-search-mode', m)"
        @update:search-query="(v: string) => emit('update:searchQuery', v)"
        @update:search-pattern="(v: string) => emit('update:searchPattern', v)"
        @run-search="emit('run-search')"
        @refresh-tree="emit('refresh-tree')"
        @toggle-chat="filesChatVisible = !filesChatVisible"
        @toast="(message: string) => emit('toast', message)"
      />
    </template>

    <template #viewer>
      <FileTabs
        :tabs="tabs"
        :active-path="activePath"
        :active-tab="activeTab"
        @select="(path: string) => emit('select-tab', path)"
        @close="(path: string) => emit('close-tab', path)"
      />
    </template>
  </MobileStack>

  <!-- 桌面独占且开关开启:FileTabs 与内嵌修改会话之间的可拖拽分隔条 + 会话栏。
       移动端不渲染;开关关闭时也不渲染(仅隐藏容器,不清空会话绑定)。 -->
  <template v-if="!isMobile && filesChatVisible">
    <div
      class="files-col-splitter"
      role="separator"
      aria-orientation="vertical"
      tabindex="0"
      data-testid="files-col-splitter"
      :aria-label="t('files.chat.splitter.aria')"
      :aria-valuenow="displayWidth"
      :aria-valuemin="FILES_CHAT_WIDTH_MIN"
      :aria-valuemax="FILES_CHAT_WIDTH_MAX"
      :class="{ dragging: dragWidth !== null }"
      @mousedown="onSplitterDown"
      @keydown="onSplitterKey"
    ></div>
    <div
      class="files-chat-pane"
      :style="{ width: displayWidth + 'px' }"
      data-testid="files-chat-pane"
    >
      <ChatColumn
        ref="chat"
        :active-title="chatActive ? activeTitle : t('files.chat.empty.title')"
        :vendor="vendor"
        :agent-switch="agentSwitch"
        :show-mode="chatActive"
        :mode="mode"
        :mode-options="modeOptions"
        :codex-policy="codexPolicy"
        :show-share="false"
        :source-label="null"
        :always-title="true"
        :has-active-session="chatActive"
        :session-bound="chatActive"
        :messages="chatActive ? messages : []"
        :actionable-permission-id="actionablePermissionId"
        :task-model="taskModel"
        :has-task-store="hasTaskStore"
        :running="running"
        :team-active="teamActive"
        :connection="connection"
        :activity="activity"
        :current-agent-name="currentAgentName"
        :reconnecting="reconnecting"
        :side-effect-pending="sideEffectPending"
        :queue="queue"
        :available-commands="availableCommands"
        :voice-lang="voiceLang"
        @set-mode="(m: ModeToken) => emit('set-mode', m)"
        @set-codex-policy="(p: CodexPolicy) => emit('set-codex-policy', p)"
        @set-session-agent="(id: string) => emit('set-session-agent', id)"
        @respond="(m: PermissionMsg, d: 'allow' | 'deny') => emit('respond', m, d)"
        @submit-ask="(m: PermissionMsg, a: Record<string, string>) => emit('submit-ask', m, a)"
        @refresh="emit('refresh')"
        @edit-queued="(item: PendingItem) => emit('edit-queued', item)"
        @delete-queued="(id: number) => emit('delete-queued', id)"
        @submit="(text: string, imgs: PromptImage[]) => emit('submit', text, imgs)"
        @enqueue="(text: string, imgs: PromptImage[]) => emit('enqueue', text, imgs)"
        @stop="emit('stop')"
        @continue="emit('continue')"
        @list-commands="emit('list-commands')"
      >
        <template #title-action>
          <button
            v-if="hasFilesSession"
            type="button"
            class="files-chat-btn"
            data-testid="files-chat-reset"
            :title="t('files.chat.reset.tooltip')"
            :aria-label="t('files.chat.reset.tooltip')"
            @click="emit('reset-files-chat')"
          >
            ↻
          </button>
          <button
            v-else
            type="button"
            class="files-chat-btn files-chat-create"
            data-testid="files-chat-create"
            :title="t('files.chat.create.tooltip')"
            :aria-label="t('files.chat.create.tooltip')"
            @click="emit('create-files-chat')"
          >
            + {{ t('files.chat.create.label') }}
          </button>
        </template>
      </ChatColumn>
    </div>
  </template>
</template>

<style scoped>
/* 中(FileTabs)与右(ChatColumn)之间的可拖拽垂直分隔条。左栏 FileTree 沿用自身
   ⇤/⇥ 宽度切换,不新增分隔条。 */
.files-col-splitter {
  flex: 0 0 6px;
  align-self: stretch;
  cursor: col-resize;
  background: var(--c-border);
  transition: background var(--dur-fast) var(--ease-standard);
}
.files-col-splitter:hover,
.files-col-splitter.dragging,
.files-col-splitter:focus-visible {
  background: var(--c-accent, var(--c-text));
  outline: none;
}

.files-chat-pane {
  flex: none;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--c-bg);
}

/* 标题栏内嵌的会话动作按钮(+ 新建 / ↻ 重置)。 */
.files-chat-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  padding: var(--sp-1) var(--sp-2);
  color: var(--c-text);
  background: var(--c-input);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  font-size: var(--fs-caption);
  line-height: 1;
  cursor: pointer;
}
.files-chat-btn:active {
  background: var(--c-card);
}
@media (hover: hover) and (pointer: fine) {
  .files-chat-btn:hover {
    background: var(--c-card);
  }
}
</style>
