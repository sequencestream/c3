<script setup lang="ts">
/*
 * CodeTreeNode.vue — 文件树单节点(递归)。
 *
 * 目录:点击切换展开/折叠(展开时由父层懒加载 list_dir);展开后递归渲染子节点。
 * 文件:点击打开 tab。仅持有并上抛 workspace 相对路径(entry.path),不构造绝对路径。
 */
import type { CodeDirEntry, CodeGitStatus } from '@ccc/shared/protocol'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useTypedI18n } from '@/i18n'
import { gitStatusKinds, type GitStatusKind } from '@/lib/codes-git-status'

const props = defineProps<{
  entry: CodeDirEntry
  dirs: Record<string, CodeDirEntry[]>
  expanded: Set<string>
  loadingDirs: Set<string>
  activePath: string | null
  depth: number
  // Workspace Git-status snapshot (changed-file path → flags) + the set of
  // directory paths with any changed descendant, for the folder rollup indicator.
  gitStatus: Record<string, CodeGitStatus>
  gitDirtyDirs: Set<string>
}>()

const emit = defineEmits<{
  toggle: [rel: string]
  open: [path: string]
  toast: [message: string]
}>()

const { t } = useTypedI18n()

// A file's active status flags in fixed order (`staged`, `modified`, `untracked`);
// prefer the merged snapshot entry, falling back to any inline `entry.gitStatus`.
const fileStatusKinds = computed<GitStatusKind[]>(() =>
  props.entry.type === 'file'
    ? gitStatusKinds(props.gitStatus[props.entry.path] ?? props.entry.gitStatus)
    : [],
)
// A directory shows its rollup dot when any descendant changed (even collapsed).
const dirHasChanges = computed(
  () => props.entry.type === 'directory' && props.gitDirtyDirs.has(props.entry.path),
)

// Short, single-glyph marks differ in shape (S/M/U) AND colour, so status is
// never conveyed by colour alone. Localised names go on the accessible label.
const GIT_MARK_GLYPH: Record<GitStatusKind, string> = {
  staged: 'S',
  modified: 'M',
  untracked: 'U',
}
function gitKindLabel(kind: GitStatusKind): string {
  switch (kind) {
    case 'staged':
      return t('codes.tree.git.staged')
    case 'modified':
      return t('codes.tree.git.modified')
    case 'untracked':
      return t('codes.tree.git.untracked')
  }
}
const fileStatusLabel = computed(() => fileStatusKinds.value.map(gitKindLabel).join(', '))

const MENU_WIDTH = 180
const MENU_HEIGHT = 72
const MENU_GUTTER = 8
const CLOSE_CONTEXT_MENU_EVENT = 'code-tree-close-context-menu'

const contextMenu = ref<{ x: number; y: number } | null>(null)

function removeOutsideClickListener(): void {
  document.removeEventListener('click', closeContextMenu)
}

function closeContextMenu(): void {
  contextMenu.value = null
  removeOutsideClickListener()
}

function openContextMenu(event: MouseEvent): void {
  document.dispatchEvent(new Event(CLOSE_CONTEXT_MENU_EVENT))
  const maxX = Math.max(MENU_GUTTER, window.innerWidth - MENU_WIDTH - MENU_GUTTER)
  const maxY = Math.max(MENU_GUTTER, window.innerHeight - MENU_HEIGHT - MENU_GUTTER)
  contextMenu.value = {
    x: Math.min(Math.max(event.clientX, MENU_GUTTER), maxX),
    y: Math.min(Math.max(event.clientY, MENU_GUTTER), maxY),
  }
  document.removeEventListener('click', closeContextMenu)
  document.addEventListener('click', closeContextMenu)
}

async function copyText(text: string): Promise<void> {
  closeContextMenu()
  try {
    await navigator.clipboard.writeText(text)
    emit('toast', t('codes.tree.contextMenu.copySuccess', { value: text }))
  } catch {
    emit('toast', t('codes.tree.contextMenu.copyFailed', { value: text }))
  }
}

onMounted(() => {
  document.addEventListener(CLOSE_CONTEXT_MENU_EVENT, closeContextMenu)
})

onBeforeUnmount(() => {
  document.removeEventListener(CLOSE_CONTEXT_MENU_EVENT, closeContextMenu)
  removeOutsideClickListener()
})
</script>

