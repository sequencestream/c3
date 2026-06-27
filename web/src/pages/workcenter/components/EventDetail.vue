<script setup lang="ts">
/**
 * EventDetail.vue — 工作台右侧事件详情面板。
 *
 * 显示选中事件的完整详情:标题/来源/状态/创建时间/toolInput +
 * Allow/Deny/Answer + AskUserQuestion 全题作答面板 + Jump to source 跳转。
 * 初始无选中事件时右栏显示空状态提示。
 *
 * 2026-06-08 从 EventList.vue 提取,作为 WorkCenter 两栏布局的右栏。
 */
import { ref, computed, watch } from 'vue'
import {
  agentsForCustom,
  agentsForOption,
  askQuestionsOf,
  initAskDraft,
  isAskConsensus,
  type AskDraftSlot,
  type AskQuestionView,
} from '../../../lib/ask'
import { useTypedI18n, type LocaleKey } from '@/i18n'
import type { WaitUserInvolveEvent, WorkspaceInfo } from '@ccc/shared/protocol'
import { eventDisplayTitle } from '@/lib/event-title'

const { t } = useTypedI18n()

const ASK_TOOL_LABEL = 'AskUserQuestion'

const props = defineProps<{
  event: WaitUserInvolveEvent | null
  /** Registry of known workspaces, to resolve an event's opaque `workspaceId` → name. */
  workspaces: WorkspaceInfo[]
}>()

const emit = defineEmits<{
  respond: [event: WaitUserInvolveEvent, decision: 'allow' | 'deny']
  'submit-ask': [event: WaitUserInvolveEvent, answers: Record<string, string>]
  'jump-to-source': [event: WaitUserInvolveEvent]
}>()

// ---- Session-kind icon mapping ----

const SESSION_KIND_ICONS: Record<string, string> = {
  work: '💬',
  intent: '🎯',
  discussion: '📢',
  schedule: '⏰',
  spec: '📝',
  consensus: '⚙️',
  tool: '🔧',
}

function sessionKindIcon(sessionKind: string): string {
  return SESSION_KIND_ICONS[sessionKind] ?? '❓'
}

// ---- Attribute-list derivations ----

/** The event's session-kind label, localized (falls back to the raw key for unknown kinds). */
function sessionKindLabel(sessionKind: string): string {
  return t(`workcenter.sessionKind.${sessionKind}` as LocaleKey)
}

/** Resolve the event's opaque workspace id → its display name, or a placeholder when unknown. */
const workspaceName = computed<string>(() => {
  const id = props.event?.workspaceId
  const hit = id ? props.workspaces.find((w) => w.id === id) : undefined
  return hit?.name ?? t('workcenter.attribute.workspaceUnknown')
})

// ---- Time formatting ----

