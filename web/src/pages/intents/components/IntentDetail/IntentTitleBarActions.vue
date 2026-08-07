<script setup lang="ts">
/*
 * IntentTitleBarActions.vue — 意图详情常驻头部右侧的动作区(所有 tab 恒可见)。
 *
 * 承接:状态切换(markTodo/backToDraft/markDone/cancel)、交付归属入口、四态主按钮、修改会话入口、PR 创建/
 * 打开(取第一条活跃 PR;有 url 为跳转锚点,否则回退复制编号)/同步、分享、自动化切换与删除入口。四态主按钮的
 * 语义与禁用/标题由容器计算后以 props 输入;点击以 main-action 上抛交回容器编排(编写 Spec 门 /
 * 延迟切 Tab)。删除入口只在非终态 done 时渲染:done 通常已合并 PR 并沉淀完整产出,收紧界面可达
 * 路径以免误删可追溯记录(协议与服务端删除能力不变)。删除二次确认弹框及「可能存在工作产物」的
 * 强化提示归本组件所有,并保留防双发。
 * 其余业务动作继续以原事件名和参数上抛,不在此新增门禁。
 *
 * 交付归属入口(意图侧,与交付页入口并存)按 linkedDeliveries 分三态:
 *   0 条  → 「关联交付」按钮,打开候选弹窗(打开时上抛 open-link-dialog 让控制层补拉列表);
 *   1 条  → 交付名(点击复用 open-delivery 跳转)+「解除关联」(danger 二次确认,文案明确会关闭 PR);
 *   >1 条 → 只展示交付名,不给关联/解除路径 —— 与「多关联不渲染建 PR 入口」同一条裁决:
 *           目标不唯一时交互层不做选择,数据层的多边关系不受影响。
 * 弹窗与解除确认的开关状态归本组件所有;是否真能关联/解除由服务端复核,这里不设门禁。
 */
import { computed, ref, watch } from 'vue'
import type { Delivery, Intent, IntentStatus } from '@ccc/shared/protocol'
import { activeIntentPrs, pickPrimaryIntentPr } from '@ccc/shared'
import { useTypedI18n } from '@/i18n'
import ConfirmDialog from '@/components/ConfirmDialog/ConfirmDialog.vue'
import {
  isIntentOnWorkspaceMainBranch,
  normalizeBranchName,
} from '../../../../lib/intent-list-view'
import IntentLinkDeliveryDialog from './IntentLinkDeliveryDialog.vue'
import type { MainAction } from './useSpecApprovalGate'

const { t } = useTypedI18n()

const props = defineProps<{
  intent: Intent
  workspaceMainBranch?: string | null
  workspaceGitBranchMode?: 'worktree' | 'current-branch'
  intentPrSync?: Record<string, { state: 'syncing' | 'success' | 'error'; message: string }>
  /** 本意图所在工作区的交付列表,作为「关联交付」弹窗的候选池(终态项在弹窗内过滤)。 */
  deliveries?: Delivery[]
  /** 「当前意图独立交付」是否在飞行中(控制层的 pending 槽),用于禁用按钮防双发。 */
  standaloneDeliveryPending?: boolean
  // 四态主按钮由容器计算(依赖 SDD / spec 字段 / start-dev 守卫 / 依赖门)。
  mainAction: MainAction
  mainActionLabel: string
  mainActionDisabled: boolean
  mainActionTitle: string
}>()

const emit = defineEmits<{
  'set-status': [intentId: string, status: IntentStatus]
  'set-automate': [intentId: string, automate: boolean]
  'create-pr': [intentId: string, deliveryId?: string]
  'sync-pr-status': [intentId: string]
  share: [intentId: string]
  delete: [intentId: string]
  'main-action': []
  // 修改意图会话:交回容器打开会话重置弹框。
  modify: []
  // ── 交付归属 ────────────────────────────────────────────────────────────
  /** 跳转已关联交付的详情(与元信息区同一条链路)。 */
  'open-delivery': [deliveryId: string]
  /** 打开候选弹窗:意图页从不主动拉交付列表,由控制层补发 list_deliveries。 */
  'open-link-dialog': [workspaceId: string]
  'link-delivery': [workspaceId: string, deliveryId: string, intentId: string]
  'unlink-delivery': [workspaceId: string, deliveryId: string, intentId: string]
  'standalone-delivery': [
    payload: { workspaceId: string; intentId: string; title: string; description: string },
  ]
}>()

