<script setup lang="ts">
/*
 * DeliveryIntentsTab.vue — 关联意图 tab。
 *
 * 列表四列:意图标题 / 意图状态 / **该意图对本交付的 PR** / head 分支。第三列取服务端
 * `associatedIntents[]` 的 `prStatus`/`prNumber`/`prUrl`(即 delivery_id 命中本交付的
 * 那条 PR),不是意图的全局 PR 聚合 —— 同一意图可对不同交付各有一条 PR,用全局聚合会
 * 把别的交付的状态显示到这里。本组件不做任何聚合,只渲染服务端给的行;PR 编号在有
 * `prUrl` 时是跳向 forge 的新窗口链接,无链接时退化为纯文本。
 *
 * 意图状态用组件私有的徽标类分色(七态,含 blocked/failed),不复用全局 `.req-status`
 * —— 意图主列表/详情的状态样式不在本轮范围内,私有类可独立演进而不牵动那两处。
 *
 * 解除关联收在行尾次级位置:PR 已 merged 的行整个按钮不渲染(合并后本就不可解除,
 * 留一个禁用按钮只是噪声),未合并行走 danger ConfirmDialog 二次确认后上抛。是否真能
 * 解除由服务端复核(本地 + forge 实时状态双层),本组件的隐藏只是提前表达,不构成门禁。
 *
 * 关联入口只列出「尚未归属任何交付」的意图:第一版不开放一个意图关联多个交付的
 * 入口(数据层支持多行,交互层不给路径)。
 *
 * 标题渲染为链接态按钮:点击上抛 `open-intent`,最终由 App 用交付页当前工作区调
 * `openLinkedIntent` 跳到意图页并选中该意图 —— 与意图侧「关联交付」的 `open-delivery`
 * 反向对称。热区只覆盖标题文字,行内其余单元格与「解除关联」互不触发。
 */
import { computed, ref } from 'vue'
import { useTypedI18n } from '@/i18n'
import type { AssociatedIntent, Delivery, Intent, IntentPrStatus } from '@ccc/shared/protocol'
import ConfirmDialog from '@/components/ConfirmDialog/ConfirmDialog.vue'
import { statusLabel } from '@/lib/intent-list-view'

const props = defineProps<{
  delivery: Delivery
  /** Server-listed linked intents; each row's `prStatus` is toward THIS delivery. */
  associatedIntents: AssociatedIntent[]
  /** This workspace's intents, for the link picker (filtered here). */
  intents: Intent[]
}>()

const emit = defineEmits<{
  link: [intentId: string]
  unlink: [intentId: string]
  /** 标题点击:跳到该意图详情。与意图侧的 open-delivery 反向对称。 */
  'open-intent': [intentId: string]
}>()

const { t } = useTypedI18n()

const PR_STATUS_LABEL_KEYS = {
  reviewing: 'intent.prStatus.reviewing.label',
  rejected: 'intent.prStatus.rejected.label',
  failed: 'intent.prStatus.failed.label',
  merged: 'intent.prStatus.merged.label',
  closed: 'intent.prStatus.closed.label',
} as const

function prStatusLabel(s: IntentPrStatus | null): string {
  return s ? t(PR_STATUS_LABEL_KEYS[s]) : t('delivery.page.associatedIntents.noPr.label')
}

/** 「PR #123」—— 编号本身,链接与否由模板决定。 */
function prNumberLabel(number: string): string {
  return t('delivery.page.associatedIntents.pr.label', { number })
}

// ── 关联入口 ────────────────────────────────────────────────────────────────
// 候选 = 本工作区中尚未关联到任何交付的意图。过滤在这里而不是服务端,是因为
// 「不开放多交付关联」是交互层的克制,数据层依然允许多行。
const linkOpen = ref(false)
const picked = ref('')

const candidates = computed<Intent[]>(() =>
  props.intents.filter((i) => i.linkedDeliveries.length === 0),
)

function openLink(): void {
  picked.value = candidates.value[0]?.id ?? ''
  linkOpen.value = true
}

function confirmLink(): void {
  if (!picked.value) return
  emit('link', picked.value)
  linkOpen.value = false
  picked.value = ''
}

// ── 解除关联(危险操作,ConfirmDialog 二次确认) ────────────────────────────
const unlinkTarget = ref<AssociatedIntent | null>(null)

