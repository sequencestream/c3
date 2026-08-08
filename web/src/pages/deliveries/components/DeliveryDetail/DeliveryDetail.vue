<script setup lang="ts">
/*
 * DeliveryDetail.vue — 交付详情容器。
 *
 * 常驻标题栏是状态的唯一去处:标题 → 紧贴的状态徽标(六态分别配色、纯展示) →
 * 弹性空隙 → 动作组(集成就绪 N/M 小字 + 可达目标推进按钮 + 「…」溢出菜单)。推进区
 * 只渲染此刻真的能点的目标——被守卫挡住的、系统专属的目标根本不渲染;「为何推不动」由
 * 标题栏下方的缺口异常框回答。其下仅两个 Tab:概览(交付分支/合并/元信息,不含任何
 * 状态内容)与关联意图。不设 PR/设置/分支独立 Tab。
 *
 * 推进按钮说的是「按下去会发生什么」(开始集成 / 开始验证 / 确认验证 / 返工),不是
 * 目标状态名——状态名归徽标;两套文案键因此分家(见 deliveryAdvanceLabelKey)。
 *
 * 「取消交付」不排在标题栏上:它切 cancelled 是不可逆终态,危险动作退居「…」溢出菜单
 * 第二层多一道缓冲,终态本身则整个入口都不渲染。菜单收起沿用列表页 kebab 范式
 * (document click 外部收起),另补 Esc;交付转终态时随 watch 收起,不悬空。
 *
 * 可达性与缺口全部来自服务端 `transitionPlan`,本组件只渲染,不复制状态规则;状态
 * 推进/返工/取消一律上抛由控制层发 WS,服务端回包为准。verifying→verified 是状态机
 * 语义的一部分,点击先弹 ConfirmDialog 显式人工确认才提交(该确认正是服务端计划把
 * verificationNotConfirmed 视为已满足的依据,写端仍会复核);取消同样走 danger
 * ConfirmDialog(web 规范,不用 window.confirm)。
 */
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import { useTypedI18n } from '@/i18n'
import type {
  AssociatedIntent,
  Delivery,
  DeliveryPr,
  DeliveryStatus,
  DeliveryTargetTransition,
  DeliveryTransitionPlan,
  Intent,
} from '@ccc/shared/protocol'
import ConfirmDialog from '@/components/ConfirmDialog/ConfirmDialog.vue'
import {
  DELIVERY_STATUS_LABEL_KEYS,
  deliveryAdvanceLabelKey,
  deliveryGapReasons,
  deliveryTargetInvokable,
  isDeliveryReworkTarget,
  isDeliveryTerminal,
  isVerificationConfirmTarget,
  type DeliveryBranchInitState,
} from '@/lib/delivery-view'
import DeliveryOverviewTab from './DeliveryOverviewTab.vue'
import DeliveryIntentsTab from './DeliveryIntentsTab.vue'

const { t } = useTypedI18n()

const props = defineProps<{
  delivery: Delivery
  plan: DeliveryTransitionPlan
  branchInit: DeliveryBranchInitState | null
  workspaceGitBranchMode: 'worktree' | 'current-branch'
  /** Server-listed linked intents (each row's PR status is toward THIS delivery). */
  associatedIntents: AssociatedIntent[]
  /** This workspace's intents, for the link picker. */
  intents: Intent[]
  /** How far mainline is ahead of the delivery branch; null = unknown / N/A. */
  mainlineAhead: number | null
  /** How far the delivery branch is ahead of mainline; null = unknown / N/A. */
  deliveryBranchAhead: number | null
  /** In-flight 「同步主线」 phase; null = idle. */
  syncPhase: 'fetching' | 'merging' | 'pushing' | null
  /** The delivery's latest 「交付分支 → 主线」 PR; null = none opened. */
  deliveryPr: DeliveryPr | null
  /** Whether a delivery-PR create / sync round trip is in flight. */
  deliveryPrBusy: boolean
}>()

