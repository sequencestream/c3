<script setup lang="ts">
/*
 * DiscussionList.vue — 讨论视图左栏:纯列表 + 顶部「+」。
 *
 * 数据由 App 提供(读路径)。点击某讨论行只 emit `open(id)` 作纯选中,由父级在右栏
 * 标题栏 + Tab 面板展示详情与过程(行内手风琴抽屉已移除);顶部「+」打开新建弹窗
 * (类型/目标/上下文 + 参与 agent),提交上抛 `create`(写路径)。
 */
import { computed, ref } from 'vue'
import type { AgentConfig, Discussion } from '@ccc/shared/protocol'
import { listDiscussionTypes } from '@ccc/shared/discussion-types'
import { formatDate } from '../../../../lib/intent-list-view'
import { panelToggleLabel, rowVisibility } from '../../../../lib/discussion-view'
import { discussionRowIndicator, TONE_ICON } from '../../../../lib/status-indicator'
import { autoGrowHeight } from '../../../../lib/textarea'
import { useTypedI18n } from '@/i18n'

const { t, locale } = useTypedI18n()

const props = withDefaults(
  defineProps<{
    discussions: Discussion[]
    activeId: string | null
    // Live orchestration run-state per discussion (id → running/paused), decoupled from the
    // persisted `status`. Absent id = no live run. Drives the per-row status indicator so
    // concurrent background runs are each visible; accurate after refresh/reconnect via the
    // list snapshot.
    runState?: Record<string, 'running' | 'paused'>
    // Name of the in-flight / dispatched agent for a live run (id → agent name), used as the
    // `<agent>` segment of the run-state indicator. Only the active discussion has one (its
    // dispatch view lives in the parent); absent id ⇒ the segment is gracefully omitted.
    runAgentNames?: Record<string, string>
    // All configured agents — the create modal lists the enabled ones as selectable
    // participants. Absent ⇒ empty (the participant panel renders its empty state).
    agents?: AgentConfig[]
    // The organizer (default agent) id: its participant row is force-selected and
    // disabled (the organizer always joins). Absent ⇒ no row is locked.
    defaultAgentId?: string | null
  }>(),
  { runState: () => ({}), runAgentNames: () => ({}), agents: () => [], defaultAgentId: null },
)

// The enabled agents are the selectable participant roster (back-compat: no `enabled`
// field counts as enabled — mirrors the server's `enabledAgents()`, including its
// user-controlled `order_seq` ordering).
const enabledAgents = computed(() =>
  props.agents
    .filter((a) => a.enabled !== false)
    .sort((a, b) => (a.order_seq ?? 0) - (b.order_seq ?? 0)),
)

// The live run-state for a row, or undefined when it has no active run.
function liveState(d: Discussion): 'running' | 'paused' | undefined {
  return props.runState[d.id]
}

// Per-row unified status indicator (`<icon> <agent>.<status>`): show the live run
// when present, else the persisted lifecycle. Resolves icon + joined text here so the
// row template renders a single indicator. Reactive via `t`/runState/runAgentNames.
const rowStatuses = computed(
  () =>
    new Map(
      props.discussions.map((d) => {
        const ind = discussionRowIndicator({
          status: d.status,
          runState: liveState(d),
          agentName: props.runAgentNames[d.id],
        })
        const status = ind.statusParams ? t(ind.statusKey, ind.statusParams) : t(ind.statusKey)
        const text = ind.agent
          ? t('statusIndicator.agentStatus', { agent: ind.agent, status })
          : status
        return [d.id, { tone: ind.tone, spin: ind.spin, icon: TONE_ICON[ind.tone], text }] as const
      }),
    ),
)

const emit = defineEmits<{
  open: [discussionId: string]
  create: [
    payload: {
      type: string
      goal: string
      context: string
      participantAgentIds: string[]
      organizerAgentId: string
    },
  ]
}>()

const TYPES = listDiscussionTypes()

