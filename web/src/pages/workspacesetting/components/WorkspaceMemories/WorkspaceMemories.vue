<script setup lang="ts">
/*
 * WorkspaceMemories.vue — 工作区设置 ·「记忆」页签。
 *
 * 只读 + 删除,没有新建、没有编辑、没有正文、没有 Save,也不进 Tab 草稿或「未保存」脏检查 ——
 * 所以本页签永远不会脏。写入路径只有一条:agent 在 work session 里调 `memory_write`。这里再开一个
 * 写入口,等于给同一张表造出第二套会各自漂移的语义。
 *
 * 那为什么还留着删除?因为没有它,用户清理一条记忆就只能让 agent 去删,而需要清理的场合往往正是 agent
 * 自己写错了的时候——纠偏通道不能架在被纠偏的那一方身上。
 *
 * 分组顺序与 agent 侧的 `memory_search` 目录一致(preference → constraint → fact → lesson,空组省略),
 * 组内沿用服务端的 `updatedAt` 倒序,不在前端二次排序。
 *
 * 删除是软删:行立刻从列表消失,但服务端保留 30 天回收期,期间仍占容量——列表下方的提示如实说明这点,
 * 不把「看不见了」说成「删干净了」。
 */
import { computed, ref } from 'vue'
import { MEMORY_TYPES, type MemoryType, type WorkspaceMemoryListItem } from '@ccc/shared/protocol'
import type { UiError } from '@ccc/shared/ui-codes'
import { useTypedI18n } from '@/i18n'
import { translateUiError } from '@/i18n/errors'
import ConfirmDialog from '@/components/ConfirmDialog/ConfirmDialog.vue'

const { t, d } = useTypedI18n()

const props = withDefaults(
  defineProps<{
    /** 当前工作区的 id。仅用于让父层的取数/删除有归属,本组件不解析它。 */
    workspaceName?: string | null
    /** 当前工作区的 active 记忆摘要;`null` = 尚未取到(与空数组的「什么都没记」区分开)。 */
    memories?: WorkspaceMemoryListItem[] | null
    /** 是否有一次列表读取在途。 */
    loading?: boolean
    /** 上次读取失败的原因;非空时优先于列表与空态展示,并给出重试。 */
    error?: UiError | null
    /** 软删在途的记忆 id —— 行仍在,按钮禁用,避免同一条被连点两次。 */
    deletingIds?: string[]
  }>(),
  { workspaceName: null, memories: null, loading: false, error: null, deletingIds: () => [] },
)

const emit = defineEmits<{
  /** 请求重新读取列表(打开页签后的刷新与失败重试同一入口)。 */
  reload: []
  /** 请求软删这一条。父层确认后才把行摘掉,本组件不做乐观移除。 */
  delete: [id: string]
}>()

const loaded = computed(() => props.memories !== null)
const items = computed(() => props.memories ?? [])
const failed = computed(() => props.error !== null && props.error !== undefined)
const errorText = computed(() => (props.error ? translateUiError(props.error) : ''))

/** 按 type 固定顺序分组,空组省略;组内保持服务端给的 `updatedAt` 倒序。 */
const groups = computed(() =>
  MEMORY_TYPES.map((type) => ({
    type,
    rows: items.value.filter((m) => m.type === type),
  })).filter((g) => g.rows.length > 0),
)

function typeLabel(type: MemoryType): string {
  return t(`workspaceSetting.memories.type.${type}` as 'workspaceSetting.memories.type.preference')
}

function statusLabel(status: WorkspaceMemoryListItem['status']): string {
  return t(
    `workspaceSetting.memories.status.${status}` as 'workspaceSetting.memories.status.active',
  )
}

function updatedLabel(ms: number): string {
  return d(new Date(ms), 'full')
}

function isDeleting(id: string): boolean {
  return props.deletingIds.includes(id)
}

// 待确认的删除目标。删除不可在本页撤销(恢复要回到会话里让 agent 重写同名条目),
// 所以走 ConfirmDialog 二次确认,不用 window.confirm。
const pendingDelete = ref<WorkspaceMemoryListItem | null>(null)

function askDelete(item: WorkspaceMemoryListItem): void {
  pendingDelete.value = item
}

