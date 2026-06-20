<script setup lang="ts">
/**
 * EventDetail.vue — 工作台右侧事件详情面板。
 *
 * 显示选中事件的完整详情:标题/来源/状态/创建时间/toolInput +
 * Allow/Deny/Answer + AskUserQuestion 逐题作答面板 + Jump to source 跳转。
 * 初始无选中事件时右栏显示空状态提示。
 *
 * 2026-06-08 从 EventList.vue 提取,作为 WorkCenter 两栏布局的右栏。
 */
import { ref, computed } from 'vue'
import { askQuestionsOf, type AskQuestionView } from '../../../lib/ask'
import { useTypedI18n, type LocaleKey } from '@/i18n'
import type { WaitUserInvolveEvent } from '@ccc/shared/protocol'

const { t } = useTypedI18n()

const props = defineProps<{
  event: WaitUserInvolveEvent | null
}>()

const emit = defineEmits<{
  respond: [event: WaitUserInvolveEvent, decision: 'allow' | 'deny']
  'submit-ask': [event: WaitUserInvolveEvent, answers: Record<string, string>]
  'jump-to-source': [event: WaitUserInvolveEvent]
}>()

// ---- Source type icon mapping ----

const SOURCE_ICONS: Record<string, string> = {
  session: '💬',
  intent: '🎯',
  discussion: '📢',
  schedule: '⏰',
}

function sourceIcon(source: string): string {
  return SOURCE_ICONS[source] ?? '❓'
}

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

const askOpen = ref(false)
const askQuestions = ref<AskQuestionView[]>([])
const askCurrentIndex = ref(0)
const askAnswers = ref<Record<string, string>>({})

const currentAskQuestion = computed(() => askQuestions.value[askCurrentIndex.value] ?? null)
const isLastAskQuestion = computed(() => askCurrentIndex.value >= askQuestions.value.length - 1)
const hasAskAnswer = computed(() => {
  const q = currentAskQuestion.value
  if (!q) return false
  const answer = askAnswers.value[String(q.index)]
  if (q.multiSelect) return (answer || '').length > 0
  return !!answer
})

function openAsk(event: WaitUserInvolveEvent) {
  if (askOpen.value) {
    closeAsk()
    return
  }
  const questions = askQuestionsOf(event.toolInput)
  if (questions.length === 0) return
  askOpen.value = true
  askQuestions.value = questions
  askCurrentIndex.value = 0
  askAnswers.value = {}
}

function closeAsk() {
  askOpen.value = false
  askQuestions.value = []
  askCurrentIndex.value = 0
  askAnswers.value = {}
}

function toggleAskOption(questionIndex: number, label: string) {
  const q = askQuestions.value[questionIndex]
  if (!q) return

  if (q.multiSelect) {
    const current = askAnswers.value[String(questionIndex)] || ''
    const parts = current ? current.split(',') : []
    const idx = parts.indexOf(label)
    if (idx >= 0) parts.splice(idx, 1)
    else parts.push(label)
    askAnswers.value[String(questionIndex)] = parts.join(',')
  } else {
    askAnswers.value[String(questionIndex)] =
      askAnswers.value[String(questionIndex)] === label ? '' : label
  }
}

function isOptionSelected(questionIndex: number, label: string): boolean {
  const answer = askAnswers.value[String(questionIndex)]
  if (!answer) return false
  if (askQuestions.value[questionIndex]?.multiSelect) {
    return answer.split(',').includes(label)
  }
  return answer === label
}

function nextAskQuestion() {
  if (askCurrentIndex.value < askQuestions.value.length - 1) {
    askCurrentIndex.value++
  }
}

function prevAskQuestion() {
  if (askCurrentIndex.value > 0) {
    askCurrentIndex.value--
  }
}

function submitAsk(event: WaitUserInvolveEvent) {
  emit('submit-ask', event, { ...askAnswers.value })
  closeAsk()
}

