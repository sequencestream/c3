<script setup lang="ts">
/*
 * CodeTreeNode.vue — 文件树单节点(递归)。
 *
 * 目录:点击切换展开/折叠(展开时由父层懒加载 list_dir);展开后递归渲染子节点。
 * 文件:点击打开 tab。仅持有并上抛 workspace 相对路径(entry.path),不构造绝对路径。
 */
import type { CodeDirEntry } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'

defineProps<{
  entry: CodeDirEntry
  dirs: Record<string, CodeDirEntry[]>
  expanded: Set<string>
  loadingDirs: Set<string>
  activePath: string | null
  depth: number
}>()

const emit = defineEmits<{
  toggle: [rel: string]
  open: [path: string]
}>()

const { t } = useTypedI18n()
</script>

<template>
  <div class="tree-node">
    <!-- Directory row -->
    <template v-if="entry.type === 'directory'">
      <button
        class="row dir-row"
        :style="{ paddingLeft: `${depth * 12 + 8}px` }"
        @click="emit('toggle', entry.path)"
      >
        <span class="twisty" :class="{ open: expanded.has(entry.path) }">▸</span>
        <span class="row-label">{{ entry.name }}</span>
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
          @toggle="emit('toggle', $event)"
          @open="emit('open', $event)"
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
    >
      <span class="file-dot">·</span>
      <span class="row-label">{{ entry.name }}</span>
    </button>
  </div>
</template>

<style scoped>
.row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  min-height: 26px;
  padding: 2px var(--sp-2);
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
.hint {
  color: var(--c-text-muted);
  cursor: default;
  font-style: italic;
}
</style>
