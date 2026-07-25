<script setup lang="ts">
/*
 * IntentTitleBarActions.vue — 意图详情常驻头部右侧的动作区(所有 tab 恒可见)。
 *
 * 承接:状态切换(markTodo/backToDraft/markDone/cancel)、四态主按钮、修改会话入口、PR 创建/
 * 打开(有 prUrl 为跳转锚点,否则回退复制 prId)/同步、分享、自动化切换与删除入口。四态主按钮的
 * 语义与禁用/标题由容器计算后以 props 输入;点击以 main-action 上抛交回容器编排(编写 Spec 门 /
 * 延迟切 Tab)。删除入口只在非终态 done 时渲染:done 通常已合并 PR 并沉淀完整产出,收紧界面可达
 * 路径以免误删可追溯记录(协议与服务端删除能力不变)。删除二次确认弹框及「可能存在工作产物」的
 * 强化提示归本组件所有,并保留防双发。
 * 其余业务动作继续以原事件名和参数上抛,不在此新增门禁。
 */
import { computed, ref, watch } from 'vue'
import type { Intent, IntentStatus } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'
import ConfirmDialog from '@/components/ConfirmDialog/ConfirmDialog.vue'
import {
  isIntentOnWorkspaceMainBranch,
  normalizeBranchName,
} from '../../../../lib/intent-list-view'
import type { MainAction } from './useSpecApprovalGate'

const { t } = useTypedI18n()

const props = defineProps<{
  intent: Intent
  workspaceMainBranch?: string | null
  workspaceGitBranchMode?: 'worktree' | 'current-branch'
  intentPrSync?: Record<string, { state: 'syncing' | 'success' | 'error'; message: string }>
  // 四态主按钮由容器计算(依赖 SDD / spec 字段 / start-dev 守卫 / 依赖门)。
  mainAction: MainAction
  mainActionLabel: string
  mainActionDisabled: boolean
  mainActionTitle: string
}>()

const emit = defineEmits<{
  'set-status': [intentId: string, status: IntentStatus]
  'set-automate': [intentId: string, automate: boolean]
  'create-pr': [intentId: string]
  'sync-pr-status': [intentId: string]
  share: [intentId: string]
  delete: [intentId: string]
  'main-action': []
  // 修改意图会话:交回容器打开会话重置弹框。
  modify: []
}>()

// 头部「我要修改」在无 lastWorkSessionId 时显示,交回容器打开 ResetSessionDialog。
const canResetIntentSession = computed<boolean>(() => !props.intent.lastWorkSessionId)

const showCreatePr = computed<boolean>(() => {
  const r = props.intent
  const branchName = normalizeBranchName(r.branchName)
  // Manual PR creation serves worktree mode only; a missing/unknown mode is
  // treated as non-worktree so a stale client never shows the button. Status is
  // deliberately not checked (todo/in_progress qualify like done).
  return (
    props.workspaceGitBranchMode === 'worktree' &&
    branchName !== null &&
    !!r.lastWorkSessionId &&
    !r.prId &&
    !isIntentOnWorkspaceMainBranch(r.branchName, props.workspaceMainBranch)
  )
})

const canSyncPrStatus = computed<boolean>(() => {
  const r = props.intent
  return r.status === 'done' && !!r.prId && r.prStatus === 'reviewing'
})
const currentPrSync = computed(() => props.intentPrSync?.[props.intent.id])
const prSyncInFlight = computed<boolean>(() => currentPrSync.value?.state === 'syncing')
function syncPrStatus(): void {
  if (!canSyncPrStatus.value || prSyncInFlight.value) return
  emit('sync-pr-status', props.intent.id)
}

function copyPrId(prId: string): void {
  void navigator.clipboard.writeText(prId)
}

// ── 删除二次确认(自持,防双发) ────────────────────────────────────────────
const deleteDialogOpen = ref(false)
const deleteSent = ref(false)
const deleteMessage = computed<string>(() => {
  const r = props.intent
  // 留有工作产物(worktree 改动、本地分支提交)的状态额外强化提示;done 已无删除入口,该分支仅为
  // 状态回退等边界留的防御。
  return r.status === 'in_progress' || r.status === 'done'
    ? t('intent.delete.confirmWithArtifacts', { title: r.title })
    : t('intent.delete.confirm', { title: r.title })
})

function openDeleteDialog(): void {
  deleteSent.value = false
  deleteDialogOpen.value = true
}

function confirmDelete(): void {
  // done 无删除入口:即便确认框在状态切换前已打开,也不得放行删除,兜住「先开框再转 done」的竞态。
  if (deleteSent.value || props.intent.status === 'done') return
  deleteSent.value = true
  deleteDialogOpen.value = false
  emit('delete', props.intent.id)
}

// 意图在确认框敞开期间转入 done 时主动收起弹框,与删除按钮的 v-if 一并撤销可达路径。
watch(
  () => props.intent.status,
  (status) => {
    if (status === 'done') deleteDialogOpen.value = false
  },
)
</script>