const emit = defineEmits<{
  update: [
    payload: {
      deliveryId: string
      title?: string
      description?: string
      startDate?: number | null
      endDate?: number | null
    },
  ]
  cancel: [deliveryId: string]
  transition: [to: DeliveryStatus, confirmVerified: boolean]
  'init-branch': [payload: { mode: 'create' | 'bind'; branchName: string }]
  'cleanup-branch': [deliveryId: string]
  'sync-mainline': [deliveryId: string]
  'create-delivery-pr': [deliveryId: string]
  'sync-delivery-pr': [deliveryId: string]
  'link-intent': [intentId: string]
  'unlink-intent': [intentId: string]
  'open-intent': [intentId: string]
  'open-workspace-settings': []
}>()

const TAB_OVERVIEW = 'overview' as const
const TAB_INTENTS = 'intents' as const
type DeliveryTabKind = typeof TAB_OVERVIEW | typeof TAB_INTENTS

// Tab 选中态是页面内部展示状态,不写回 App/协议。概览 → 关联意图的缺口跳转由此切换。
const activeTab = ref<DeliveryTabKind>(TAB_OVERVIEW)

const cancelOpen = ref(false)

// verifying→verified 的人工确认门:点中该目标先弹 ConfirmDialog,只有显式确认才推进。
const confirmTarget = ref<DeliveryStatus | null>(null)

// ── 「…」溢出菜单(当前只放「取消交付」) ─────────────────────────────────────
const moreOpen = ref(false)

// 终态没有可取消之物,整个入口不渲染。
const showMore = computed(() => !isDeliveryTerminal(props.delivery.status))

function closeMore(): void {
  moreOpen.value = false
}

function onDocumentKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeMore()
}

// 外部点击/Esc 收起。入口与菜单都在 `.delivery-more` 里,该容器 @click.stop 挡下所有
// 内部点击 —— 否则开菜单的这一下会立刻冒到这里被收回去,菜单永远打不开。
onMounted(() => {
  document.addEventListener('click', closeMore)
  document.addEventListener('keydown', onDocumentKeydown)
})
onUnmounted(() => {
  document.removeEventListener('click', closeMore)
  document.removeEventListener('keydown', onDocumentKeydown)
})

// 菜单敞开期间交付被别处推进到终态:入口随 showMore 消失,菜单不能留在空位上。
watch(showMore, (visible) => {
  if (!visible) closeMore()
})

function openCancelFromMenu(): void {
  closeMore()
  cancelOpen.value = true
}

function statusLabel(status: DeliveryStatus): string {
  return t(DELIVERY_STATUS_LABEL_KEYS[status])
}

// 推进区只列此刻真的能点的目标(人工可写且守卫已过);被挡目标不是置灰,是不渲染。
const invokableTargets = computed(() => props.plan.targets.filter(deliveryTargetInvokable))

// 按钮文案是动作,不是状态名 —— 映射按 (from,to) 边取,与徽标的状态名键完全分开。
function targetLabel(target: DeliveryTargetTransition): string {
  return t(deliveryAdvanceLabelKey(props.delivery.status, target.to))
}

function onAdvance(target: DeliveryTargetTransition): void {
  if (isVerificationConfirmTarget(props.delivery.status, target.to)) {
    confirmTarget.value = target.to
    return
  }
  emit('transition', target.to, false)
}

function confirmVerified(): void {
  const to = confirmTarget.value
  confirmTarget.value = null
  if (to) emit('transition', to, true)
}

// 扁平化、去重、按守卫顺序排列的缺口。`delivery.guard.*` 码本身就是文案叶子键,
// 模板直接 t(code, params)。
const gaps = computed(() => deliveryGapReasons(props.plan))

function jumpLabel(target: 'associated-intents' | 'workspace-settings' | 'branch'): string {
  if (target === 'associated-intents') return t('delivery.action.jumpToIntents.label')
  if (target === 'branch') return t('delivery.action.jumpToBranch.label')
  return t('delivery.action.jumpToSettings.label')
}

