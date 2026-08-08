<script setup lang="ts">
/*
 * IntentSpecTab.vue — spec tab:渲染 specPath 指向的 spec.md,或纯文本源码直接编辑。
 *
 * 顶部操作区(批准 / 编辑 / 我要修改)的可见性由容器按四态主按钮 + 防误审门 + 依赖门决定后
 * 以 props 输入;「编辑」入口三门禁(specPath 存在 + todo 且无 lastWorkSessionId + 无运行中 spec
 * 会话)由本组件据 intent + specSessionRunning 自行判定。编辑草稿只活在组件内,保存只 emit,退出
 * 编辑态由服务端回填(updatedAt 变化)驱动并重发 read-spec 渲染覆盖后内容;被拒(错误序号自增)
 * 释放守卫但保留草稿。批准仅由专用入口 emit approve-spec;我要修改上抛 modify 由容器打开会话重置。
 */
import { computed, ref, watch } from 'vue'
import type { Intent, SpecReviewVerdict } from '@ccc/shared/protocol'
import { MACHINE_SPEC_APPROVER, MAX_SPEC_REVIEW_REWORK_ROUNDS } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'
import MarkdownText from '../../../../components/MarkdownText/MarkdownText.vue'

const { t } = useTypedI18n()

const props = defineProps<{
  intent: Intent
  intentSpecContent: string | null
  intentSpecLoading: boolean
  specSessionRunning?: boolean
  intentActionErrorSeq?: number
  // 操作区可见性/禁用态由容器输入(四态主按钮 + 10 秒防误审门 + Spec 依赖门)。
  showApprove: boolean
  showModify: boolean
  modifyDisabled: boolean
}>()

const emit = defineEmits<{
  'approve-spec': [intentId: string]
  'revoke-spec-approval': [intentId: string]
  'save-spec-content': [intentId: string, content: string]
  'read-spec': [intentId: string, specPath: string]
  modify: []
}>()

// 三门禁全满足才允许直接编辑 spec:specPath 存在、未启动开发
// (todo 且无 lastWorkSessionId)、无运行中 spec 会话。任一不满足则隐藏入口。
const canEditSpec = computed<boolean>(() => {
  const r = props.intent
  return !!r.specPath && r.status === 'todo' && !r.lastWorkSessionId && !props.specSessionRunning
})

// 操作区整体可见:编辑态隐藏(避免审批/会话重置与源码保存同区并发);否则批准/我要修改需
// specPath,或「编辑」入口满足即显示。
const showSpecActions = computed<boolean>(
  () => !!props.intent.specPath && (props.showApprove || props.showModify || showRevoke.value),
)

// 撤销入口:已批准即可见。人工批准与机器批准共用同一入口——撤销的是「批准」这件事,
// 而不是某一种批准方式。撤销后意图回到「等待批准」,已在运行的开发不受影响。
const showRevoke = computed<boolean>(
  () => !!props.intent.specPath && props.intent.specStatus === 'approved',
)

// 批准是机器做出的吗?机器身份是保留常量,永不与登录 subject 冲突,因此可据此如实区分。
const approvedByMachine = computed<boolean>(
  () => props.intent.specApproveUser === MACHINE_SPEC_APPROVER,
)

// 当前审核结论——只在结论仍绑定 spec 现内容时才算数。指纹不匹配说明 spec 在结论之后被
// 改过,此时展示旧结论会误导审阅者,故按「无结论」呈现,与队列的判定口径一致。
const reviewVerdict = computed<SpecReviewVerdict | null>(() => props.intent.specReviewVerdict)

const editingSpec = ref(false)
const specDraft = ref('')
const savingSpec = ref(false)

function startEditSpec(): void {
  if (!canEditSpec.value || props.intentSpecContent === null) return
  specDraft.value = props.intentSpecContent ?? ''
  savingSpec.value = false
  editingSpec.value = true
}

function cancelEditSpec(): void {
  editingSpec.value = false
  savingSpec.value = false
}