function confirmUnlink(): void {
  const target = unlinkTarget.value
  unlinkTarget.value = null
  if (target) emit('unlink', target.id)
}
</script>

<template>
  <div class="delivery-intents" data-testid="delivery-intents-tab">
    <div class="delivery-intents-head">
      <h3 class="delivery-intents-title">
        {{ t('delivery.page.associatedIntents.title.label') }}
      </h3>
      <button
        type="button"
        class="delivery-intents-link-btn"
        data-testid="delivery-intents-link"
        @click="openLink"
      >
        {{ t('delivery.action.link.label') }}
      </button>
    </div>

    <div v-if="linkOpen" class="delivery-intents-picker" data-testid="delivery-intents-picker">
      <template v-if="candidates.length">
        <label class="delivery-intents-picker-label" for="delivery-link-intent">
          {{ t('delivery.action.link.pickerTitle.label') }}
        </label>
        <select id="delivery-link-intent" v-model="picked" class="delivery-intents-picker-select">
          <option v-for="i in candidates" :key="i.id" :value="i.id">{{ i.title }}</option>
        </select>
        <button
          type="button"
          class="delivery-intents-link-btn"
          data-testid="delivery-intents-link-confirm"
          @click="confirmLink"
        >
          {{ t('delivery.action.link.confirm.label') }}
        </button>
      </template>
      <p v-else class="delivery-intents-empty" data-testid="delivery-intents-picker-empty">
        {{ t('delivery.action.link.pickerEmpty.label') }}
      </p>
      <button type="button" class="delivery-intents-link-cancel" @click="linkOpen = false">
        {{ t('common.action.cancel.label') }}
      </button>
    </div>

    <p
      v-if="associatedIntents.length === 0"
      class="delivery-intents-empty"
      data-testid="delivery-intents-empty"
    >
      {{ t('delivery.page.intentsEmpty.label') }}
    </p>

    <ul v-else class="delivery-intents-list">
      <li
        v-for="row in associatedIntents"
        :key="row.id"
        class="delivery-intents-row"
        :data-testid="`delivery-intent-row-${row.id}`"
      >
        <button
          type="button"
          class="delivery-intents-cell delivery-intents-cell--title"
          :data-testid="`delivery-intent-title-${row.id}`"
          :title="row.title"
          @click="emit('open-intent', row.id)"
        >
          {{ row.title }}
        </button>
        <span
          class="delivery-intents-cell delivery-intents-cell--status delivery-intents-status"
          :class="row.status"
          :data-testid="`delivery-intent-status-${row.id}`"
          >{{ statusLabel(row.status) }}</span
        >
        <span
          class="delivery-intents-cell delivery-intents-cell--pr"
          :data-testid="`delivery-intent-pr-${row.id}`"
        >
          <template v-if="row.prStatus">
            <!-- 有 url 才是链接:新窗口跳 forge。锚点点击不冒泡到标题的 open-intent。 -->
            <a
              v-if="row.prNumber && row.prUrl"
              class="delivery-intents-pr-link"
              :href="row.prUrl"
              target="_blank"
              rel="noopener noreferrer"
              :data-testid="`delivery-intent-pr-link-${row.id}`"
              >{{ prNumberLabel(row.prNumber) }}</a
            >
            <span
              v-else-if="row.prNumber"
              class="delivery-intents-pr-number"
              :data-testid="`delivery-intent-pr-number-${row.id}`"
              >{{ prNumberLabel(row.prNumber) }}</span
            >
            <span
              class="req-pr-status"
              :class="`req-pr-status--${row.prStatus}`"
              :data-testid="`delivery-intent-pr-status-${row.id}`"
              >{{ prStatusLabel(row.prStatus) }}</span
            >
          </template>
          <template v-else>{{ prStatusLabel(null) }}</template>
        </span>
        <span class="delivery-intents-cell delivery-intents-cell--branch">{{
          row.headBranch ?? '—'
        }}</span>
        <!-- merged 的行不渲染解除入口:合并后不可解除是既定语义,merged 徽标已说明
             一切,留个禁用按钮只会请人来点一次再被拒。 -->
        <button
          v-if="row.prStatus !== 'merged'"
          type="button"
          class="delivery-intents-unlink-btn"
          :data-testid="`delivery-intent-unlink-${row.id}`"
          @click="unlinkTarget = row"
        >
          {{ t('delivery.action.unlink.label') }}
        </button>
      </li>
    </ul>

    <p class="delivery-intents-ready">
      {{
        t('delivery.status.integrationReady.label', {
          merged: delivery.integration.merged,
          total: delivery.integration.total,
        })
      }}
    </p>

    <ConfirmDialog
      :open="unlinkTarget !== null"
      :title="t('delivery.action.unlink.title.label')"
      :message="t('delivery.action.unlink.body.label', { title: unlinkTarget?.title ?? '' })"
      :confirm-label="t('delivery.action.unlink.label')"
      :cancel-label="t('common.action.cancel.label')"
      danger
      @confirm="confirmUnlink"
      @cancel="unlinkTarget = null"
    />
  </div>