// The overview tab's branch-init section, so a `branchNotReady` gap jump can
// focus it (scroll + focus the input).
const overviewRef = ref<InstanceType<typeof DeliveryOverviewTab> | null>(null)

// 缺口跳转:关联意图 → 切到关联意图 tab;分支未就绪 → 切到概览并聚焦分支初始化区;
// 工作区设置 → 上抛由 App 打开设置页。
function onJump(target: 'associated-intents' | 'workspace-settings' | 'branch'): void {
  if (target === 'associated-intents') {
    activeTab.value = TAB_INTENTS
  } else if (target === 'branch') {
    activeTab.value = TAB_OVERVIEW
    void nextTick(() => overviewRef.value?.focusBranchInit?.())
  } else {
    emit('open-workspace-settings')
  }
}

// 终态说明文案:已发布 / 已取消。
const terminalNote = computed<{ label: string; params?: Record<string, unknown> } | null>(() => {
  if (props.delivery.status === 'delivered') {
    return {
      label: t('delivery.page.terminalDelivered.label', { baseBranch: props.delivery.baseBranch }),
    }
  }
  if (props.delivery.status === 'cancelled') {
    return { label: t('delivery.page.terminalCancelled.label') }
  }
  return null
})
</script>

<template>
  <div class="delivery-detail">
    <div class="delivery-detail-head">
      <h2 class="delivery-detail-title" :title="props.delivery.title">
        {{ props.delivery.title }}
      </h2>
      <!-- 徽标紧贴标题:剩余宽度由其后的空隙元素吃掉,而不是由标题的 flex:1 吃掉。 -->
      <span
        class="delivery-detail-status"
        :class="props.delivery.status"
        :data-testid="`delivery-detail-status-${props.delivery.status}`"
      >
        {{ statusLabel(props.delivery.status) }}
      </span>
      <span class="delivery-head-spacer" aria-hidden="true" />
      <div class="delivery-head-actions" data-testid="delivery-head-actions">
        <span class="delivery-ready-line" data-testid="delivery-ready-line">
          {{
            t('delivery.status.integrationReady.label', {
              merged: props.delivery.integration.merged,
              total: props.delivery.integration.total,
            })
          }}
        </span>
        <button
          v-for="target in invokableTargets"
          :key="target.to"
          type="button"
          class="delivery-advance-btn"
          :class="{ rework: isDeliveryReworkTarget(props.delivery.status, target.to) }"
          :data-testid="`delivery-advance-${target.to}`"
          @click="onAdvance(target)"
        >
          {{ targetLabel(target) }}
        </button>
        <!-- 溢出层:不可逆的「取消交付」退居第二层,终态整个入口不渲染。 -->
        <div v-if="showMore" class="delivery-more" data-testid="delivery-more" @click.stop>
          <button
            type="button"
            class="delivery-more-btn"
            data-testid="delivery-more-btn"
            aria-haspopup="menu"
            :aria-expanded="moreOpen"
            :aria-label="t('delivery.action.more.label')"
            :title="t('delivery.action.more.label')"
            @click.stop="moreOpen = !moreOpen"
          >
            ⋯
          </button>
          <div
            v-if="moreOpen"
            class="delivery-more-menu"
            role="menu"
            data-testid="delivery-more-menu"
          >
            <button
              type="button"
              class="delivery-more-item danger"
              role="menuitem"
              data-testid="delivery-cancel-btn"
              @click="openCancelFromMenu"
            >
              {{ t('delivery.action.cancel.label') }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 缺口异常框:被挡目标从推进区消失后,「为何推不动」全靠它回答,因此有缺口
         时常驻在标题栏之下、Tab 条之上,不折叠、不随 tab 切换消失。 -->
    <div v-if="gaps.length" class="delivery-gap-banner" role="alert" data-testid="delivery-gaps">
      <span class="delivery-gap-icon" aria-hidden="true">⚠</span>
      <span class="delivery-gap-title">{{ t('delivery.page.gap.label') }}</span>
      <ul class="delivery-gap-list">
        <li
          v-for="gap in gaps"
          :key="gap.code"
          class="delivery-gap"
          :data-testid="`delivery-gap-${gap.code}`"
        >
          <span class="delivery-gap-text">{{ t(gap.code as never, gap.params as never) }}</span>
          <button
            v-if="gap.jumpTo"
            type="button"
            class="delivery-gap-jump"
            @click="onJump(gap.jumpTo!)"
          >
            {{ jumpLabel(gap.jumpTo) }}
          </button>
        </li>
      </ul>
    </div>

    <p v-if="terminalNote" class="delivery-terminal-note" data-testid="delivery-terminal-note">
      {{ terminalNote.label }}
    </p>

    <nav class="delivery-pane-tabs" data-testid="delivery-pane-tabs">
      <button
        type="button"
        class="delivery-pane-tab"
        :class="{ active: activeTab === TAB_OVERVIEW }"
        :data-testid="`delivery-pane-tab-${TAB_OVERVIEW}`"
        :aria-pressed="activeTab === TAB_OVERVIEW"
        @click="activeTab = TAB_OVERVIEW"
      >
        {{ t('delivery.page.tab.overview.label') }}
      </button>
      <button
        type="button"
        class="delivery-pane-tab"
        :class="{ active: activeTab === TAB_INTENTS }"
        :data-testid="`delivery-pane-tab-${TAB_INTENTS}`"
        :aria-pressed="activeTab === TAB_INTENTS"
        @click="activeTab = TAB_INTENTS"
      >
        {{ t('delivery.page.tab.intents.label') }}
      </button>
    </nav>

    <DeliveryOverviewTab
      v-if="activeTab === TAB_OVERVIEW"
      ref="overviewRef"
      :delivery="props.delivery"
      :branch-init="props.branchInit"
      :workspace-git-branch-mode="props.workspaceGitBranchMode"
      :mainline-ahead="props.mainlineAhead"
      :delivery-branch-ahead="props.deliveryBranchAhead"
      :sync-phase="props.syncPhase"
      :delivery-pr="props.deliveryPr"
      :delivery-pr-busy="props.deliveryPrBusy"
      @update="(p) => emit('update', p)"
      @init-branch="(payload) => emit('init-branch', payload)"
      @cleanup-branch="(id: string) => emit('cleanup-branch', id)"
      @sync-mainline="(id: string) => emit('sync-mainline', id)"
      @create-delivery-pr="(id: string) => emit('create-delivery-pr', id)"
      @sync-delivery-pr="(id: string) => emit('sync-delivery-pr', id)"
    />
    <DeliveryIntentsTab
      v-else
      :delivery="props.delivery"
      :associated-intents="props.associatedIntents"
      :intents="props.intents"
      @link="(id: string) => emit('link-intent', id)"
      @unlink="(id: string) => emit('unlink-intent', id)"
      @open-intent="(id: string) => emit('open-intent', id)"
    />

    <ConfirmDialog
      :open="cancelOpen"
      :title="t('delivery.action.cancelTitle.label')"
      :message="t('delivery.action.cancelBody.label', { title: props.delivery.title })"
      :confirm-label="t('delivery.action.cancel.label')"
      :cancel-label="t('common.action.cancel.label')"
      danger
      @confirm="
        () => {
          cancelOpen = false
          emit('cancel', props.delivery.id)
        }
      "
      @cancel="cancelOpen = false"
    />

    <ConfirmDialog
      :open="confirmTarget !== null"
      :title="t('delivery.action.confirmVerified.label')"
      :message="t('delivery.status.verifying.label')"
      :confirm-label="t('delivery.action.confirmVerified.label')"
      :cancel-label="t('common.action.cancel.label')"
      danger
      @confirm="confirmVerified"
      @cancel="confirmTarget = null"
    />
  </div>
</template>

<style scoped>
/* 详情吃掉右栏剩余宽度(桌面端 MobileStack 为 display:contents,本容器直接是页面
   shell 的 flex 子项);min-width:0 让内部长文本可收缩而不撑破布局。 */
.delivery-detail {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.delivery-detail-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--c-border);
  flex-shrink: 0;
}
/* 标题不再 flex:1 —— 徽标要紧贴标题,剩余宽度交给 .delivery-head-spacer。 */
.delivery-detail-title {
  margin: 0;
  min-width: 0;
  font-size: var(--fs-title);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.delivery-head-spacer {
  flex: 1;
  min-width: 0;
}
.delivery-detail-status {
  flex-shrink: 0;
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  padding: 2px var(--sp-2);
}
/* 六态分别配色,语义随流程递进;全部走 --c-* 令牌,唯一的字面量是实底上的白字。 */
.delivery-detail-status.planned {
  color: var(--c-text-muted);
  border-color: var(--c-border);
}
.delivery-detail-status.integrating {
  color: var(--c-info);
  border-color: var(--c-info);
  background: rgba(59, 130, 246, 0.12);
}
.delivery-detail-status.verifying {
  color: var(--c-warning-text);
  border-color: var(--c-warning);
  background: rgba(245, 158, 11, 0.12);
}
.delivery-detail-status.verified {
  color: var(--c-success-text);
  border-color: var(--c-success);
  background: rgba(34, 197, 94, 0.12);
}
.delivery-detail-status.delivered {
  color: #fff;
  border-color: var(--c-primary);
  background: var(--c-primary);
  font-weight: 600;
}
.delivery-detail-status.cancelled {
  color: var(--c-error-text);
  border-color: var(--c-error);
  background: transparent;
}
/* 动作组:N/M + 可达目标 + 「…」。桌面端跟在空隙之后不被压扁,移动端整体换到第二行。 */
.delivery-head-actions {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sp-2);
}
.delivery-ready-line {
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  white-space: nowrap;
}
/* 推进按钮是真按钮,不是徽标:主色实底 + 白字(两个主题下底色相同,白字是唯一正确
   的前景),hover 加深、disabled 降透明。透明底细描边与旁边的状态徽标同貌,读起来像
   在陈述状态而不是邀请点击,故整体退役。 */
