<script setup lang="ts">
/*
 * Deliveries.vue — 交付页容器。
 *
 * 桌面两栏:左侧交付列表 + 右侧详情。数据与动作由 App.vue 经 props/emits 注入;
 * 状态推进/缺口可达性均来自服务端 `transitionPlan`,本页只消费不重算。
 * 移动端退化为两级 drill-down 栈(列表 → 详情,MobileStack)。
 */
import { computed } from 'vue'
import { useTypedI18n } from '@/i18n'
import type {
  AssociatedIntent,
  Delivery,
  DeliveryLog,
  DeliveryPr,
  DeliveryStatus,
  DeliveryTransitionPlan,
  Intent,
} from '@ccc/shared/protocol'
import type { DeliveryBranchInitState } from '@/lib/delivery-view'
import MobileStack from '../../components/MobileStack/MobileStack.vue'
import DeliveryList from './components/DeliveryList/DeliveryList.vue'
import DeliveryDetail from './components/DeliveryDetail/DeliveryDetail.vue'

const { t } = useTypedI18n()

const props = defineProps<{
  deliveries: Delivery[]
  activeId: string | null
  activeDelivery: Delivery | null
  activePlan: DeliveryTransitionPlan | null
  branchInit: DeliveryBranchInitState | null
  workspaceGitBranchMode: 'worktree' | 'current-branch'
  associatedIntents: AssociatedIntent[]
  intents: Intent[]
  mainlineAhead: number | null
  /** How far the open delivery's branch is ahead of mainline; null = unknown. */
  deliveryBranchAhead: number | null
  syncPhase: 'fetching' | 'merging' | 'pushing' | null
  /** The open delivery's latest 「交付分支 → 主线」 PR; null = none opened. */
  deliveryPr: DeliveryPr | null
  /** Whether a delivery-PR create / sync round trip is in flight. */
  deliveryPrBusy: boolean
  /** Delivery lifecycle logs cached per delivery id; a missing key = not fetched. */
  deliveryLogsById: Record<string, DeliveryLog[]>
  /** The delivery id whose log fetch is in flight; null = idle. */
  deliveryLogsLoadingId: string | null
}>()

const emit = defineEmits<{
  open: [deliveryId: string]
  create: [
    payload: {
      title: string
      description?: string
      startDate?: number | null
      endDate?: number | null
    },
  ]
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
  'list-logs': [deliveryId: string]
  'mobile-back': [targetKey: string]
}>()

// 日志按交付 id 取:缓存里没有这条交付的键 = 没拉过 / 已失效,详情 Tab 据此懒加载。
// 迟到的另一条交付的回包落在它自己的键上,永远不会被当作当前交付的轨迹渲染。
const activeDeliveryLogs = computed<DeliveryLog[] | null>(() =>
  props.activeId ? (props.deliveryLogsById[props.activeId] ?? null) : null,
)
// 加载态按 id 判定,不是全局开关:换交付后上一条的在途请求不该让新交付显示加载中。
const activeDeliveryLogsLoading = computed(
  () => props.activeId !== null && props.deliveryLogsLoadingId === props.activeId,
)

const mobilePanes = computed(() => [
  { key: 'deliveries', title: t('delivery.page.title.label') },
  { key: 'detail', title: props.activeDelivery?.title ?? t('delivery.page.title.label') },
])
const mobileActiveKey = computed(() => (props.activeId ? 'detail' : 'deliveries'))
const mobileActiveToken = computed(() => props.activeId ?? 'deliveries')
</script>

<template>
  <MobileStack
    :panes="mobilePanes"
    :active-key="mobileActiveKey"
    :active-token="mobileActiveToken"
    :back-label="t('delivery.page.title.label')"
    @back="(targetKey: string) => emit('mobile-back', targetKey)"
  >
    <template #deliveries>
      <DeliveryList
        :deliveries="deliveries"
        :active-id="activeId"
        @open="(id: string) => emit('open', id)"
        @create="(payload) => emit('create', payload)"
      />
    </template>

    <template #detail>
      <DeliveryDetail
        v-if="activeDelivery && activePlan"
        :delivery="activeDelivery"
        :plan="activePlan"
        :branch-init="branchInit"
        :workspace-git-branch-mode="workspaceGitBranchMode"
        :associated-intents="associatedIntents"
        :intents="intents"
        :mainline-ahead="mainlineAhead"
        :delivery-branch-ahead="deliveryBranchAhead"
        :sync-phase="syncPhase"
        :delivery-pr="deliveryPr"
        :delivery-pr-busy="deliveryPrBusy"
        :logs="activeDeliveryLogs"
        :logs-loading="activeDeliveryLogsLoading"
        @update="(payload) => emit('update', payload)"
        @cancel="(id: string) => emit('cancel', id)"
        @transition="(to, confirm) => emit('transition', to, confirm)"
        @init-branch="(payload) => emit('init-branch', payload)"
        @cleanup-branch="(id: string) => emit('cleanup-branch', id)"
        @sync-mainline="(id: string) => emit('sync-mainline', id)"
        @create-delivery-pr="(id: string) => emit('create-delivery-pr', id)"
        @sync-delivery-pr="(id: string) => emit('sync-delivery-pr', id)"
        @link-intent="(id: string) => emit('link-intent', id)"
        @unlink-intent="(id: string) => emit('unlink-intent', id)"
        @open-intent="(id: string) => emit('open-intent', id)"
        @open-workspace-settings="emit('open-workspace-settings')"
        @list-logs="(id: string) => emit('list-logs', id)"
      />
    </template>
  </MobileStack>
</template>