// Create modal state. The "+" toggles it; submit emits `create`.
const showForm = ref(false)
const formType = ref(TYPES[0]?.id ?? '')
const formGoal = ref('')
const formContext = ref('')
// Selected participant ids. Defaults to all enabled on open; the organizer is selectable
// (not locked). Reassigned (not mutated) so the template stays reactive.
const selectedIds = ref<Set<string>>(new Set())
// The locally-selected organizer agent id — defaults to the global defaultAgentId
// but can be overridden via the radio button per agent.
const localOrganizerId = ref<string | null>(null)

function toggleAgent(id: string): void {
  const next = new Set(selectedIds.value)
  const wasSelected = next.has(id)
  if (wasSelected) next.delete(id)
  else next.add(id)
  selectedIds.value = next
  // Auto-fallback: if the deselected agent was the organizer, pick the first
  // remaining selected agent as the new organizer.
  if (wasSelected && localOrganizerId.value === id) {
    const remaining = [...next]
    localOrganizerId.value = remaining.length > 0 ? remaining[0] : null
  }
}

function setOrganizer(id: string): void {
  localOrganizerId.value = id
}

// Submit validation: must have a goal, organizer selected, and at least one non-organizer.
const canSubmit = computed(() => {
  if (!formType.value || !formGoal.value.trim()) return false
  const orgId = localOrganizerId.value
  if (!orgId || !selectedIds.value.has(orgId)) return false
  const nonOrgCount = [...selectedIds.value].filter((id) => id !== orgId).length
  return nonOrgCount >= 1
})

// Auto-grow: the Goal/Context textareas grow with their content up to this cap,
// then scroll internally. Closing the form (v-if) destroys the elements, so a
// reopened form starts fresh; clearing content shrinks via the `input` handler.
const MAX_TEXTAREA_PX = 200
function autoGrow(e: Event): void {
  const el = e.target as HTMLTextAreaElement
  el.style.height = 'auto'
  const { height, overflowY } = autoGrowHeight(el.scrollHeight, MAX_TEXTAREA_PX)
  el.style.height = `${height}px`
  el.style.overflowY = overflowY
}

function openForm(): void {
  showForm.value = true
  // Default-select every enabled agent (organizer included — selectable, not locked).
  selectedIds.value = new Set(enabledAgents.value.map((a) => a.id))
  localOrganizerId.value = props.defaultAgentId
}

function closeForm(): void {
  showForm.value = false
  formType.value = TYPES[0]?.id ?? ''
  formGoal.value = ''
  formContext.value = ''
  selectedIds.value = new Set()
  localOrganizerId.value = null
}

function submitForm(): void {
  const goal = formGoal.value.trim()
  const orgId = localOrganizerId.value
  if (!formType.value || !goal || !orgId) return
  // Fold the organizer into the participant set as a safety net.
  const ids = new Set(selectedIds.value)
  ids.add(orgId)
  emit('create', {
    type: formType.value,
    goal,
    context: formContext.value.trim(),
    participantAgentIds: [...ids],
    organizerAgentId: orgId,
  })
  closeForm()
}

// 标题前的 MM/DD 日期前缀:已完成项取 completedAt,否则取 updatedAt。
function datePrefix(d: Discussion): string {
  return formatDate(d.completedAt ?? d.updatedAt, locale.value, { style: 'short' })
}

// 该讨论类型的可读标签;未知类型回退到原始 id。
const TYPE_LABEL = new Map(TYPES.map((t) => [t.id, t.label]))
function typeLabel(d: Discussion): string {
  return TYPE_LABEL.get(d.type) ?? d.type
}

// 面板折叠态:本地 UI 状态。收缩态收窄面板并隐藏行内次要元信息。
const collapsed = ref(false)
const toggleLabel = computed(() => panelToggleLabel(collapsed.value))
const rowVis = computed(() => rowVisibility(collapsed.value))
function togglePanel(): void {
  collapsed.value = !collapsed.value
}
</script>