.delivery-advance-btn {
  flex-shrink: 0;
  padding: var(--sp-1) var(--sp-3);
  font: inherit;
  font-size: var(--fs-caption);
  font-weight: 600;
  color: #fff;
  background: var(--c-primary);
  border: 1px solid var(--c-primary);
  border-radius: var(--radius-sm);
  cursor: pointer;
  white-space: nowrap;
}
.delivery-advance-btn:hover {
  filter: brightness(1.08);
}
.delivery-advance-btn:disabled {
  opacity: 0.5;
  cursor: default;
  filter: none;
}
.delivery-advance-btn:focus-visible {
  outline: 2px solid var(--c-primary);
  outline-offset: 2px;
}
/* 返工是回头路,不该和前进按钮同一个分量:填充降到输入底色、描边保留虚线以延续原有
   的区分,仍是有实底的按钮而非幽灵态。 */
.delivery-advance-btn.rework {
  color: var(--c-text);
  background: var(--c-input);
  border: 1px dashed var(--c-border);
}
.delivery-advance-btn.rework:hover {
  background: var(--c-hover-strong);
  filter: none;
}
/* 「…」入口:与列表页 kebab 同一视觉语言 —— 方形图标钮 + 实底描边,hover 与展开态
   加深底色,始终看得出是个可点的按钮而不是三个字符。 */