function saveEditSpec(): void {
  if (savingSpec.value) return
  savingSpec.value = true
  emit('save-spec-content', props.intent.id, specDraft.value)
}

// 保存成功:服务端广播回填(updated_at 变化,含审批重置的 setSpecApproved 幂等 bump)后退出
// 编辑态,并重新拉取覆盖后的 spec 渲染。仅在提交在途(savingSpec)时响应。
watch(
  () => props.intent.updatedAt,
  () => {
    if (savingSpec.value) {
      savingSpec.value = false
      editingSpec.value = false
      if (props.intent.specPath) emit('read-spec', props.intent.id, props.intent.specPath)
    }
  },
)

// 服务端拒绝任一 intent.* 动作(intentActionErrorSeq 自增)释放保存守卫但保留草稿供重试。
watch(
  () => props.intentActionErrorSeq,
  (next, prev) => {
    if (next !== prev) savingSpec.value = false
  },
)

// 切走意图:丢弃未保存的 spec 草稿并退出编辑态。
watch(
  () => props.intent.id,
  () => {
    editingSpec.value = false
    savingSpec.value = false
  },
)
</script>

<template>
  <div class="intent-detail-body" data-testid="tab-spec">
    <!-- 操作区:编辑态下整体隐藏,避免审批/会话重置与源码保存同区并发。 -->
    <div
      v-if="!editingSpec && (showSpecActions || canEditSpec)"
      class="intent-detail-section-actions"
      data-testid="intent-detail-spec-actions"
    >
      <button
        v-if="showApprove"
        type="button"
        class="req-btn primary"
        data-testid="intent-detail-spec-approve"
        @click="emit('approve-spec', intent.id)"
      >
        {{ t('intent.action.approveSpec.confirmLabel') }}
      </button>
      <button
        v-if="canEditSpec"
        type="button"
        class="req-btn"
        data-testid="intent-detail-spec-edit"
        @click="startEditSpec"
      >
        {{ t('intent.action.editSpec.label') }}
      </button>
      <button
        v-if="showRevoke"
        type="button"
        class="req-btn"
        data-testid="intent-detail-spec-revoke"
        @click="emit('revoke-spec-approval', intent.id)"
      >
        {{ t('intent.action.revokeSpecApproval.label') }}
      </button>
      <button
        v-if="showModify"
        type="button"
        class="req-btn"
        data-testid="intent-detail-spec-modify"
        :title="modifyDisabled ? t('intent.specLaunch.dependencyNotMerged') : undefined"
        :disabled="modifyDisabled"
        @click="emit('modify')"
      >
        {{ t('intent.action.modifySession.label') }}
      </button>
    </div>
    <!-- 审核事实带:结论 + 理由 + 返工轮次 + 批准身份。只在有 spec 时展示;编辑态隐藏,
         与操作区一致,避免审阅者对着旧结论改稿。 -->
    <div
      v-if="intent.specPath && !editingSpec && (reviewVerdict || intent.specStatus === 'approved')"
      class="intent-detail-spec-review"
      data-testid="intent-detail-spec-review"
    >
      <span
        v-if="reviewVerdict"
        class="intent-detail-spec-review-verdict"
        :class="reviewVerdict === 'pass' ? 'is-pass' : 'is-changes'"
        data-testid="intent-detail-spec-review-verdict"
      >
        {{
          reviewVerdict === 'pass'
            ? t('intent.spec.review.verdict.pass')
            : t('intent.spec.review.verdict.changesRequested')
        }}
      </span>
      <span v-if="intent.specReviewReworkRounds > 0" class="intent-detail-spec-review-rounds">
        {{
          t('intent.spec.review.reworkRounds', {
            rounds: intent.specReviewReworkRounds,
            max: MAX_SPEC_REVIEW_REWORK_ROUNDS,
          })
        }}
      </span>
      <span
        v-if="intent.specStatus === 'approved'"
        class="intent-detail-spec-review-approver"
        data-testid="intent-detail-spec-approver"
      >
        {{
          approvedByMachine
            ? t('intent.spec.review.approvedByMachine')
            : t('intent.spec.review.approvedBy', { user: intent.specApproveUser ?? '' })
        }}
      </span>
      <!-- 理由由审核智能体自由撰写,常含列表/代码块/mermaid,故与 spec 正文走同一条渲染管线。 -->
      <div
        v-if="reviewVerdict && intent.specReviewReason"
        class="intent-detail-spec-review-reason"
        data-testid="intent-detail-spec-review-reason"
      >
        <MarkdownText :text="intent.specReviewReason" markdown />
      </div>
    </div>
    <p v-if="!intent.specPath" class="intent-detail-empty" data-testid="intent-detail-spec-empty">
      {{ t('intent.spec.empty') }}
    </p>
    <!-- 编辑态:纯文本 Markdown 源码框 + 框下方左侧蓝色「保存」+ 取消。 -->
    <div v-else-if="editingSpec" class="req-content-edit" data-testid="intent-detail-spec-editor">
      <textarea
        v-model="specDraft"
        class="req-content-textarea"
        data-testid="intent-detail-spec-textarea"
      ></textarea>
      <div class="req-content-edit-actions">
        <button
          type="button"
          class="req-btn primary"
          data-testid="intent-detail-spec-save"
          :disabled="savingSpec"
          @click="saveEditSpec"
        >
          {{ t('common.action.save.label') }}
        </button>
        <button
          type="button"
          class="req-btn"
          data-testid="intent-detail-spec-cancel"
          @click="cancelEditSpec"
        >
          {{ t('common.action.cancel.label') }}
        </button>
      </div>
    </div>
    <p v-else-if="intentSpecLoading" class="intent-detail-empty">
      {{ t('intent.spec.loading') }}
    </p>
    <div v-else-if="intentSpecContent !== null" class="req-detail">
      <MarkdownText :text="intentSpecContent" markdown />
    </div>
  </div>