// 头部「我要修改」在无 lastWorkSessionId 时显示,交回容器打开 ResetSessionDialog。
const canResetIntentSession = computed<boolean>(() => !props.intent.lastWorkSessionId)

// 按钮将指向的交付:恰好关联一个交付时即该交付(PR 提向它的分支),未关联时为 null
// (提向工作区主分支)。关联多个交付时目标不唯一,按 DR 裁决不开放建 PR 入口 —— 见
// showCreatePr 的 linkedDeliveries.length <= 1。
const createPrDeliveryId = computed<string | null>(() =>
  props.intent.linkedDeliveries.length === 1 ? props.intent.linkedDeliveries[0].id : null,
)

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
    // 多关联意图没有唯一目标,不渲染入口(服务端同样拒绝)。
    r.linkedDeliveries.length <= 1 &&
    // 与服务端幂等键 (intent_id, delivery_id) 同源:只有「按钮将指向的那个目标」
    // 已有活跃 PR 才挡住新建;别的交付下的活跃 PR 不构成阻挡。
    !activeIntentPrs(r.prs).some((pr) => pr.deliveryId === createPrDeliveryId.value) &&
    !isIntentOnWorkspaceMainBranch(r.branchName, props.workspaceMainBranch)
  )
})

/** 主按钮跳转/复制的目标 PR:第一条活跃的,全部终态则取最早一条。 */
const primaryPr = computed(() => pickPrimaryIntentPr(props.intent.prs))

// 只看"有没有处于 reviewing 的 PR 行",不再要求意图本身是 done——与服务端脱钩后的
// 同步守卫对齐。
const canSyncPrStatus = computed<boolean>(() =>
  props.intent.prs.some((pr) => pr.status === 'reviewing'),
)
const currentPrSync = computed(() => props.intentPrSync?.[props.intent.id])
const prSyncInFlight = computed<boolean>(() => currentPrSync.value?.state === 'syncing')
function syncPrStatus(): void {
  if (!canSyncPrStatus.value || prSyncInFlight.value) return
  emit('sync-pr-status', props.intent.id)
}

function copyPrId(prId: string): void {
  void navigator.clipboard.writeText(prId)
}

// ── 交付归属:关联弹窗 / 解除确认(自持) ───────────────────────────────────
// 三态只看关联条数;交付页的入口照旧存在,两处并存,服务端是唯一门禁。
const linkedDelivery = computed(() =>
  props.intent.linkedDeliveries.length === 1 ? props.intent.linkedDeliveries[0] : null,
)
const showLinkButton = computed<boolean>(() => props.intent.linkedDeliveries.length === 0)

const linkDialogOpen = ref(false)

function openLinkDialog(): void {
  // 候选列表可能从未加载过(用户直接落在意图页),先请控制层补拉再开框;
  // 交付帧按工作区回填,列表到达后弹窗自动有值。
  emit('open-link-dialog', props.intent.workspaceId)
  linkDialogOpen.value = true
}

function confirmLink(deliveryId: string): void {
  linkDialogOpen.value = false
  emit('link-delivery', props.intent.workspaceId, deliveryId, props.intent.id)
}

// 「当前意图独立交付」:标题=意图标题、描述=意图内容,日期由控制层按本地当天编码。
// 弹窗不主动关 —— 三步编排是异步的,留着框既能显示按钮的飞行禁用态,失败时也无需重开;
// 关联成功后 linkedDeliveries 变为 1,下面的 watch 会收框并让入口切到已关联态。
function requestStandaloneDelivery(): void {
  emit('standalone-delivery', {
    workspaceId: props.intent.workspaceId,
    intentId: props.intent.id,
    title: props.intent.title,
    description: props.intent.content,
  })
}