function confirmDelete(): void {
  const target = pendingDelete.value
  pendingDelete.value = null
  if (target) emit('delete', target.id)
}
</script>

<template>
  <section class="project-config-section" data-testid="workspace-memories">
    <p class="project-config-section-title">
      {{ t('workspaceSetting.memories.title.label') }}
    </p>
    <p class="project-config-hint">{{ t('workspaceSetting.memories.hint') }}</p>

    <!-- 读取失败如实说明,不退回成「什么都没记」。 -->
    <div v-if="failed" class="memories-unavailable" data-testid="workspace-memories-unavailable">
      <span>{{ t('workspaceSetting.memories.unavailable') }}</span>
      <span class="project-config-hint">{{ errorText }}</span>
      <button class="ghost" data-testid="workspace-memories-retry" @click="emit('reload')">
        {{ t('workspaceSetting.memories.retry.label') }}
      </button>
    </div>
    <p
      v-else-if="!loaded && loading"
      class="project-config-hint"
      data-testid="workspace-memories-loading"
    >
      {{ t('workspaceSetting.memories.loading') }}
    </p>
    <p
      v-else-if="loaded && items.length === 0"
      class="project-config-hint"
      data-testid="workspace-memories-empty"
    >
      {{ t('workspaceSetting.memories.empty') }}
    </p>
    <div v-else-if="loaded" class="memories-groups" data-testid="workspace-memories-list">
      <div v-for="group in groups" :key="group.type" class="memories-group">
        <p class="memories-group-title" data-testid="workspace-memories-group">
          {{ typeLabel(group.type) }}
        </p>
        <ul class="memories-rows">
          <li
            v-for="item in group.rows"
            :key="item.id"
            class="memories-row"
            data-testid="workspace-memories-row"
          >
            <div class="memories-row-main">
              <span class="memories-row-title" data-testid="workspace-memories-row-title">{{
                item.title
              }}</span>
              <span class="project-config-hint memories-row-meta">
                <span data-testid="workspace-memories-row-type">{{ typeLabel(item.type) }}</span>
                <span data-testid="workspace-memories-row-status">{{
                  statusLabel(item.status)
                }}</span>
                <span data-testid="workspace-memories-row-updated">{{
                  updatedLabel(item.updatedAt)
                }}</span>
              </span>
            </div>
            <button
              class="ghost memories-row-delete"
              data-testid="workspace-memories-delete"
              :disabled="isDeleting(item.id)"
              :aria-label="t('workspaceSetting.memories.delete.ariaLabel', { title: item.title })"
              @click="askDelete(item)"
            >
              {{ t('common.action.delete.label') }}
            </button>
          </li>
        </ul>
      </div>
    </div>

    <p class="project-config-hint" data-testid="workspace-memories-soft-delete-hint">
      {{ t('workspaceSetting.memories.softDelete.hint') }}
    </p>

    <div class="memories-actions">
      <button class="ghost" data-testid="workspace-memories-reload" @click="emit('reload')">
        {{ t('common.action.refresh.label') }}
      </button>
    </div>

    <ConfirmDialog
      :open="pendingDelete !== null"
      :title="t('workspaceSetting.memories.delete.confirm.title')"
      :message="
        t('workspaceSetting.memories.delete.confirm.body', { title: pendingDelete?.title ?? '' })
      "
      :confirm-label="t('workspaceSetting.memories.delete.confirm.confirm')"
      :cancel-label="t('workspaceSetting.memories.delete.confirm.cancel')"
      danger
      @confirm="confirmDelete"
      @cancel="pendingDelete = null"
    />
  </section>
</template>

<style scoped>
.memories-groups {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  margin: var(--sp-2) 0;
}

.memories-group-title {
  margin: 0;
  font-weight: 600;
  color: var(--c-text-muted);
}

.memories-rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.memories-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  border-top: 1px solid var(--c-border);
  padding: var(--sp-2) 0;
}

.memories-row-main {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  min-width: 0;
}

.memories-row-title {
  overflow-wrap: anywhere;
}

.memories-row-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}

.memories-row-delete {
  flex: none;
}

.memories-unavailable {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  align-items: flex-start;
  padding: var(--sp-2) 0;
}

.memories-actions {
  display: flex;
  gap: var(--sp-2);
  align-items: center;
  padding-top: var(--sp-2);
}
</style>
