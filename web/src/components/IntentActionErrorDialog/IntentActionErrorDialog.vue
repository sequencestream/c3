<script setup lang="ts">
/*
 * IntentActionErrorDialog.vue — 意图动作失败的全局对话框。
 *
 * 它在既有 ErrorDialog 之上只做一件事:决定「这次失败该说什么」。三种情形,
 * 各自只有一处原始错误,绝不重复堆叠:
 *
 *   1. 无指引(门禁拒绝等)—— 原样展示已翻译的错误文案,没有详情块、没有按钮,
 *      与引入定向指引之前完全一致。
 *   2. 已识别原因 —— 主展示是该原因对应的定向修复指引(要求用户去做什么),
 *      原始错误作为可滚动的诊断详情附在下方。文案只描述用户该做什么,绝不声称
 *      c3 已经代为清理、解冲突或改凭据。
 *   3. `unknown` —— 不臆测修复步骤:主展示直接就是原始错误文本(保留换行),
 *      没有详情为空时退回稳定兜底文案。
 *
 * 重试按钮只在指引携带合法重试目标时出现,点击先关闭本对话框再上抛 `retry`,
 * 由调用方走原有动作入口与既有门禁 —— 这是用户显式重试,不绕过任何确认或校验。
 */
import { computed } from 'vue'
import type { GitActionFailureGuidance } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'
import { guidanceMessageKey, retryButtonKey } from '@/lib/git-failure-guidance'
import ErrorDialog from '@/components/ErrorDialog/ErrorDialog.vue'

const { t } = useTypedI18n()

const props = defineProps<{
  open: boolean
  /** 已本地化的服务端错误文案。 */
  message: string
  /** 已校验的定向指引;null 表示无指引(或收到的描述符不合法)。 */
  guidance: GitActionFailureGuidance | null
  /** 是否展示「关联已有 PR」次要动作。 */
  showLinkExistingPr?: boolean
}>()

const emit = defineEmits<{
  close: []
  retry: [guidance: GitActionFailureGuidance]
  linkExistingPr: []
}>()

/** 已识别原因的定向指引文案;`unknown` 与无指引都为 null。 */
const guidanceText = computed(() => {
  const key = props.guidance ? guidanceMessageKey(props.guidance.reason) : null
  return key ? t(key) : null
})

/** 原始错误文本;空白视为「未返回详细信息」。 */
const rawDetail = computed(() => {
  const detail = props.guidance?.detail ?? ''
  return detail.trim() === '' ? null : detail
})

const dialogMessage = computed(() => {
  if (guidanceText.value) return guidanceText.value
  // `unknown`:原始错误就是主展示;服务端没给出任何文本时才退回稳定兜底。
  if (props.guidance) return rawDetail.value ?? t('intent.gitFailure.noDetail')
  return props.message
})

/** 详情块只在主展示不是原始错误本身时出现,避免同一段输出展示两遍。 */
const dialogDetail = computed(() => (guidanceText.value ? rawDetail.value : null))

const retryLabel = computed(() =>
  props.guidance ? t(retryButtonKey(props.guidance.retry.action)) : undefined,
)

function onRetry(): void {
  const guidance = props.guidance
  if (!guidance) return
  // 先关闭再上抛:重试是一次全新的动作,旧的失败展示不该留在屏幕上。
  emit('close')
  emit('retry', guidance)
}

function onLinkExistingPr(): void {
  emit('linkExistingPr')
}
</script>

<template>
  <ErrorDialog
    :open="open"
    :title="t('error.intentAction.title')"
    :message="dialogMessage"
    :detail="dialogDetail ?? undefined"
    :detail-label="dialogDetail ? t('intent.gitFailure.rawDetail.label') : undefined"
    :secondary-action-label="showLinkExistingPr ? t('intent.prLink.action.label') : undefined"
    :action-label="retryLabel"
    :close-label="t('common.action.close.label')"
    @close="emit('close')"
    @action="onRetry"
    @secondary-action="onLinkExistingPr"
  />
</template>