.delivery-more {
  position: relative;
  flex-shrink: 0;
}
.delivery-more-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  font: inherit;
  font-size: var(--fs-body);
  line-height: 1;
  color: var(--c-text-muted);
  background: var(--c-input);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.delivery-more-btn:hover,
.delivery-more-btn[aria-expanded='true'] {
  color: var(--c-text);
  background: var(--c-hover-strong);
}
.delivery-more-btn:focus-visible {
  outline: 2px solid var(--c-primary);
  outline-offset: 2px;
}
/* 下拉浮层:面板底 + 描边 + 投影,压住其下的内容。 */
.delivery-more-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 20;
  min-width: 140px;
  display: flex;
  flex-direction: column;
  padding: 4px;
  background: var(--c-panel);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-mid);
}
.delivery-more-item {
  padding: 6px 10px;
  font: inherit;
  font-size: var(--fs-caption);
  text-align: left;
  white-space: nowrap;
  color: var(--c-text);
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.delivery-more-item:hover {
  background: var(--c-hover-strong);
}
.delivery-more-item:focus-visible {
  outline: 2px solid var(--c-primary);
  outline-offset: -2px;
}
/* 危险项只用危险色文字:实底留给确认框的确认键,菜单里不抢第一注意力。 */
.delivery-more-item.danger {
  color: var(--c-error-text);
}
/* 缺口异常框:描边提示区 + 文案 + 行尾跳转按钮,信息不依赖颜色单独成立
   (图标与正文都是可读文本,跳转是原生可聚焦 button)。 */
.delivery-gap-banner {
  flex-shrink: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  margin: var(--sp-2) var(--sp-4) 0;
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--c-warning);
  border-radius: var(--radius-sm);
  background: rgba(245, 158, 11, 0.12);
  color: var(--c-warning-text);
  font-size: var(--fs-caption);
}
.delivery-gap-icon {
  flex-shrink: 0;
}
.delivery-gap-title {
  font-weight: 600;
}
.delivery-gap-list {
  flex-basis: 100%;
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.delivery-gap {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-2);
}
.delivery-gap-text {
  min-width: 0;
  overflow-wrap: anywhere;
}
.delivery-gap-jump {
  flex-shrink: 0;
  padding: 2px 10px;
  font: inherit;
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--c-warning-text);
  background: transparent;
  border: 1px solid var(--c-warning);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.delivery-gap-jump:hover {
  background: var(--c-hover);
  filter: none;
}
.delivery-gap-jump:focus-visible {
  outline: 2px solid var(--c-primary);
  outline-offset: 2px;
}
.delivery-terminal-note {
  margin: 0;
  padding: var(--sp-2) var(--sp-4);
  font-size: var(--fs-body);
  color: var(--c-text-muted);
  background: var(--c-card);
  border-bottom: 1px solid var(--c-border);
  flex-shrink: 0;
}
.delivery-pane-tabs {
  height: 36px;
  flex-shrink: 0;
  display: flex;
  align-items: stretch;
  border-bottom: 1px solid var(--c-border);
  padding: 0 var(--sp-2);
}
.delivery-pane-tab {
  flex-shrink: 0;
  padding: 0 var(--sp-3);
  font: inherit;
  font-size: var(--fs-body);
  font-weight: 500;
  color: var(--c-text-muted);
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  white-space: nowrap;
}
.delivery-pane-tab:hover {
  color: var(--c-text);
}
.delivery-pane-tab.active {
  color: var(--c-primary-text);
  border-bottom-color: var(--c-primary);
}

/* 移动端:一行塞不下「标题 + 徽标 + N/M + 推进按钮 + 取消」,与其把标题压成纯省
   略号,不如换行分两行——第一行标题 + 徽标,第二行动作组整体右对齐。不隐藏、不降级
   任何信息:N/M 照样可见,推进按钮照样可点,移动端的约束是宽度而非信息重要性。 */
@media (max-width: 767px) {
  .delivery-detail-head {
    flex-wrap: wrap;
  }
  .delivery-head-actions {
    flex-basis: 100%;
    flex-wrap: wrap;
  }
}
</style>