</template>

<style scoped>
.intent-detail-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-3);
}
.intent-detail-empty {
  margin: auto;
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  padding: var(--sp-3);
  text-align: center;
}
.intent-detail-section-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
  margin-bottom: var(--sp-3);
}
/* Spec 源码直接编辑:纯文本框 + 框下方左侧的保存/取消动作区。 */
.req-content-edit {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.req-content-textarea {
  width: 100%;
  min-height: 240px;
  box-sizing: border-box;
  resize: vertical;
  padding: var(--sp-2);
  border: 1px solid var(--c-border);
  border-radius: 6px;
  background: var(--c-bg);
  color: var(--c-text);
  font-family: var(--font-mono, monospace);
  font-size: var(--fs-caption);
  line-height: var(--lh-normal, 1.5);
}
.req-content-edit-actions {
  display: flex;
  justify-content: flex-start;
  gap: var(--sp-2);
}
/* 审核事实带:结论徽标 + 返工轮次 + 批准身份,其下是审核理由全文。 */
.intent-detail-spec-review {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-3);
  padding: var(--sp-2);
  border: 1px solid var(--c-border);
  border-radius: 6px;
  background: var(--c-bg-subtle, var(--c-bg));
  font-size: var(--fs-caption);
}
.intent-detail-spec-review-verdict {
  padding: 0 var(--sp-2);
  border-radius: 999px;
  font-weight: 600;
}
.intent-detail-spec-review-verdict.is-pass {
  background: var(--c-success-bg, transparent);
  color: var(--c-success-text);
}
.intent-detail-spec-review-verdict.is-changes {
  background: var(--c-warning-bg, transparent);
  color: var(--c-warning-text);
}
.intent-detail-spec-review-rounds,
.intent-detail-spec-review-approver {
  color: var(--c-text-muted, var(--c-text));
}
/* 理由独占整行;换行交给 markdown 管线(.md-body 已 white-space: normal + breaks: true)。 */
.intent-detail-spec-review-reason {
  flex-basis: 100%;
  min-width: 0;
  margin: 0;
  color: var(--c-text);
}
</style>
