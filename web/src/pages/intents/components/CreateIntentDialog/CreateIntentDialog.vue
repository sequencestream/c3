<script setup lang="ts">
/*
 * CreateIntentDialog.vue — 新增意图弹窗:选定基准 + 写下意图内容,一次提交。
 *
 * 取代「+」直接登记一条空白 draft 的旧行为。登记、基准选择和意图会话的第一句话
 * 合并成一次操作:提交后服务端在同一请求里落库意图并启动它的 owner 会话,因此
 * 用户不必再开一次会话把背景重讲一遍。
 *
 * 基准来源是互斥的两支,对应协议的 CreateIntentBase:交付只交出 id(分支由服务端
 * 从交付记录读,客户端不解析也不伪造),分支交出用户填的名字。默认停在「分支」支
 * 并预填工作区主分支——「默认」因此是一次显式选择,而不是服务端的隐式兜底,它落库
 * 的值可以被断言。
 *
 * 只列出分支已就绪的交付:分支未初始化的交付没有可写入的 base_branch,服务端会拒,
 * 与其让用户提交后才被拒,不如不给选。
 *
 * 受控模态范式沿用 InputDialog/ConfirmDialog/DeliveryEditDialog(父持 open、遮罩/
 * Esc/取消一律 emit cancel、移动端全屏 sheet)。宽度取设计规范的弹窗默认值:页面
 * 宽度的二分之一(上下限兜住超宽屏与窄屏)。
 *
 * 草稿只在「打开」这一刻重置。提交被服务端拒绝时父组件保持弹窗打开,草稿因此原样
 * 留在表单里,用户改掉基准再提交即可,不必重打内容。
 */
import { computed, nextTick, ref, watch } from 'vue'
import type { CreateIntentBase, Delivery } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'

const { t } = useTypedI18n()

const props = defineProps<{
  open: boolean
  /** 当前工作区的交付;只有分支已就绪的才可选。 */
  deliveries: Delivery[]
  /** 工作区主分支,作为「分支」支的预填值。 */
  mainBranch: string | null
  /** 提交在途:禁用表单并防重复提交。 */
  pending: boolean
}>()

const emit = defineEmits<{
  confirm: [payload: { content: string; base: CreateIntentBase }]
  cancel: []
}>()

type BaseKind = 'branch' | 'delivery'

const baseKind = ref<BaseKind>('branch')
const branch = ref('')
const deliveryId = ref('')
const content = ref('')
const contentInput = ref<HTMLTextAreaElement | null>(null)

/** 分支已就绪且分支名非空的交付——其余没有可写入的基准,不进选项。 */
const selectableDeliveries = computed<Delivery[]>(() =>
  props.deliveries.filter((d) => d.branchReady && !!d.branchName?.trim()),
)

const baseComplete = computed<boolean>(() =>
  baseKind.value === 'branch'
    ? branch.value.trim().length > 0
    : selectableDeliveries.value.some((d) => d.id === deliveryId.value),
)

// 该入口没有图片输入,内容必须是非空文本才满足首轮输入规则。
const canConfirm = computed<boolean>(
  () => !props.pending && content.value.trim().length > 0 && baseComplete.value,
)

// 每次打开重置草稿并预填主分支、聚焦内容框。关闭不重置——提交被拒时弹窗保持打开,
// 草稿必须原样留着。
watch(
  () => props.open,
  (open) => {
    if (!open) return
    baseKind.value = 'branch'
    branch.value = props.mainBranch?.trim() ?? ''
    deliveryId.value = ''
    content.value = ''
    void nextTick(() => contentInput.value?.focus())
  },
  { immediate: true },
)

function onConfirm(): void {
  if (!canConfirm.value) return
  const base: CreateIntentBase =
    baseKind.value === 'branch'
      ? { kind: 'branch', branch: branch.value.trim() }
      : { kind: 'delivery', deliveryId: deliveryId.value }
  emit('confirm', { content: content.value.trim(), base })
}
</script>

