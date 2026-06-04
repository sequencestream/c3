<script setup lang="ts">
/*
 * WorkspaceSwitcher.vue — 顶部栏最左侧的「当前工作区」切换器。
 *
 * 触发区:[当前工作区名] [+ 新增] [▾ 下拉]。下拉列出全部工作区(名称 + 路径),
 * 点选切换当前工作区;每行可移除(二次确认)。所有动作经事件上抛,由 App 发往服务端。
 * 自带 popover(点击外部 / Esc 关闭),因 BaseDropdown 不支持每行动作按钮与两行文本。
 */
import { ref, computed, onBeforeUnmount } from 'vue'
import type { WorkspaceInfo } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'

const { t } = useTypedI18n()

const props = defineProps<{
  workspaces: WorkspaceInfo[]
  currentWorkspace: string | null
}>()

const emit = defineEmits<{
  'add-workspace': [path: string]
  'select-workspace': [path: string]
  'remove-workspace': [path: string]
}>()

const open = ref(false)
const rootEl = ref<HTMLElement | null>(null)

const currentName = computed(
  () => props.workspaces.find((w) => w.path === props.currentWorkspace)?.name ?? '',
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

function addWorkspace() {
  const path = window.prompt(t('nav.workspace.add.prompt'))?.trim()
  if (path) emit('add-workspace', path)
}

function selectWorkspace(path: string) {
  if (path !== props.currentWorkspace) emit('select-workspace', path)
  close()
}

function removeWorkspace(path: string) {
  if (window.confirm(t('nav.workspace.remove.confirm', { path }))) emit('remove-workspace', path)
}

onBeforeUnmount(() => document.removeEventListener('pointerdown', onOutside, true))
</script>

<template>
  <div ref="rootEl" class="ws-switcher" :class="{ open }" @keydown="onKeydown">
    <button
      class="ws-switcher-trigger"
      :title="currentWorkspace ?? t('nav.workspace.trigger.empty.tooltip')"
      aria-haspopup="listbox"
      :aria-expanded="open"
      @click="toggle"
    >
      <span v-if="currentWorkspace" class="ws-switcher-name">{{ currentName }}</span>
      <span v-else class="ws-switcher-name empty">{{
        t('nav.workspace.trigger.empty.label')
      }}</span>
      <span class="ws-switcher-arrow" aria-hidden="true">▾</span>
    </button>
    <button
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
        :key="w.path"
        class="ws-switcher-item"
        :class="{ current: w.path === currentWorkspace }"
        role="option"
        :aria-selected="w.path === currentWorkspace"
        @click="selectWorkspace(w.path)"
      >
        <span class="ws-switcher-item-text">
          <span class="ws-switcher-item-name">{{ w.name }}</span>
          <span class="ws-switcher-item-path">{{ w.path }}</span>
        </span>
        <span v-if="w.path === currentWorkspace" class="ws-switcher-check" aria-hidden="true"
          >✓</span
        >
        <button
          class="icon-btn ws-switcher-remove"
          :title="t('nav.workspace.remove.tooltip')"
          @click.stop="removeWorkspace(w.path)"
        >
          ✕
        </button>
      </li>
    </ul>
  </div>
</template>
