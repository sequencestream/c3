<script setup lang="ts">
/*
 * IntentTitleBarActions.vue — 意图详情常驻头部右侧的动作区(所有 tab 恒可见)。
 *
 * 承接:状态切换(markTodo/backToDraft/markDone)、交付归属入口、四态主按钮、修改会话入口、PR 创建/
 * 打开(取第一条活跃 PR;有 url 为跳转锚点,否则回退复制编号)/同步、分享、自动化切换,以及收容
 * 「取消」「删除」的「…」溢出菜单。四态主按钮的语义与禁用/标题由容器计算后以 props 输入;点击以
 * main-action 上抛交回容器编排(编写 Spec 门 / 延迟切 Tab)。
 * 其余业务动作继续以原事件名和参数上抛,不在此新增门禁。
 *
 * 「…」溢出菜单:「取消」与「删除」都是危险动作(前者切 cancelled 后标题栏无恢复入口,后者删掉可追溯
 * 记录),不留在标题栏表面,收进溢出层多一道缓冲。两项各自按状态可用:「删除」非 done 才有(done 通常
 * 已合并 PR 并沉淀完整产出),「取消」非 done/cancelled 才有;两项都不可用时「…」整体不渲染。菜单靠
 * document click + 容器 @click.stop 收起(与 IntentList 同一范式),另接 Esc。两项都走 danger
 * ConfirmDialog 二次确认,确认框敞开期间状态转到「该动作已不可用」时主动收框且不放行,删除另有防双发。
 *
 * 交付归属入口(意图侧,与交付页入口并存)按 linkedDeliveries 分三态:
 *   0 条  → 「关联交付」按钮(主色描边强调:它决定 PR 提向哪条分支),打开候选弹窗
 *           (打开时上抛 open-link-dialog 让控制层补拉列表);
 *   1 条  → 只展示交付名(点击复用 open-delivery 跳转);解除关联的入口在概览元信息区的交付名之后,
 *           标题栏不再重复;
 *   >1 条 → 只展示交付名,不给关联路径 —— 与「多关联不渲染建 PR 入口」同一条裁决:
 *           目标不唯一时交互层不做选择,数据层的多边关系不受影响。
 * 关联弹窗的开关状态归本组件所有;是否真能关联由服务端复核,这里不设门禁。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
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
    // 同一个目标已 merged 时也收起入口:分支已落进 base,再点只会撞服务端的 diff 闸门,
    // 是一条死路。只拦 merged —— closed 是「提过但没合」,仍留重提路径。终态判断刻意
    // 不复用共享的 activeIntentPrs(它把两种终态同等滤除),两者语义不同。
    !r.prs.some((pr) => pr.status === 'merged' && pr.deliveryId === createPrDeliveryId.value) &&
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

// ── 交付归属:关联弹窗(自持) ─────────────────────────────────────────────
// 三态只看关联条数;交付页的入口照旧存在,两处并存,服务端是唯一门禁。
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

// 关联条数在弹框敞开期间变化(别处关联的广播)时收起弹框,避免对着已经不成立的前提确认。
watch(
  () => props.intent.linkedDeliveries.length,
  (count) => {
    if (count !== 0) linkDialogOpen.value = false
  },
)

// ── 「…」溢出菜单(收容取消 / 删除) ────────────────────────────────────────
const canCancelIntent = computed<boolean>(
  () => props.intent.status !== 'done' && props.intent.status !== 'cancelled',
)
const canDeleteIntent = computed<boolean>(() => props.intent.status !== 'done')
// 两项都不可用(done)时不留一个点开只有空壳的入口。
const showMoreMenu = computed<boolean>(() => canCancelIntent.value || canDeleteIntent.value)

const moreMenuOpen = ref(false)

function closeMoreMenu(): void {
  moreMenuOpen.value = false
}

function onDocumentClick(): void {
  closeMoreMenu()
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeMoreMenu()
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick)
  document.addEventListener('keydown', onDocumentKeydown)
})
onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick)
  document.removeEventListener('keydown', onDocumentKeydown)
})

// 入口本身随状态消失时菜单不该悬空留着(如敞开期间意图转 done)。
watch(showMoreMenu, (visible) => {
  if (!visible) closeMoreMenu()
})

// ── 取消二次确认(自持) ────────────────────────────────────────────────────
// 「取消」切到 cancelled 后标题栏不再提供恢复入口,危险程度与删除同级,故同样过一道 danger 确认;
// 确认后的事件载荷与状态语义与原来的直切完全一致。
const cancelDialogOpen = ref(false)

function openCancelDialog(): void {
  closeMoreMenu()
  cancelDialogOpen.value = true
}

function confirmCancel(): void {
  // 兜住「先开框、状态再转 done/cancelled」的竞态:菜单项已撤销时确认也不放行。
  if (!canCancelIntent.value) return
  cancelDialogOpen.value = false
  emit('set-status', props.intent.id, 'cancelled')
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
  closeMoreMenu()
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

// 意图在确认框敞开期间转入终态时主动收起对应弹框,与菜单项的 v-if 一并撤销可达路径。
watch(
  () => props.intent.status,
  () => {
    if (!canDeleteIntent.value) deleteDialogOpen.value = false
    if (!canCancelIntent.value) cancelDialogOpen.value = false
  },
)
</script>

<template>
  <!-- 定位锚:动作区自身横向可滚(overflow 会裁掉绝对定位的下拉),故菜单挂在滚动容器之外。 -->
  <div class="intent-detail-actions-anchor">
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
      <!-- 交付归属:排在建 PR 之前 —— 交付决定 PR 提向哪条分支,先因后果读下来才成立。
         未关联态用主色描边强调:这是决定 PR 落到哪条分支的关键入口,不该与普通按钮同级。 -->
      <button
        v-if="showLinkButton"
        type="button"
        class="req-btn req-link-delivery-accent"
        data-action="linkDelivery"
        data-testid="intent-detail-link-delivery"
        @click="openLinkDialog"
      >
        {{ t('intent.linkDelivery.label') }}
      </button>
      <!-- 已关联态:只保留交付名导航,解除关联的入口在概览元信息区的交付名之后。 -->
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
          intent.automate
            ? t('intent.automate.queued.tooltip')
            : t('intent.automate.manual.tooltip')
        "
        :aria-pressed="intent.automate"
        @click="emit('set-automate', intent.id, !intent.automate)"
      >
        {{ intent.automate ? '⚙' : '🖱' }}
      </button>
      <!-- 溢出入口占原「删除」的末位:危险动作退到第二层,标题栏表面只留核心动作。 -->
      <button
        v-if="showMoreMenu"
        type="button"
        class="req-kebab"
        data-testid="intent-detail-more"
        :aria-label="t('intent.action.more.label')"
        :title="t('intent.action.more.label')"
        :aria-expanded="moreMenuOpen"
        @click.stop="moreMenuOpen = !moreMenuOpen"
      >
        …
      </button>
    </div>
    <div
      v-if="showMoreMenu && moreMenuOpen"
      class="req-menu intent-detail-more-menu"
      data-testid="intent-detail-more-menu"
      @click.stop
    >
      <button
        v-if="canCancelIntent"
        type="button"
        class="req-menu-item"
        data-action="cancelIntent"
        data-testid="intent-detail-cancel"
        @click="openCancelDialog"
      >
        {{ t('common.action.cancel.label') }}
      </button>
      <button
        v-if="canDeleteIntent"
        type="button"
        class="req-menu-item danger"
        data-testid="intent-detail-delete"
        @click="openDeleteDialog"
      >
        {{ t('common.action.delete.label') }}
      </button>
    </div>
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

  <!-- 取消:服务端会连带关闭该意图全部活跃 PR,且切到 cancelled 后标题栏不再给恢复入口,
       两个后果文案都得说清楚,用户才是在知情下确认。 -->
  <ConfirmDialog
    :open="cancelDialogOpen"
    :title="t('intent.cancel.title')"
    :message="t('intent.cancel.confirm', { title: intent.title })"
    :confirm-label="t('intent.cancel.label')"
    :cancel-label="t('common.action.cancel.label')"
    danger
    @confirm="confirmCancel"
    @cancel="cancelDialogOpen = false"
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
/* 「…」菜单的定位锚:动作区自身 overflow-x: auto,绝对定位的下拉挂在里面会被裁掉,
 * 所以锚点上移一层,菜单与滚动容器平级。 */
.intent-detail-actions-anchor {
  position: relative;
  min-width: 0;
}
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
.intent-detail-actions .req-share,
.intent-detail-actions .req-kebab {
  flex: 0 0 auto;
  white-space: nowrap;
}
/* 「关联交付」(未关联态):主色描边 + 主色文字。只到描边一级,不与实底主按钮争最高视觉级;
 * -text 变体在浅色主题下自动深一档,对比度由 standard.css 的既有约定保证。 */
.intent-detail-actions .req-btn.req-link-delivery-accent {
  border-color: var(--c-primary);
  color: var(--c-primary-text);
}
/* 菜单内的危险项:文字取危险色即可,实底留给确认框里的确认按钮。 */
.intent-detail-more-menu .req-menu-item.danger {
  color: var(--c-error-text);
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
  .intent-detail-actions-anchor {
    width: 100%;
  }
  .intent-detail-actions {
    width: 100%;
    max-width: 100%;
    justify-content: flex-start;
  }
}
</style>