// Helper to format tool input for display
function formatToolInput(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

// Reset ask state when event changes
import { watch } from 'vue'
watch(
  () => props.event,
  () => {
    closeAsk()
  },
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
          <!-- Source icon -->
          <span class="wc-source-icon" :title="t(`workcenter.source.${event.source}` as LocaleKey)">
            {{ sourceIcon(event.source) }}
          </span>
          <!-- Title -->
          <h2 class="wc-detail-title">
            {{ event.title || event.toolName || sourceIcon(event.source) }}
          </h2>
        </div>
        <div class="wc-detail-meta">
          <span class="wc-detail-label">{{
            t(`workcenter.source.${event.source}` as LocaleKey)
          }}</span>
          <span class="wc-detail-sep">·</span>
          <span class="wc-detail-time">{{ formatTime(event.createdAt) }}</span>
        </div>
      </div>

      <!-- Event actions -->
      <div class="wc-detail-actions">
        <!-- Allow / Deny for todo events with a requestId -->
        <template v-if="event.status === 'todo' && event.requestId">
          <button class="wc-btn wc-btn-allow" @click="emit('respond', event, 'allow')">
            {{ t('common.action.allow.label') }}
          </button>
          <button class="wc-btn wc-btn-deny" @click="emit('respond', event, 'deny')">
            {{ t('common.action.deny.label') }}
          </button>
        </template>

        <!-- Answer button for AskUserQuestion -->
        <button
          v-if="event.status === 'todo' && event.toolName === 'AskUserQuestion'"
          class="wc-btn wc-btn-ask"
          @click="openAsk(event)"
        >
          {{ askOpen ? t('workcenter.ask.back') : t('workcenter.ask.answer') }}
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
      <div v-if="askOpen && currentAskQuestion" class="wc-ask-panel">
        <div class="wc-ask-progress">
          {{
            t('workcenter.ask.question', {
              current: askCurrentIndex + 1,
              total: askQuestions.length,
            })
          }}
        </div>

        <div class="wc-ask-question">{{ currentAskQuestion.question }}</div>
        <div class="wc-ask-options">
          <button
            v-for="opt in currentAskQuestion.options"
            :key="opt.label"
            class="wc-ask-option"
            :class="{ selected: isOptionSelected(currentAskQuestion.index, opt.label) }"
            @click="toggleAskOption(currentAskQuestion.index, opt.label)"
          >
            <span class="wc-ask-option-label">{{ opt.label }}</span>
            <span v-if="opt.description" class="wc-ask-option-desc">{{ opt.description }}</span>
          </button>
        </div>

        <div class="wc-ask-nav">
          <button v-if="askCurrentIndex > 0" class="wc-btn" @click="prevAskQuestion">
            {{ t('workcenter.ask.back') }}
          </button>
          <span v-else />

          <div class="wc-ask-nav-right">
            <button
              v-if="!isLastAskQuestion"
              class="wc-btn"
              :disabled="!hasAskAnswer"
              @click="nextAskQuestion"
            >
              {{ t('workcenter.ask.next') }}
            </button>
            <button
              v-else
              class="wc-btn wc-btn-allow"
              :disabled="!hasAskAnswer"
              @click="submitAsk(event)"
            >
              {{ t('workcenter.ask.submit') }}
            </button>
          </div>
        </div>
      </div>

      <!-- Consensus outcome (auto-resolved audit records) -->
      <div v-if="outcome" class="wc-detail-section wc-consensus">
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
.wc-ask-progress {
  font-size: 11px;
  color: var(--c-text-muted);
  margin-bottom: var(--sp-1);
}
.wc-ask-question {
  font-size: 13px;
  font-weight: 600;
  color: var(--c-text);
  margin-bottom: var(--sp-1);
}
.wc-ask-options {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  margin-bottom: var(--sp-1);
}
.wc-ask-option {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
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
.wc-ask-option-label {
  font-size: 13px;
  color: var(--c-text);
}
.wc-ask-option-desc {
  font-size: 11px;
  color: var(--c-text-muted);
}
.wc-ask-nav {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--sp-2);
}
.wc-ask-nav-right {
  display: flex;
  gap: var(--sp-1);
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

  .wc-ask-question {
    margin-bottom: var(--sp-2);
    overflow-wrap: anywhere;
  }

  .wc-ask-options {
    gap: var(--sp-2);
    margin-bottom: var(--sp-3);
  }

  .wc-ask-option {
    min-height: 44px;
    padding: var(--sp-2) var(--sp-3);
  }

  .wc-ask-option-label {
    font-size: 14px;
  }

  .wc-ask-nav {
    align-items: stretch;
  }

  .wc-ask-nav > span,
  .wc-ask-nav-right,
  .wc-ask-nav .wc-btn {
    flex: 1;
  }

  .wc-ask-nav-right {
    justify-content: flex-end;
  }
}
</style>