function formatTime(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  const minutes = Math.floor(diff / 60000)

  if (minutes < 1) return t('workcenter.time.justNow')
  if (minutes < 60) return t('workcenter.time.minutesAgo', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('workcenter.time.hoursAgo', { n: hours })
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// ---- Status CSS class ----

function statusClass(status: string): string {
  switch (status) {
    case 'todo':
      return 'wc-status-todo'
    case 'done':
      return 'wc-status-done'
    case 'canceled':
      return 'wc-status-canceled'
    case 'auto':
      return 'wc-status-auto'
    default:
      return ''
  }
}

// ---- Consensus outcome (auto-resolved records) ----

/** The auto-decision's deciding consensus, present only on `status: 'auto'` records. */
const outcome = computed(() => props.event?.outcome ?? null)

/** A one-line label for how the consensus decided (allow / deny / answered on your behalf). */
const autoDecisionLabel = computed<string>(() => {
  const o = outcome.value
  if (!o) return ''
  if (o.kind === 'ask') return t('workcenter.consensus.answered')
  return o.decision === 'deny'
    ? t('workcenter.consensus.denied')
    : t('workcenter.consensus.allowed')
})

// ---- AskUserQuestion inline state ----

const askPanelExpanded = ref(true)
const askDraft = ref<Record<number, AskDraftSlot>>({})

const askConsensus = computed(() => {
  const o = props.event?.outcome ?? undefined
  return isAskConsensus(o) ? o : undefined
})

const askQuestions = computed<AskQuestionView[]>(() =>
  props.event?.toolName === 'AskUserQuestion' ? askQuestionsOf(props.event.toolInput) : [],
)

function initCurrentAskDraft() {
  askPanelExpanded.value = true
  askDraft.value =
    props.event?.toolName === 'AskUserQuestion'
      ? initAskDraft(props.event.toolInput, askConsensus.value)
      : {}
}

function isAskActionable(event: WaitUserInvolveEvent): boolean {
  return event.status === 'todo' && event.toolName === 'AskUserQuestion'
}

function isOptionSelected(questionIndex: number, label: string): boolean {
  return askDraft.value[questionIndex]?.labels.includes(label) ?? false
}

function toggleAskOption(q: AskQuestionView, label: string) {
  if (!props.event || !isAskActionable(props.event)) return
  const slot = askDraft.value[q.index]
  if (!slot) return
  if (q.multiSelect) {
    const i = slot.labels.indexOf(label)
    if (i >= 0) slot.labels.splice(i, 1)
    else slot.labels.push(label)
  } else {
    slot.labels = slot.labels[0] === label ? [] : [label]
    slot.customActive = false
  }
}

function isCustomSelected(questionIndex: number): boolean {
  return askDraft.value[questionIndex]?.customActive ?? false
}

function toggleAskCustomOption(q: AskQuestionView) {
  if (!props.event || !isAskActionable(props.event)) return
  const slot = askDraft.value[q.index]
  if (!slot) return
  slot.customActive = !slot.customActive
  if (slot.customActive && !q.multiSelect) slot.labels = []
}

function askCustomOf(questionIndex: number): string {
  return askDraft.value[questionIndex]?.custom ?? ''
}

function setAskCustom(questionIndex: number, value: string) {
  const slot = askDraft.value[questionIndex]
  if (!slot) return
  slot.custom = value
}

function isAskAnswered(): boolean {
  if (askQuestions.value.length === 0) return false
  return askQuestions.value.every((q) => {
    const slot = askDraft.value[q.index]
    if (!slot) return false
    return slot.labels.length > 0 || (slot.customActive && slot.custom.trim().length > 0)
  })
}

function submitAsk(event: WaitUserInvolveEvent) {
  if (!isAskActionable(event) || !isAskAnswered()) return
  const answers: Record<string, string> = {}
  for (const q of askQuestions.value) {
    const slot = askDraft.value[q.index]
    const parts = [...slot.labels]
    if (slot.customActive && slot.custom.trim()) parts.push(slot.custom.trim())
    answers[q.question] = parts.join(', ')
  }
  emit('submit-ask', event, answers)
}

// Helper to format tool input for display
function formatToolInput(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

watch(
  () => props.event,
  () => initCurrentAskDraft(),
  { immediate: true },
)
</script>

<template>
  <div class="wc-detail">
    <!-- Empty state -->
    <div v-if="!event" class="wc-detail-empty">
      <div class="wc-detail-empty-icon">📋</div>
      <div class="wc-detail-empty-text">{{ t('workcenter.empty') }}</div>
    </div>

    <!-- Event detail -->
    <template v-else>
      <div class="wc-detail-header">
        <div class="wc-detail-title-row">
          <!-- Status badge -->
          <span class="wc-status-badge" :class="statusClass(event.status)">
            {{ t(`workcenter.status.${event.status}` as LocaleKey) }}
          </span>
          <!-- Session-kind icon -->
          <span class="wc-source-icon" :title="sessionKindLabel(event.sessionKind)">
            {{ sessionKindIcon(event.sessionKind) }}
          </span>
          <!-- Title -->
          <h2 class="wc-detail-title">
            {{ eventDisplayTitle(event, sessionKindIcon(event.sessionKind)) }}
          </h2>
        </div>
        <div class="wc-detail-meta">
          <span class="wc-detail-time">{{ formatTime(event.createdAt) }}</span>
        </div>

        <!-- Attribute list: workspace / session kind / session id / intent -->
        <dl class="wc-attr-list">
          <div class="wc-attr-row">
            <dt class="wc-attr-key">{{ t('workcenter.attribute.workspace') }}</dt>
            <dd class="wc-attr-val">{{ workspaceName }}</dd>
          </div>
          <div class="wc-attr-row">
            <dt class="wc-attr-key">{{ t('workcenter.attribute.sessionKind') }}</dt>
            <dd class="wc-attr-val">{{ sessionKindLabel(event.sessionKind) }}</dd>
          </div>
          <div v-if="event.sessionId" class="wc-attr-row">
            <dt class="wc-attr-key">{{ t('workcenter.attribute.sessionId') }}</dt>
            <dd class="wc-attr-val wc-attr-mono">{{ event.sessionId }}</dd>
          </div>
          <div v-if="event.intentTitle" class="wc-attr-row">
            <dt class="wc-attr-key">{{ t('workcenter.attribute.intent') }}</dt>
            <dd class="wc-attr-val">{{ event.intentTitle }}</dd>
          </div>
        </dl>
      </div>

      <!-- Event actions -->
      <div class="wc-detail-actions">
        <!-- Allow / Deny for todo events with a requestId -->
        <template
          v-if="event.status === 'todo' && event.requestId && event.toolName !== 'AskUserQuestion'"
        >
          <button class="wc-btn wc-btn-allow" @click="emit('respond', event, 'allow')">
            {{ t('common.action.allow.label') }}
          </button>
          <button class="wc-btn wc-btn-deny" @click="emit('respond', event, 'deny')">
            {{ t('common.action.deny.label') }}
          </button>
        </template>

        <!-- Answer button for AskUserQuestion -->
        <button
          v-if="isAskActionable(event)"
          class="wc-btn wc-btn-ask"
          @click="askPanelExpanded = !askPanelExpanded"
        >
          {{ askPanelExpanded ? t('workcenter.ask.collapse') : t('workcenter.ask.answer') }}
        </button>

        <!-- Jump to source -->
        <button
          class="wc-btn wc-btn-jump"
          :title="t('workcenter.action.jump')"
          @click="emit('jump-to-source', event)"
        >
          {{ t('workcenter.action.jump') }}
        </button>
      </div>

      <!-- AskUserQuestion panel -->
      <div v-if="isAskActionable(event) && askPanelExpanded" class="wc-ask-panel">
        <div class="wc-ask-label">
          {{ t('permission.ask.answerQuestion.label') }} <code>{{ ASK_TOOL_LABEL }}</code>
          <span v-if="askConsensus" class="wc-ask-consensus-badge">
            {{ t('permission.ask.multiAgentSuggestion.label') }}
          </span>
        </div>
        <div v-if="askConsensus" class="wc-ask-summary">🤝 {{ askConsensus.summary }}</div>
        <div class="wc-ask-questions">
          <div v-for="q in askQuestions" :key="q.index" class="wc-ask-q">
            <div class="wc-ask-question">
              <span v-if="q.header" class="wc-ask-question-header">{{ q.header }}</span>
              {{ q.question }}
            </div>
            <div class="wc-ask-options">
              <label
                v-for="opt in q.options"
                :key="opt.label"
                class="wc-ask-option"
                :class="{ selected: isOptionSelected(q.index, opt.label) }"
              >
                <input
                  :type="q.multiSelect ? 'checkbox' : 'radio'"
                  :name="`wc-ask-${event.id}-${q.index}`"
                  :checked="isOptionSelected(q.index, opt.label)"
                  @change="toggleAskOption(q, opt.label)"
                />
                <span class="wc-ask-option-body">
                  <span class="wc-ask-option-label">{{ opt.label }}</span>
                  <span v-if="opt.description" class="wc-ask-option-desc">{{
                    opt.description
                  }}</span>
                </span>
                <span class="wc-ask-agents">
                  <span
                    v-for="agent in agentsForOption(askConsensus, q.index, opt.label)"
                    :key="agent.agentName"
                    class="wc-ask-agent-badge"
                    :title="agent.reason"
                    >{{ agent.agentName }}</span
                  >
                </span>
              </label>
              <label
                class="wc-ask-option wc-ask-option-custom"
                :class="{ selected: isCustomSelected(q.index) }"
              >
                <input
                  :type="q.multiSelect ? 'checkbox' : 'radio'"
                  :name="`wc-ask-${event.id}-${q.index}`"
                  :checked="isCustomSelected(q.index)"
                  @change="toggleAskCustomOption(q)"
                />
                <span class="wc-ask-option-body">
                  <span class="wc-ask-option-label">{{
                    t('permission.ask.customReply.label')
                  }}</span>
                  <span class="wc-ask-option-desc">{{ t('permission.ask.customReply.hint') }}</span>
                </span>
                <span class="wc-ask-agents">
                  <span
                    v-for="agent in agentsForCustom(askConsensus, q.index)"
                    :key="agent.agentName"
                    class="wc-ask-agent-badge"
                    :title="`${agent.custom} (${agent.reason})`"
                    >{{ agent.agentName }}</span
                  >
                </span>
              </label>
            </div>
            <div
              v-for="agent in agentsForCustom(askConsensus, q.index)"
              :key="agent.agentName"
              class="wc-ask-custom-hint"
              :title="agent.reason"
            >
              {{ agent.agentName }}: {{ agent.custom }}
            </div>
            <input
              v-if="isCustomSelected(q.index)"
              class="wc-ask-custom-input"
              type="text"
              :placeholder="t('permission.ask.custom.placeholder')"
              :value="askCustomOf(q.index)"
              @input="setAskCustom(q.index, ($event.target as HTMLInputElement).value)"
            />
          </div>
        </div>
        <div class="wc-ask-actions">
          <button class="wc-btn wc-btn-deny" @click="emit('respond', event, 'deny')">
            {{ t('common.action.deny.label') }}
          </button>
          <button
            class="wc-btn wc-btn-allow"
            :disabled="!isAskAnswered()"
            @click="submitAsk(event)"
          >
            {{ t('permission.ask.submit.label') }}
          </button>
        </div>
      </div>
      <div
        v-else-if="event.toolName === 'AskUserQuestion' && event.status !== 'auto'"
        class="wc-ask-readonly"
      >
        {{
          event.status === 'canceled' ? t('workcenter.ask.canceled') : t('workcenter.ask.answered')
        }}
      </div>

      <!-- Consensus outcome (auto-resolved audit records) -->
      <div v-if="event.status === 'auto' && outcome" class="wc-detail-section wc-consensus">
        <h3 class="wc-detail-section-title">{{ t('workcenter.consensus.title') }}</h3>
        <p class="wc-consensus-lead">{{ t('workcenter.consensus.lead') }}</p>
        <div class="wc-consensus-meta">
          <span class="wc-consensus-decision">{{ autoDecisionLabel }}</span>
          <span v-if="outcome.kind === 'tool'" class="wc-consensus-tag">
            {{
              outcome.unanimous
                ? t('workcenter.consensus.unanimous')
                : t('workcenter.consensus.majority')
            }}
          </span>
          <span v-if="outcome.vendorScope" class="wc-consensus-tag">
            {{ t('workcenter.consensus.vendorScope', { vendor: outcome.vendorScope }) }}
          </span>
        </div>
        <p v-if="outcome.summary" class="wc-consensus-summary">{{ outcome.summary }}</p>

        <!-- Tool consensus: per-voter allow/deny -->
        <ul v-if="outcome.kind === 'tool'" class="wc-vote-list">
          <li v-for="vote in outcome.votes" :key="vote.agentId" class="wc-vote">
            <span class="wc-vote-verdict" :class="`wc-vote-${vote.decision}`">{{
              t(`workcenter.consensus.verdict.${vote.decision}` as LocaleKey)
            }}</span>
            <span class="wc-vote-agent">{{ vote.agentName }}</span>
            <span class="wc-vote-reason">{{ vote.reason }}</span>
          </li>
        </ul>

        <!-- Ask consensus: agreed answer per question -->
        <ul v-else class="wc-vote-list">
          <li v-for="q in outcome.perQuestion" :key="q.index" class="wc-vote">
            <span class="wc-vote-agent">{{ q.header || q.question }}</span>
            <span class="wc-vote-reason">{{
              q.agreed ?? t('workcenter.consensus.noAgreement')
            }}</span>
          </li>
        </ul>
      </div>

      <!-- Tool input section -->
      <div class="wc-detail-section">
        <h3 class="wc-detail-section-title">{{ t('workcenter.toolInput') }}</h3>
        <pre class="wc-tool-input">{{ formatToolInput(event.toolInput) }}</pre>
      </div>
    </template>
  </div>
</template>

<style scoped>
.wc-detail {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
}

/* Empty state */
.wc-detail-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--c-text-muted);
  gap: var(--sp-2);
}
.wc-detail-empty-icon {
  font-size: 40px;
  opacity: 0.5;
}
.wc-detail-empty-text {
  font-size: 14px;
}

/* Header */
.wc-detail-header {
  padding: var(--sp-3);
  border-bottom: 1px solid var(--c-border);
}
.wc-detail-title-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-1);
}
.wc-detail-title {
  flex: 1;
  min-width: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--c-text);
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wc-detail-meta {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  font-size: 12px;
  color: var(--c-text-muted);
}
.wc-detail-sep {
  opacity: 0.4;
}