<template>
  <div
    v-if="props.open"
    class="ci-overlay"
    data-testid="create-intent-overlay"
    @click.self="emit('cancel')"
    @keydown.esc="emit('cancel')"
  >
    <div
      class="ci-modal"
      role="dialog"
      aria-modal="true"
      :aria-label="t('intent.createDialog.title.label')"
      data-testid="create-intent-dialog"
    >
      <h3 class="ci-title">{{ t('intent.createDialog.title.label') }}</h3>

      <form class="ci-form" data-testid="create-intent-form" @submit.prevent="onConfirm">
        <fieldset class="ci-field" :disabled="props.pending">
          <legend>{{ t('intent.createDialog.baseSource.label') }}</legend>
          <div class="ci-choices">
            <label class="ci-choice">
              <input
                v-model="baseKind"
                type="radio"
                value="branch"
                data-testid="create-intent-base-branch"
              />
              <span>{{ t('intent.createDialog.baseSource.branch.label') }}</span>
            </label>
            <label class="ci-choice">
              <input
                v-model="baseKind"
                type="radio"
                value="delivery"
                data-testid="create-intent-base-delivery"
              />
              <span>{{ t('intent.createDialog.baseSource.delivery.label') }}</span>
            </label>
          </div>

          <input
            v-if="baseKind === 'branch'"
            v-model="branch"
            type="text"
            data-testid="create-intent-branch"
            :placeholder="t('intent.createDialog.branch.placeholder.label')"
          />
          <template v-else>
            <select v-model="deliveryId" data-testid="create-intent-delivery">
              <option value="">{{ t('intent.createDialog.delivery.placeholder.label') }}</option>
              <option v-for="d in selectableDeliveries" :key="d.id" :value="d.id">
                {{ d.title }} ({{ d.branchName }})
              </option>
            </select>
            <p
              v-if="selectableDeliveries.length === 0"
              class="ci-hint"
              data-testid="create-intent-delivery-empty"
            >
              {{ t('intent.createDialog.delivery.empty.label') }}
            </p>
          </template>
        </fieldset>

        <label class="ci-field">
          <span>{{ t('intent.createDialog.content.label') }}</span>
          <textarea
            ref="contentInput"
            v-model="content"
            rows="8"
            :disabled="props.pending"
            data-testid="create-intent-content"
            :placeholder="t('intent.createDialog.content.placeholder.label')"
          />
        </label>
      </form>

      <div class="ci-foot">
        <button class="ci-cancel" data-testid="create-intent-cancel" @click="emit('cancel')">
          {{ t('common.action.cancel.label') }}
        </button>
        <button
          class="ci-confirm"
          data-testid="create-intent-submit"
          :disabled="!canConfirm"
          @click="onConfirm"
        >
          {{ t('intent.createDialog.submit.label') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ci-overlay {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}
/* 弹窗默认宽度 = 页面宽度的二分之一(设计规范);上下限只兜住超宽屏拉成长条与
   窄屏挤没两种极端,不改变默认值本身。 */
.ci-modal {
  width: 50vw;
  min-width: 420px;
  max-width: 860px;
  box-sizing: border-box;
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  padding: var(--sp-4);
  box-shadow: var(--shadow-lg, 0 8px 32px rgba(0, 0, 0, 0.25));
}
.ci-title {
  margin: 0 0 var(--sp-3);
  font-size: var(--fs-body);
  font-weight: 600;
}
.ci-form {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  margin-bottom: var(--sp-4);
}
.ci-field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
.ci-field legend {
  padding: 0;
  margin-bottom: var(--sp-1);
}
.ci-choices {
  display: flex;
  gap: var(--sp-3);
  margin-bottom: var(--sp-1);
}
.ci-choice {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  color: var(--c-text);
  cursor: pointer;
}
.ci-choice input {
  margin: 0;
}
.ci-field input[type='text'],
.ci-field select,
.ci-field textarea {
  width: 100%;
  box-sizing: border-box;
  font: inherit;
  font-size: var(--fs-body);
  color: var(--c-text);
  background: var(--c-input);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md, 6px);
  padding: var(--sp-1) var(--sp-2);
}
.ci-field textarea {
  resize: vertical;
}
.ci-field input[type='text']:focus,
.ci-field select:focus,
.ci-field textarea:focus {
  outline: none;
  border-color: var(--c-primary);
}
.ci-hint {
  margin: var(--sp-1) 0 0;
  color: var(--c-text-muted);
}
.ci-foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
}
/* 取消:次级描边按钮(覆盖全局 button 的渐变填充)。 */
.ci-cancel {
  background: transparent;
  color: var(--c-text-muted);
  border: 1px solid var(--c-border);
}
.ci-cancel:hover:not(:disabled) {
  background: var(--c-hover);
  color: var(--c-text);
  filter: none;
}
.ci-confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 移动端全屏 sheet(对齐 ConfirmDialog / InputDialog / DeliveryEditDialog 范式),
   页脚按钮吸底。 */
@media (max-width: 767px) {
  .ci-overlay {
    align-items: stretch;
    justify-content: stretch;
    background: var(--c-bg);
  }
  .ci-modal {
    width: 100vw;
    min-width: 0;
    max-width: none;
    min-height: 100dvh;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    display: flex;
    flex-direction: column;
    padding: calc(var(--sp-4) + env(safe-area-inset-top)) var(--sp-4)
      calc(var(--sp-4) + env(safe-area-inset-bottom));
  }
  .ci-foot {
    margin-top: auto;
    padding-top: var(--sp-4);
  }
}
</style>