const unlinkDialogOpen = ref(false)
function confirmUnlink(): void {
  const target = linkedDelivery.value
  unlinkDialogOpen.value = false
  if (target) emit('unlink-delivery', props.intent.workspaceId, target.id, props.intent.id)
}

// 关联条数在弹框敞开期间变化(别处关联/解除的广播)时收起对应弹框,避免对着已经
// 不成立的前提确认。
watch(
  () => props.intent.linkedDeliveries.length,
  (count) => {
    if (count !== 0) linkDialogOpen.value = false
    if (count !== 1) unlinkDialogOpen.value = false
  },
)

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
    <!-- 交付归属:排在建 PR 之前 —— 交付决定 PR 提向哪条分支,先因后果读下来才成立。 -->
    <button
      v-if="showLinkButton"
      type="button"
      class="req-btn"
      data-action="linkDelivery"
      data-testid="intent-detail-link-delivery"
      @click="openLinkDialog"
    >
      {{ t('intent.linkDelivery.label') }}
    </button>
    <template v-else>
      <button
        v-for="d in intent.linkedDeliveries"
        :key="d.id"
        type="button"
        class="req-btn req-delivery-link"
        :data-testid="`intent-detail-delivery-${d.id}`"
        :title="t('intent.linkDelivery.open.tooltip')"
        @click="emit('open-delivery', d.id)"
      >
        {{ d.title }}
      </button>
      <button
        v-if="linkedDelivery"
        type="button"
        class="req-btn"
        data-action="unlinkDelivery"
        data-testid="intent-detail-unlink-delivery"
        @click="unlinkDialogOpen = true"
      >
        {{ t('intent.linkDelivery.unlink.label') }}
      </button>
    </template>
    <button
      v-if="showCreatePr"
      class="req-btn primary"
      data-action="createPr"
      @click="emit('create-pr', intent.id, createPrDeliveryId ?? undefined)"
    >
      {{ t('intent.action.createPr.label') }}
    </button>
    <a
      v-if="primaryPr && primaryPr.url"
      class="req-btn pr-link"
      :href="primaryPr.url"
      target="_blank"
      rel="noopener noreferrer"
      :title="t('intent.action.pr.open.tooltip')"
    >
      {{ t('intent.action.pr.label', { id: primaryPr.number }) }}
    </a>
    <button
      v-else-if="primaryPr"
      class="req-btn pr-link"
      :title="t('intent.action.pr.tooltip')"
      @click="copyPrId(primaryPr.number)"
    >
      {{ t('intent.action.pr.label', { id: primaryPr.number }) }}
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

  <IntentLinkDeliveryDialog
    :open="linkDialogOpen"
    :deliveries="deliveries ?? []"
    :standalone-enabled="workspaceGitBranchMode === 'worktree'"
    :standalone-pending="standaloneDeliveryPending === true"
    @confirm="confirmLink"
    @standalone="requestStandaloneDelivery"
    @cancel="linkDialogOpen = false"
  />

  <!-- 解除关联:服务端会先关闭该意图指向此交付的 PR(已合并则直接拒绝),文案必须
       把这个副作用说清楚,用户才是在知情下确认。 -->
  <ConfirmDialog
    :open="unlinkDialogOpen"
    :title="t('intent.linkDelivery.unlink.title.label')"
    :message="t('intent.linkDelivery.unlink.confirm', { title: linkedDelivery?.title ?? '' })"
    :confirm-label="t('intent.linkDelivery.unlink.label')"
    :cancel-label="t('common.action.cancel.label')"
    danger
    @confirm="confirmUnlink"
    @cancel="unlinkDialogOpen = false"
  />

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
/* 已关联交付名:标题栏里它是导航而非动作,收窄并省略超长标题,免得挤掉右侧真正的按钮。 */
.intent-detail-actions .req-delivery-link {
  max-width: 12em;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 主按钮两态语义色:writeSpec 维持主色蓝(生成动作),approveSpec 改用成功色
 * (审核放行)以与编写明确区分;实底取深一档的 -text 变体,白字才托得住对比度,
 * data-action 为稳定可访问锚点。 */
.intent-detail-actions .req-btn.primary[data-action='approveSpec'] {
  background: var(--c-success-text);
  border-color: var(--c-success-text);
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