<template>
  <div class="tree-node">
    <!-- Directory row -->
    <template v-if="entry.type === 'directory'">
      <button
        class="row dir-row"
        :style="{ paddingLeft: `${depth * 12 + 8}px` }"
        @click="emit('toggle', entry.path)"
        @contextmenu.prevent="openContextMenu"
      >
        <span class="twisty" :class="{ open: expanded.has(entry.path) }">▸</span>
        <span class="row-label">{{ entry.name }}</span>
        <!-- 目录汇总:子孙有任一改动时显示紧凑圆点(独立于文件三态标记,避免混淆)。 -->
        <span
          v-if="dirHasChanges"
          class="dir-change-dot"
          data-testid="dir-change-dot"
          :title="t('codes.tree.git.dirChanges')"
          :aria-label="t('codes.tree.git.dirChanges')"
          role="img"
          >●</span
        >
      </button>

      <template v-if="expanded.has(entry.path)">
        <div
          v-if="loadingDirs.has(entry.path) && !dirs[entry.path]"
          class="row hint"
          :style="{ paddingLeft: `${(depth + 1) * 12 + 8}px` }"
        >
          {{ t('codes.tree.loading') }}
        </div>
        <div
          v-else-if="dirs[entry.path] && dirs[entry.path].length === 0"
          class="row hint"
          :style="{ paddingLeft: `${(depth + 1) * 12 + 8}px` }"
        >
          {{ t('codes.tree.emptyDir') }}
        </div>
        <CodeTreeNode
          v-for="child in dirs[entry.path] ?? []"
          :key="child.path"
          :entry="child"
          :dirs="dirs"
          :expanded="expanded"
          :loading-dirs="loadingDirs"
          :active-path="activePath"
          :depth="depth + 1"
          :git-status="gitStatus"
          :git-dirty-dirs="gitDirtyDirs"
          @toggle="emit('toggle', $event)"
          @open="emit('open', $event)"
          @toast="emit('toast', $event)"
        />
      </template>
    </template>

    <!-- File row -->
    <button
      v-else
      class="row file-row"
      :class="{ active: entry.path === activePath }"
      :style="{ paddingLeft: `${depth * 12 + 8}px` }"
      :title="entry.path"
      @click="emit('open', entry.path)"
      @contextmenu.prevent="openContextMenu"
    >
      <span class="file-dot">·</span>
      <span class="row-label">{{ entry.name }}</span>
      <!-- 文件 Git 三态短标记:可同时出现,固定顺序(staged→modified→untracked),
           形状(S/M/U)+ 语义色双通道区分,不仅靠颜色;完整名称走无障碍标签。 -->
      <span
        v-if="fileStatusKinds.length"
        class="git-marks"
        data-testid="git-marks"
        :aria-label="fileStatusLabel"
        role="img"
      >
        <span
          v-for="kind in fileStatusKinds"
          :key="kind"
          class="git-mark"
          :class="`git-mark--${kind}`"
          :data-git-kind="kind"
          aria-hidden="true"
          >{{ GIT_MARK_GLYPH[kind] }}</span
        >
      </span>
    </button>

    <div
      v-if="contextMenu"
      class="tree-context-menu"
      :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
      role="menu"
      @click.stop
      @contextmenu.prevent
    >
      <button
        type="button"
        class="tree-context-menu-item"
        role="menuitem"
        data-testid="tree-context-copy-name"
        @click="copyText(props.entry.name)"
      >
        {{ t('codes.tree.contextMenu.copyName') }}
      </button>
      <button
        type="button"
        class="tree-context-menu-item"
        role="menuitem"
        data-testid="tree-context-copy-relative-path"
        @click="copyText(props.entry.path)"
      >
        {{ t('codes.tree.contextMenu.copyRelPath') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  min-height: 22px;
  padding: 1px var(--sp-2);
  border: 0;
  background: transparent;
  color: var(--c-text);
  font-size: var(--fs-caption);
  text-align: left;
  cursor: pointer;
}
.row:hover {
  background: var(--c-card);
}
.file-row.active {
  background: var(--c-card);
  color: var(--c-primary);
}
.row-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.twisty {
  flex-shrink: 0;
  width: 12px;
  color: var(--c-text-muted);
  transition: transform var(--dur-fast) var(--ease-standard);
}
.twisty.open {
  transform: rotate(90deg);
}
.file-dot {
  flex-shrink: 0;
  width: 12px;
  text-align: center;
  color: var(--c-text-disabled);
}
/* 文件三态标记容器:靠右,不参与 label 截断 */
.git-marks {
  flex-shrink: 0;
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding-left: var(--sp-1);
}
.git-mark {
  flex-shrink: 0;
  min-width: 12px;
  text-align: center;
  font-size: var(--fs-micro, 11px);
  font-weight: 600;
  line-height: 1;
  font-family: var(--font-mono);
}
/* 语义色:untracked→成功 / modified→警告 / staged→强调(见 color-style-spec) */
.git-mark--untracked {
  color: var(--c-success);
}
.git-mark--modified {
  color: var(--c-warning);
}
.git-mark--staged {
  color: var(--c-primary);
}
/* 目录汇总圆点:紧凑、中性色,靠右,形状与文件字母标记区分 */
.dir-change-dot {
  flex-shrink: 0;
  margin-left: auto;
  padding-left: var(--sp-1);
  font-size: 8px;
  line-height: 1;
  color: var(--c-text-muted);
}
.hint {
  color: var(--c-text-muted);
  cursor: default;
  font-style: italic;
}
.tree-context-menu {
  position: fixed;
  z-index: 1000;
  min-width: 180px;
  padding: var(--sp-1);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  background: var(--c-panel);
  box-shadow: var(--shadow-md);
}
.tree-context-menu-item {
  width: 100%;
  min-height: 24px;
  padding: 3px var(--sp-2);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--c-text);
  font-size: var(--fs-caption);
  text-align: left;
  cursor: pointer;
}
.tree-context-menu-item:hover {
  background: var(--c-card);
}
</style>
