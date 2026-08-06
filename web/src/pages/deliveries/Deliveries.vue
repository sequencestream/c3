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
  'link-intent': [intentId: string]
  'unlink-intent': [intentId: string]
  'open-workspace-settings': []
  'mobile-back': [targetKey: string]
}>()

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
        @update="(payload) => emit('update', payload)"
        @cancel="(id: string) => emit('cancel', id)"
        @transition="(to, confirm) => emit('transition', to, confirm)"
        @init-branch="(payload) => emit('init-branch', payload)"
        @cleanup-branch="(id: string) => emit('cleanup-branch', id)"
        @link-intent="(id: string) => emit('link-intent', id)"
        @unlink-intent="(id: string) => emit('unlink-intent', id)"
        @open-workspace-settings="emit('open-workspace-settings')"
      />
    </template>
  </MobileStack>
</template>
