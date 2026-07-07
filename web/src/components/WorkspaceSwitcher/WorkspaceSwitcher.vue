<script setup lang="ts">
/*
 * WorkspaceSwitcher.vue — 顶部栏最左侧的「当前工作区」切换器。
 *
 * 触发区:[当前工作区名] [+ 新增] [▾ 下拉]。下拉列出全部工作区,每行以名称为主行、
 * 完整绝对路径为下方次级行(仅用于区分同名工作区);点选切换当前工作区;每行可移除
 * (二次确认)。所有动作经事件上抛,由 App 发往服务端。工作区身份仍是服务端分配的不透明
 * id,path 只是展示数据,前端不用它构造或判定身份。自带 popover(点击外部 / Esc 关闭)。
 */
import { ref, computed, onBeforeUnmount } from 'vue'
import type { WorkspaceInfo } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'
import { useAuth } from '@/composables/useAuth'
import InputDialog from '@/components/InputDialog/InputDialog.vue'
import ConfirmDialog from '@/components/ConfirmDialog/ConfirmDialog.vue'

const { t } = useTypedI18n()
// Adding / removing a workspace establishes or tears down a trust root — an
// admin-only action server-side (WS-R*). Hide those entries for non-admins; the
// server stays the real gate. Viewing / switching workspaces is unaffected.
const { isAdmin } = useAuth()

const props = defineProps<{
  workspaces: WorkspaceInfo[]
  currentWorkspaceId: string | null
}>()

const emit = defineEmits<{
  // `add-workspace` carries the absolute path the user typed — the ONLY entry
  // where a path legitimately enters the system. The others carry opaque ids.
  'add-workspace': [path: string]
  'select-workspace': [id: string]
  'remove-workspace': [id: string]
}>()

const open = ref(false)
const rootEl = ref<HTMLElement | null>(null)

const currentName = computed(
  () => props.workspaces.find((w) => w.id === props.currentWorkspaceId)?.name ?? '',
)

function toggle() {
  if (open.value) close()
  else openMenu()
}

function openMenu() {
  open.value = true
  document.addEventListener('pointerdown', onOutside, true)
}

function close() {
  open.value = false
  document.removeEventListener('pointerdown', onOutside, true)
}

function onOutside(e: PointerEvent) {
  if (rootEl.value && !rootEl.value.contains(e.target as Node)) close()
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) {
    e.preventDefault()
    close()
  }
}

// 新增工作区:加号打开受控 InputDialog 收集绝对路径;确认携带非空路径才 emit。
const addOpen = ref(false)

function addWorkspace() {
  addOpen.value = true
}

function onAddConfirm(path: string) {
  const trimmed = path.trim()
  if (trimmed) emit('add-workspace', trimmed)
  addOpen.value = false
}

function selectWorkspace(id: string) {
  if (id !== props.currentWorkspaceId) emit('select-workspace', id)
  close()
}

// 删除工作区:点 ✕ 设置目标并打开 danger ConfirmDialog;确认后才 emit remove。
const removeTarget = ref<WorkspaceInfo | null>(null)

function removeWorkspace(w: WorkspaceInfo) {
  removeTarget.value = w
}

function onRemoveConfirm() {
  if (removeTarget.value) emit('remove-workspace', removeTarget.value.id)
  removeTarget.value = null
}

onBeforeUnmount(() => document.removeEventListener('pointerdown', onOutside, true))
</script>

<template>
  <div ref="rootEl" class="ws-switcher" :class="{ open }" @keydown="onKeydown">
    <button
      class="ws-switcher-trigger"
      :title="currentName || t('nav.workspace.trigger.empty.tooltip')"
      aria-haspopup="listbox"
      :aria-expanded="open"
      @click="toggle"
    >
      <span v-if="currentWorkspaceId" class="ws-switcher-name">{{ currentName }}</span>
      <span v-else class="ws-switcher-name empty">{{
        t('nav.workspace.trigger.empty.label')
      }}</span>
      <span class="ws-switcher-arrow" aria-hidden="true">▾</span>
    </button>
    <button
      v-if="isAdmin"
      class="icon-btn ws-switcher-add"
      :title="t('nav.workspace.add.tooltip')"
      @click="addWorkspace"
    >
      +
    </button>

    <ul v-if="open" class="ws-switcher-panel" role="listbox">
      <li v-if="workspaces.length === 0" class="ws-switcher-empty">
        {{ t('nav.workspace.list.empty') }}
      </li>
      <li
        v-for="w in workspaces"
        :key="w.id"
        class="ws-switcher-item"
        :class="{ current: w.id === currentWorkspaceId }"
        role="option"
        :aria-selected="w.id === currentWorkspaceId"
        @click="selectWorkspace(w.id)"
      >
        <span class="ws-switcher-item-text">
          <span class="ws-switcher-item-name">{{ w.name }}</span>
          <span class="ws-switcher-item-path">{{ w.path }}</span>
        </span>
        <span v-if="w.id === currentWorkspaceId" class="ws-switcher-check" aria-hidden="true"
          >✓</span
        >
        <button
          v-if="isAdmin"
          class="icon-btn ws-switcher-remove"
          :title="t('nav.workspace.remove.tooltip')"
          @click.stop="removeWorkspace(w)"
        >
          ✕
        </button>
      </li>
    </ul>

    <InputDialog
      :open="addOpen"
      :title="t('nav.workspace.add.prompt')"
      :placeholder="t('nav.workspace.add.placeholder')"
      :confirm-label="t('nav.workspace.add.confirmLabel')"
      :cancel-label="t('common.action.cancel.label')"
      @confirm="onAddConfirm"
      @cancel="addOpen = false"
    />

    <ConfirmDialog
      :open="removeTarget !== null"
      :title="t('nav.workspace.remove.title')"
      :message="removeTarget ? t('nav.workspace.remove.confirm', { path: removeTarget.name }) : ''"
      :confirm-label="t('nav.workspace.remove.confirmLabel')"
      :cancel-label="t('common.action.cancel.label')"
      danger
      @confirm="onRemoveConfirm"
      @cancel="removeTarget = null"
    />
  </div>
</template>