<template>
  <div class="intent-detail-actions" data-testid="intent-detail-actions">
    <button
      v-if="intent.status === 'draft'"
      type="button"
      class="req-btn"
      data-action="markTodo"
      data-testid="intent-detail-mark-todo"
      @click="emit('set-status', intent.id, 'todo')"
    >
      {{ t('intent.action.markTodo.label') }}
    </button>
    <button
      v-else-if="intent.status === 'todo'"
      type="button"
      class="req-btn"
      data-action="backToDraft"
      data-testid="intent-detail-back-to-draft"
      @click="emit('set-status', intent.id, 'draft')"
    >
      {{ t('intent.action.backToDraft.label') }}
    </button>
    <button
      v-if="canResetIntentSession"
      type="button"
      class="req-btn"
      data-testid="intent-detail-intent-modify"
      @click="emit('modify')"
    >
      {{ t('intent.action.modifySession.label') }}
    </button>
    <button
      v-if="intent.status === 'todo'"
      class="req-btn primary"
      :data-action="mainAction"
      :aria-label="mainActionTitle"
      :title="mainActionTitle"
      :disabled="mainActionDisabled"
      @click="emit('main-action')"
    >
      {{ mainActionLabel }}
    </button>
    <button
      v-if="intent.lastWorkSessionId && intent.status !== 'done' && intent.status !== 'cancelled'"
      class="req-btn"
      data-action="markDone"
      @click="emit('set-status', intent.id, 'done')"
    >
      {{ t('intent.action.markDone.label') }}
    </button>
    <button
      v-if="intent.status !== 'done' && intent.status !== 'cancelled'"
      class="req-btn"
      @click="emit('set-status', intent.id, 'cancelled')"
    >
      {{ t('common.action.cancel.label') }}
    </button>
    <button
      v-if="showCreatePr"
      class="req-btn primary"
      data-action="createPr"
      @click="emit('create-pr', intent.id)"
    >
      {{ t('intent.action.createPr.label') }}
    </button>
    <a
      v-if="intent.prId && intent.prUrl"
      class="req-btn pr-link"
      :href="intent.prUrl"
      target="_blank"
      rel="noopener noreferrer"
      :title="t('intent.action.pr.open.tooltip')"
    >
      {{ t('intent.action.pr.label', { id: intent.prId }) }}
    </a>
    <button
      v-else-if="intent.prId"
      class="req-btn pr-link"
      :title="t('intent.action.pr.tooltip')"
      @click="copyPrId(intent.prId as string)"
    >
      {{ t('intent.action.pr.label', { id: intent.prId }) }}
    </button>
    <button
      v-if="canSyncPrStatus"
      type="button"
      class="req-btn"
      data-action="syncPrStatus"
      :disabled="prSyncInFlight"
      @click="syncPrStatus"
    >
      {{ prSyncInFlight ? t('intent.prSync.syncing') : t('intent.prSync.label') }}
    </button>
    <button
      type="button"
      class="req-share"
      data-testid="share-button"
      :title="t('share.tooltip')"
      :aria-label="t('share.ariaLabel')"
      @click="emit('share', intent.id)"
    >
      🔗
    </button>
    <button
      type="button"
      class="req-automate"
      :class="{ active: intent.automate }"
      :title="
        intent.automate ? t('intent.automate.queued.tooltip') : t('intent.automate.manual.tooltip')
      "
      :aria-pressed="intent.automate"
      @click="emit('set-automate', intent.id, !intent.automate)"
    >
      {{ intent.automate ? '⚙' : '🖱' }}
    </button>
    <button
      v-if="intent.status !== 'done'"
      type="button"
      class="req-btn danger"
      data-testid="intent-detail-delete"
      @click="openDeleteDialog"
    >
      {{ t('common.action.delete.label') }}
    </button>
  </div>

  <ConfirmDialog
    :open="deleteDialogOpen"
    :title="t('intent.delete.title')"
    :message="deleteMessage"
    :confirm-label="t('common.action.delete.label')"
    :cancel-label="t('common.action.cancel.label')"
    danger
    @confirm="confirmDelete"
    @cancel="deleteDialogOpen = false"
  />
</template>

<style scoped>
.intent-detail-actions {
  width: auto;
  max-width: min(58vw, 720px);
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  justify-content: flex-end;
  gap: var(--sp-2);
  overflow-x: auto;
  overflow-y: hidden;
  padding-bottom: 1px;
}
.intent-detail-actions .req-btn,
.intent-detail-actions .req-automate,
.intent-detail-actions .req-share {
  flex: 0 0 auto;
  white-space: nowrap;
}
/* 主按钮两态语义色:writeSpec 维持主色蓝(生成动作),approveSpec 改用成功色
 * (审核放行)以与编写明确区分;白字保证对比度,data-action 为稳定可访问锚点。 */
.intent-detail-actions .req-btn.primary[data-action='approveSpec'] {
  background: var(--c-success);
  border-color: var(--c-success);
  color: #fff;
}
@media (max-width: 640px) {
  .intent-detail-actions {
    width: 100%;
    max-width: 100%;
    justify-content: flex-start;
  }
}
</style>