/* Attribute list (workspace / session kind / session id / intent) */
.wc-attr-list {
  margin: var(--sp-2) 0 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.wc-attr-row {
  display: flex;
  gap: var(--sp-2);
  font-size: 12px;
  line-height: 1.5;
}
.wc-attr-key {
  flex: 0 0 88px;
  color: var(--c-text-muted);
  margin: 0;
}
.wc-attr-val {
  flex: 1;
  min-width: 0;
  color: var(--c-text);
  margin: 0;
  overflow-wrap: anywhere;
}
.wc-attr-mono {
  font-family: var(--font-mono, 'SF Mono', 'Fira Code', monospace);
}

/* Actions */
.wc-detail-actions {
  display: flex;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--c-border);
  flex-wrap: wrap;
}

/* Tool input section */
.wc-detail-section {
  padding: var(--sp-3);
}
.wc-detail-section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--c-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin: 0 0 var(--sp-2);
}
.wc-tool-input {
  font-family: var(--font-mono, 'SF Mono', 'Fira Code', monospace);
  font-size: 12px;
  line-height: 1.5;
  color: var(--c-text);
  background: var(--c-card);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  padding: var(--sp-2);
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

/* Status badge */
.wc-status-badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.5;
  white-space: nowrap;
  flex-shrink: 0;
}
.wc-status-todo {
  background: #fef3c7;
  color: #92400e;
}
.wc-status-done {
  background: #d1fae5;
  color: #065f46;
}
.wc-status-canceled {
  background: #e5e7eb;
  color: #374151;
}
.wc-status-auto {
  background: #e0e7ff;
  color: #3730a3;
}