<template>
  <section class="disc-list" :class="{ collapsed }">
    <div class="disc-list-head">
      <div class="disc-list-head-left">
        <button
          type="button"
          class="disc-collapse-btn"
          :title="toggleLabel.title"
          :aria-pressed="collapsed"
          @click="togglePanel"
        >
          {{ toggleLabel.icon }}
        </button>
        <span class="disc-list-title">{{ t('discussion.list.title.label') }}</span>
      </div>
      <button
        type="button"
        class="disc-new-btn"
        :aria-label="t('discussion.list.new.label')"
        :title="t('discussion.list.new.label')"
        @click="showForm ? closeForm() : openForm()"
      >
        +
      </button>
    </div>
    <!-- Create modal: opened by the "+" (no longer an inline accordion). The overlay
         click-outside / Cancel closes it; submit emits `create` with the selected
         participants and resets. -->
    <div
      v-if="showForm"
      class="disc-modal-overlay"
      @click.self="closeForm"
      @keydown.esc="closeForm"
    >
      <form class="disc-modal" role="dialog" aria-modal="true" @submit.prevent="submitForm">
        <div class="disc-modal-head">
          <h3 class="disc-modal-title">{{ t('discussion.form.title.label') }}</h3>
          <button
            type="button"
            class="icon-btn"
            :aria-label="t('common.action.cancel.label')"
            @click="closeForm"
          >
            ✕
          </button>
        </div>
        <div class="disc-modal-body">
          <label class="disc-field">
            <span class="disc-field-label">{{ t('discussion.form.type.label') }}</span>
            <select v-model="formType" class="disc-input">
              <option v-for="ty in TYPES" :key="ty.id" :value="ty.id">{{ ty.label }}</option>
            </select>
          </label>
          <label class="disc-field">
            <span class="disc-field-label">{{ t('discussion.form.goal.label') }}</span>
            <textarea
              v-model="formGoal"
              class="disc-input disc-textarea"
              data-testid="disc-goal-textarea"
              rows="2"
              :placeholder="t('discussion.form.goal.placeholder')"
              @input="autoGrow"
            />
          </label>
          <label class="disc-field">
            <span class="disc-field-label">{{ t('discussion.form.context.label') }}</span>
            <textarea
              v-model="formContext"
              class="disc-input disc-textarea"
              data-testid="disc-context-textarea"
              rows="3"
              :placeholder="t('discussion.form.context.placeholder')"
              @input="autoGrow"
            />
          </label>
          <!-- Participant picker: lists enabled agents (default all selected). Each
               selected agent has a radio to designate the organizer. -->
          <fieldset class="disc-field disc-participants">
            <legend class="disc-field-label">{{ t('discussion.form.participants.label') }}</legend>
            <p class="disc-participants-hint">{{ t('discussion.form.participants.hint') }}</p>
            <label
              v-for="a in enabledAgents"
              :key="a.id"
              class="disc-participant"
              :data-testid="`disc-participant-${a.id}`"
            >
              <input type="checkbox" :checked="selectedIds.has(a.id)" @change="toggleAgent(a.id)" />
              <span class="disc-participant-name">{{ a.displayName }}</span>
              <input
                type="radio"
                name="discussion-organizer"
                :checked="localOrganizerId === a.id"
                :disabled="!selectedIds.has(a.id)"
                :data-testid="`disc-organizer-${a.id}`"
                class="disc-organizer-radio"
                @change="setOrganizer(a.id)"
              />
              <span v-if="localOrganizerId === a.id" class="disc-participant-badge">
                {{ t('discussion.form.participants.organizer.label') }}
              </span>
            </label>
            <p v-if="enabledAgents.length === 0" class="disc-participants-empty">
              {{ t('discussion.form.participants.empty') }}
            </p>
          </fieldset>
        </div>
        <div class="disc-form-actions">
          <button type="button" class="disc-btn" @click="closeForm">
            {{ t('common.action.cancel.label') }}
          </button>
          <p v-if="showForm && formGoal.trim() && !canSubmit" class="disc-form-error">
            {{ t('discussion.form.participants.validationError') }}
          </p>
          <button type="submit" class="disc-btn primary" :disabled="!canSubmit">
            {{ t('discussion.form.create.label') }}
          </button>
        </div>
      </form>
    </div>
    <div class="disc-items">
      <p v-if="discussions.length === 0" class="disc-empty">{{ t('discussion.list.empty') }}</p>
      <div
        v-for="d in discussions"
        :key="d.id"
        class="disc-item"
        :class="[d.status, { active: d.id === activeId }]"
      >
        <!-- Clicking the row is a pure select: it emits `open(id)` so the parent shows
             the discussion in the right pane's title bar + tabs (no inline accordion). -->
        <div
          class="disc-item-main"
          role="button"
          tabindex="0"
          :aria-label="t('discussion.item.openChat.label', { title: d.title })"
          @click="emit('open', d.id)"
          @keydown.enter.prevent="emit('open', d.id)"
          @keydown.space.prevent="emit('open', d.id)"
        >
          <div class="disc-item-head">
            <span class="disc-date">{{ datePrefix(d) }}</span>
            <span v-if="rowVis.showMeta && d.type" class="disc-type">{{ typeLabel(d) }}</span>
            <span class="disc-title" :title="d.goal || d.title">{{ d.title }}</span>
            <!-- Single unified status indicator `<icon> <agent>.<status>`: shows the live
                 run-state when there's an active run, else falls back to the persisted
                 lifecycle status (no agent segment then). Replaces the old dual
                 run-badge + status-pill. -->
            <span
              class="status-indicator disc-status-indicator"
              :class="rowStatuses.get(d.id)?.tone"
            >
              <span
                class="status-icon"
                :class="{ spin: rowStatuses.get(d.id)?.spin }"
                aria-hidden="true"
                >{{ rowStatuses.get(d.id)?.icon }}</span
              >
              <span class="status-text" data-i18n-key="">{{ rowStatuses.get(d.id)?.text }}</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.disc-list {
  width: 960px;
  flex-shrink: 0;
  background: var(--c-panel);
  border-right: 1px solid var(--c-border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: width 0.2s ease;
}
/* 收缩态:宽度减半,隐藏行内次要元信息(由组件 v-if 不渲染) */
.disc-list.collapsed {
  width: 480px;
}
/* 窄屏回退:侧栏按视口比例收窄,避免挤压聊天区(与 .req-list 一致) */
@media (max-width: 1024px) {
  .disc-list {
    width: min(960px, 68vw);
    min-width: 450px;
  }
  .disc-list.collapsed {
    width: min(480px, 34vw);
    min-width: 280px;
  }
}
/* 移动端:列表是 MobileStack 栈顶 pane,填满视口宽度(覆盖固定/收缩宽度) */
@media (max-width: 767px) {
  .disc-list,
  .disc-list.collapsed {
    width: 100%;
    min-width: 0;
    border-right: none;
  }
}
.disc-list-head {
  height: 36px;
  flex-shrink: 0;
  padding: 0 var(--sp-3);
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--c-border);
}
.disc-list-head-left {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}
.disc-list-title {
  font-size: var(--fs-title-sm);
  font-weight: 600;
}
/* 展开/收缩切换按钮:标题前,图标反映点击后将切换到的目标态 */
.disc-collapse-btn {
  flex-shrink: 0;
  background: var(--c-input);
  color: var(--c-text-muted);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  padding: 2px 8px;
  font-size: var(--fs-caption);
  cursor: pointer;
  white-space: nowrap;
}
.disc-collapse-btn:hover {
  background: var(--c-hover);
  color: var(--c-text);
}
.disc-new-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  font-size: var(--fs-title-sm);
  line-height: 1;
  color: var(--c-text-muted);
  background: transparent;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.disc-new-btn:hover {
  color: var(--c-text);
  border-color: var(--c-primary);
}
/* Create modal: centered overlay sheet (replaces the old inline accordion form). */
.disc-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-4);
  background: rgba(0, 0, 0, 0.5);
}
.disc-modal {
  width: 100%;
  max-width: 720px;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  background: var(--c-panel);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg, 0 8px 32px rgba(0, 0, 0, 0.3));
  overflow: hidden;
}
.disc-modal-head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-4);
  border-bottom: 1px solid var(--c-border);
}
.disc-modal-title {
  margin: 0;
  font-size: var(--fs-title-sm);
  font-weight: 600;
}
.disc-modal-body {
  flex: 1;
  overflow-y: auto;
  padding: var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
/* Mobile: full-screen sheet so the participant list + keyboard fit. */
@media (max-width: 767px) {
  .disc-modal-overlay {
    padding: 0;
  }
  .disc-modal {
    max-width: 100%;
    width: 100%;
    height: 100%;
    max-height: 100%;
    border-radius: 0;
    border: none;
  }
}
.disc-field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
/* Participant picker: bordered scrollable checkbox list. */
.disc-participants {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  padding: var(--sp-2);
  margin: 0;
}
.disc-participants-hint {
  margin: 0 0 var(--sp-1);
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
.disc-participants-empty {
  margin: var(--sp-1) 0 0;
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
.disc-participant {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) 0;
  cursor: pointer;
}
.disc-participant input[disabled] {
  cursor: not-allowed;
}
.disc-participant-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.disc-participant-badge {
  flex-shrink: 0;
  font-size: var(--fs-badge);
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  background: var(--c-hover);
  color: var(--c-text-muted);
  border: 1px solid var(--c-border);
}
/* Organizer radio: small, trailing the name; disabled when agent not selected. */
.disc-organizer-radio {
  flex-shrink: 0;
  margin: 0;
  cursor: pointer;
}
.disc-organizer-radio:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}
.disc-field-label {
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
.disc-input {
  width: 100%;
  box-sizing: border-box;
  padding: var(--sp-1) var(--sp-2);
  font: inherit;
  color: var(--c-text);
  background: var(--c-panel);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  resize: vertical;
}
.disc-input:focus {
  outline: none;
  border-color: var(--c-primary);
}
/* Auto-grow textareas: JS sizes height to content up to the cap (MAX_TEXTAREA_PX);
   max-height here is the CSS backstop matching that cap, and the user can't drag
   past it (resize disabled — height is content-driven). */
.disc-textarea {
  max-height: 200px;
  min-height: 120px;
  resize: none;
  overflow-y: hidden;
}
.disc-textarea[data-testid='disc-context-textarea'] {
  min-height: 100px;
}
.disc-form-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sp-2);
}
.disc-form-error {
  margin: 0;
  font-size: var(--fs-caption);
  color: var(--c-error, #d32f2f);
  flex: 1;
}
.disc-btn {
  padding: var(--sp-1) var(--sp-3);
  font: inherit;
  color: var(--c-text);
  background: transparent;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.disc-btn:hover {
  border-color: var(--c-primary);
}
.disc-btn.primary {
  color: #fff;
  background: var(--c-primary);
  border-color: var(--c-primary);
}
.disc-btn.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.disc-items {
  flex: 1;
  overflow-y: auto;
  padding: var(--sp-2);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.disc-empty {
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  padding: var(--sp-3);
}
.disc-item {
  background: var(--c-card);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  padding: var(--sp-2);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.disc-item:hover {
  border-color: var(--c-primary);
}
.disc-item.active {
  border-color: var(--c-primary);
  background: var(--c-primary-soft);
}
.disc-item.completed,
.disc-item.cancelled {
  opacity: 0.6;
}
/* 标题区 + 操作区同行;窄屏 wrap 时操作区换到下一行 */
.disc-item-main {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-2);
  cursor: pointer;
}
.disc-item-head {
  flex: 1 1 160px;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.disc-date {
  flex-shrink: 0;
  font-size: var(--fs-badge);
  color: var(--c-text-muted);
  font-variant-numeric: tabular-nums;
}
/* 类型 pill:灰底中性色,与 IntentList 的 .req-module 同款 */
.disc-type {
  flex-shrink: 0;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-badge);
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  background: var(--c-hover);
  color: var(--c-text-muted);
  border: 1px solid var(--c-border);
}
.disc-title {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-body);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Unified status indicator (`<icon> <agent>.<status>`): trailing row badge. Visuals
   (icon, tone color, spin) come from the shared global `.status-indicator`; here we
   only pin the row layout (no shrink, capped width, badge weight). */
.disc-status-indicator {
  flex-shrink: 0;
  max-width: 220px;
  font-size: var(--fs-badge);
  font-weight: 700;
}
</style>