</template>

<style scoped>
.delivery-intents {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-3) var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.delivery-intents-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.delivery-intents-title {
  margin: 0;
  flex: 1;
  min-width: 0;
  font-size: var(--fs-body);
  font-weight: 600;
}
.delivery-intents-link-btn,
.delivery-intents-link-cancel {
  flex-shrink: 0;
  padding: var(--sp-1) var(--sp-2);
  font: inherit;
  font-size: var(--fs-caption);
  color: var(--c-text);
  background: transparent;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.delivery-intents-picker {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2);
  background: var(--c-card);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
}
.delivery-intents-picker-label {
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
.delivery-intents-picker-select {
  flex: 1;
  min-width: 160px;
  font: inherit;
  font-size: var(--fs-caption);
  padding: var(--sp-1);
  color: var(--c-text);
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
}
.delivery-intents-empty {
  margin: 0;
  font-size: var(--fs-body);
  color: var(--c-text-muted);
}
.delivery-intents-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.delivery-intents-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
}
.delivery-intents-cell {
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 标题是页内导航链接(跳到该意图详情),故用按钮 + 链接态样式而不是 <a>。
   只让标题文字可点:行尾就是「解除关联」危险按钮,整行热区会抬高误触风险。 */
.delivery-intents-cell--title {
  flex: 1;
  min-width: 120px;
  padding: 0;
  font: inherit;
  font-size: var(--fs-body);
  text-align: left;
  color: var(--c-primary-text);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  text-decoration: underline;
}
.delivery-intents-cell--title:hover {
  background: var(--c-hover);
}
/* 意图状态徽标:与意图列表 .req-status 同款 pill,但类是组件私有的 —— 全局那份服务
   意图主列表/详情,本轮不动它;这里额外补齐 blocked/failed 两态。 */
.delivery-intents-status {
  flex-shrink: 0;
  font-size: var(--fs-badge);
  font-weight: 700;
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  background: var(--c-hover-strong);
  color: var(--c-text-muted);
}
.delivery-intents-status.draft {
  background: var(--c-hover-strong);
  color: var(--c-text-muted);
}
.delivery-intents-status.todo {
  background: rgba(99, 102, 241, 0.15);
  color: var(--c-primary-text);
}
.delivery-intents-status.in_progress {
  background: rgba(245, 158, 11, 0.15);
  color: var(--c-warning-text);
}
.delivery-intents-status.done {
  background: rgba(34, 197, 94, 0.15);
  color: var(--c-success-text);
}
.delivery-intents-status.cancelled {
  background: rgba(239, 68, 68, 0.12);
  color: var(--c-error-text);
}
/* 卡住与失败都是「需要人来看一眼」,同族但比 in_progress / cancelled 更重的填充,
   免得三个暖色/红色态在一列里读成同一个。 */
.delivery-intents-status.blocked {
  background: rgba(245, 158, 11, 0.3);
  color: var(--c-warning-text);
}
.delivery-intents-status.failed {
  background: rgba(239, 68, 68, 0.24);
  color: var(--c-error-text);
}
/* PR 列:编号(可跳转)+ 状态徽标并排。 */
.delivery-intents-cell--pr {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
}
.delivery-intents-pr-link,
.delivery-intents-pr-number {
  white-space: nowrap;
}
.delivery-intents-pr-link {
  color: var(--c-primary-text);
  text-decoration: underline;
}
.delivery-intents-unlink-btn {
  flex-shrink: 0;
  margin-left: auto;
  padding: var(--sp-1) var(--sp-2);
  font: inherit;
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  background: transparent;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.delivery-intents-ready {
  margin: 0;
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
</style>
