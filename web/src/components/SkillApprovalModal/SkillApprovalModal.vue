<script setup lang="ts">
/*
 * SkillApprovalModal.vue — 外部 skill 加载审批模态框(3/3 UI,mount layer 2/3)。
 *
 * 外部 skill 现在静默挂载(直取配置 ref 最新版软链),唯一审批是:
 *   - gitignore : 项目级 .gitignore 追加 _c3_* 的一次性确认
 *
 * 渲染后端下发的 skill_load_approval_request,emit 用户决定供 App 通过 WS 回传。
 */
import { useTypedI18n } from '@/i18n'
import type { SkillApprovalKind, VendorId } from '@ccc/shared/protocol'

const { t } = useTypedI18n()

/** The on-wire shape of a `skill_load_approval_request` (subset of ServerToClient). */
export interface ApprovalRequest {
  requestId: string
  kind: SkillApprovalKind
  id: string
  vendor: VendorId
  repo: string
  ref: string
  detail: string
}

const props = defineProps<{
  open: boolean
  approval: ApprovalRequest | null
}>()

const emit = defineEmits<{
  approve: [requestId: string]
  cancel: [requestId: string]
  close: []
}>()

function onApprove() {
  if (!props.approval) return
  emit('approve', props.approval.requestId)
}

function onCancel() {
  if (!props.approval) return
  emit('cancel', props.approval.requestId)
}
</script>

<template>
  <div
    v-if="open && approval"
    class="sa-overlay"
    data-testid="skill-approval-overlay"
    @click.self="emit('close')"
  >
    <div class="sa-modal" role="dialog" aria-modal="true">
      <div class="sa-head">
        <h3>{{ t('skillApproval.modal.title.label') }}</h3>
        <button class="icon-btn" :title="t('common.action.close.tooltip')" @click="emit('close')">
          ✕
        </button>
      </div>

      <!-- gitignore: one-time .gitignore append confirm (the only remaining gate) -->
      <p class="sa-title">
        {{ t('skillApproval.modal.gitignore.title') }}
      </p>
      <p class="sa-hint">{{ t('skillApproval.modal.gitignore.detail') }}</p>
      <code class="sa-gitignore-line">{{ approval.detail }}</code>

      <div class="sa-foot">
        <button class="ghost" data-testid="sa-cancel" @click="onCancel">
          {{ t('skillApproval.modal.gitignore.cancel.label') }}
        </button>
        <button data-testid="sa-approve" @click="onApprove">
          {{ t('skillApproval.modal.gitignore.approve.label') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sa-overlay {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}
.sa-modal {
  max-width: 520px;
  width: 90vw;
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  padding: var(--sp-4);
  box-shadow: var(--shadow-lg, 0 8px 32px rgba(0, 0, 0, 0.25));
}
.sa-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--sp-4);
}
.sa-head h3 {
  margin: 0;
  font-size: var(--fs-body);
  font-weight: 600;
}
.sa-title {
  font-size: var(--fs-body);
  font-weight: 500;
  margin: 0 0 var(--sp-2);
}
.sa-detail {
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  margin: 0 0 var(--sp-2);
  word-break: break-all;
}
.sa-hint {
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  margin: 0 0 var(--sp-3);
  line-height: var(--lh-normal);
}
.sa-guidance {
  font-size: var(--fs-body);
  margin: 0 0 var(--sp-4);
  line-height: var(--lh-normal);
  color: var(--c-text);
}
.sa-gitignore-line {
  display: block;
  font-family: var(--font-mono);
  font-size: var(--fs-code);
  background: var(--c-bg-card, var(--c-code-bg));
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--radius-sm);
  margin-bottom: var(--sp-4);
  word-break: break-all;
}
.sa-foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
  margin-top: var(--sp-3);
}

@media (max-width: 767px) {
  .sa-overlay {
    align-items: stretch;
    justify-content: stretch;
    background: var(--c-bg);
  }

  .sa-modal {
    width: 100vw;
    max-width: none;
    min-height: 100dvh;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    padding: calc(var(--sp-4) + env(safe-area-inset-top)) var(--sp-4)
      calc(var(--sp-4) + env(safe-area-inset-bottom));
  }

  .sa-head {
    flex-shrink: 0;
  }

  .sa-foot {
    margin-top: auto;
    padding-top: var(--sp-4);
  }
}
</style>