/* Consensus outcome (auto records) */
.wc-consensus-lead {
  font-size: 12px;
  color: var(--c-text-muted);
  margin: 0 0 var(--sp-2);
}
.wc-consensus-meta {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  flex-wrap: wrap;
  margin-bottom: var(--sp-1);
}
.wc-consensus-decision {
  font-size: 13px;
  font-weight: 600;
  color: var(--c-text);
}
.wc-consensus-tag {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  background: var(--c-card);
  border: 1px solid var(--c-border);
  color: var(--c-text-muted);
}
.wc-consensus-summary {
  font-size: 12px;
  color: var(--c-text);
  margin: 0 0 var(--sp-2);
}
.wc-vote-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.wc-vote {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  font-size: 12px;
}
.wc-vote-verdict {
  flex-shrink: 0;
  font-weight: 600;
}
.wc-vote-allow {
  color: #065f46;
}
.wc-vote-deny {
  color: #991b1b;
}
.wc-vote-abstain {
  color: var(--c-text-muted);
}
.wc-vote-agent {
  flex-shrink: 0;
  font-weight: 600;
  color: var(--c-text);
}
.wc-vote-reason {
  color: var(--c-text-muted);
  min-width: 0;
  overflow-wrap: anywhere;
}

/* Source icon */
.wc-source-icon {
  flex-shrink: 0;
  font-size: 16px;
  cursor: default;
}

/* Buttons */
.wc-btn {
  background: transparent;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  padding: 2px 10px;
  font-size: 12px;
  color: var(--c-text);
  cursor: pointer;
  transition:
    color var(--dur-fast) var(--ease-standard),
    background-color var(--dur-fast) var(--ease-standard);
}
.wc-btn:hover {
  background: var(--c-card);
}
.wc-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.wc-btn-allow {
  color: #065f46;
  border-color: #065f46;
}
.wc-btn-allow:hover {
  background: #d1fae5;
}
.wc-btn-deny {
  color: #991b1b;
  border-color: #991b1b;
}
.wc-btn-deny:hover {
  background: #fee2e2;
}
.wc-btn-jump {
  color: var(--c-text-muted);
  font-size: 11px;
}

/* AskUserQuestion panel */
.wc-ask-panel {
  border-bottom: 1px solid var(--c-border);
  padding: var(--sp-3);
  background: var(--c-card);
}
.wc-ask-label {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  flex-wrap: wrap;
  font-size: 12px;
  font-weight: 600;
  color: var(--c-text);
  margin-bottom: var(--sp-2);
}
.wc-ask-label code {
  font-family: var(--font-mono, 'SF Mono', 'Fira Code', monospace);
  font-size: 11px;
}
.wc-ask-consensus-badge {
  font-size: 11px;
  font-weight: 600;
  color: #3730a3;
  background: #e0e7ff;
  border: 1px solid #c7d2fe;
  border-radius: var(--radius-sm);
  padding: 1px 6px;
}
.wc-ask-summary {
  font-size: 12px;
  color: var(--c-text);
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  padding: var(--sp-1) var(--sp-2);
  margin-bottom: var(--sp-2);
}
.wc-ask-questions {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.wc-ask-q {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.wc-ask-question {
  font-size: 13px;
  font-weight: 600;
  color: var(--c-text);
  overflow-wrap: anywhere;
}
.wc-ask-question-header {
  display: block;
  font-size: 12px;
  color: var(--c-text-muted);
  font-weight: 600;
  margin-bottom: 2px;
}
.wc-ask-options {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.wc-ask-option {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-2);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  background: var(--c-bg);
  cursor: pointer;
  text-align: left;
  transition:
    border-color var(--dur-fast) var(--ease-standard),
    background-color var(--dur-fast) var(--ease-standard);
}
.wc-ask-option:hover {
  border-color: var(--c-primary, #3b82f6);
}
.wc-ask-option.selected {
  border-color: var(--c-primary, #3b82f6);
  background: #eff6ff;
}
.wc-ask-option input {
  margin-top: 3px;
  flex-shrink: 0;
}
.wc-ask-option-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.wc-ask-option-label {
  font-size: 13px;
  color: var(--c-text);
  overflow-wrap: anywhere;
}
.wc-ask-option-desc {
  font-size: 11px;
  color: var(--c-text-muted);
  overflow-wrap: anywhere;
}
.wc-ask-agents {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.wc-ask-agent-badge {
  font-size: 10px;
  font-weight: 600;
  line-height: 1.4;
  color: #065f46;
  background: #d1fae5;
  border: 1px solid #a7f3d0;
  border-radius: var(--radius-sm);
  padding: 1px 5px;
}
.wc-ask-custom-hint {
  font-size: 11px;
  color: var(--c-text-muted);
  overflow-wrap: anywhere;
}
.wc-ask-custom-input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  background: var(--c-bg);
  color: var(--c-text);
  font-size: 13px;
  padding: var(--sp-1) var(--sp-2);
}
.wc-ask-actions {
  display: flex;
  gap: var(--sp-1);
  justify-content: flex-end;
  margin-top: var(--sp-3);
}
.wc-ask-readonly {
  border-bottom: 1px solid var(--c-border);
  padding: var(--sp-2) var(--sp-3);
  font-size: 12px;
  color: var(--c-text-muted);
  background: var(--c-card);
}

@media (max-width: 767px) {
  .wc-detail {
    height: auto;
    min-height: 320px;
    overflow: visible;
  }

  .wc-detail-empty {
    min-height: 240px;
  }

  .wc-detail-title-row {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .wc-detail-title {
    flex-basis: 100%;
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .wc-detail-actions {
    gap: var(--sp-2);
    padding: var(--sp-3);
  }

  .wc-btn {
    min-height: 44px;
    padding: 0 var(--sp-3);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1.2;
  }

  .wc-detail-actions .wc-btn {
    flex: 1 1 112px;
  }

  .wc-btn-jump {
    font-size: 12px;
  }

  .wc-ask-panel {
    padding: var(--sp-3);
  }

  .wc-ask-options {
    gap: var(--sp-2);
  }

  .wc-ask-option {
    min-height: 44px;
    padding: var(--sp-2) var(--sp-3);
  }

  .wc-ask-option-label {
    font-size: 14px;
  }

  .wc-ask-agents {
    width: 100%;
    justify-content: flex-start;
  }

  .wc-ask-actions {
    align-items: stretch;
  }

  .wc-ask-actions .wc-btn {
    flex: 1;
  }
}
</style>
