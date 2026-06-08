<script setup lang="ts">
/**
 * EventList.vue — 工作台事件列表子组件。
 *
 * 按项目分组展示 WaitUserInvolveEvent,每条事件含状态徽标、标题、来源类型图标、
 * 创建时间,以及行内操作按钮(Allow/Deny、AskUserQuestion 逐题作答面板、跳转到源)。
 * 无外部依赖(askQuestionsOf 除外),纯展示+emit。
 */
import { ref, computed } from 'vue'
import { askQuestionsOf, type AskQuestionView } from '../../../lib/ask'
import { useTypedI18n, type LocaleKey } from '@/i18n'
import type { WaitUserInvolveEvent } from '@ccc/shared/protocol'

const { t } = useTypedI18n()

defineProps<{
  /** Events grouped by projectPath (key = projectPath). */
  groups: Record<string, WaitUserInvolveEvent[]>
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

// ---- AskUserQuestion inline state ----

const askOpenId = ref<string | null>(null)
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
  if (askOpenId.value === event.id) {
    closeAsk()
    return
  }
  const questions = askQuestionsOf(event.toolInput)
  if (questions.length === 0) return
  askOpenId.value = event.id
  askQuestions.value = questions
  askCurrentIndex.value = 0
  askAnswers.value = {}
}

function closeAsk() {
  askOpenId.value = null
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

// ---- Status CSS class ----

function statusClass(status: string): string {
  switch (status) {
    case 'todo':
      return 'wc-status-todo'
    case 'done':
      return 'wc-status-done'
    case 'canceled':
      return 'wc-status-canceled'
    default:
      return ''
  }
}
</script>

<template>
  <div class="wc-event-list-scroll">
    <div v-for="(events, projectPath) in groups" :key="projectPath" class="wc-project-group">
      <div class="wc-project-title">{{ projectPath }}</div>

      <div
        v-for="event in events"
        :key="event.id"
        class="wc-event-row"
        :class="{ 'wc-ask-open': askOpenId === event.id }"
      >
        <!-- Main event row (collapsed or expanded) -->
        <div class="wc-event-main">
          <!-- Status badge -->
          <span class="wc-status-badge" :class="statusClass(event.status)">
            {{ t(`workcenter.status.${event.status}` as LocaleKey) }}
          </span>

          <!-- Source icon -->
          <span class="wc-source-icon" :title="t(`workcenter.source.${event.source}` as LocaleKey)">
            {{ sourceIcon(event.source) }}
          </span>

          <!-- Title (or fallback) -->
          <span class="wc-event-title">{{
            event.title || event.toolName || sourceIcon(event.source)
          }}</span>

          <!-- Timestamp -->
          <span class="wc-event-time">{{ formatTime(event.createdAt) }}</span>

          <!-- Action buttons -->
          <span class="wc-event-actions">
            <!-- Allow / Deny for todo events with a requestId -->
            <template v-if="event.status === 'todo' && event.requestId">
              <button class="wc-btn wc-btn-allow" @click="emit('respond', event, 'allow')">
                {{ t('common.action.allow.label') }}
              </button>
              <button class="wc-btn wc-btn-deny" @click="emit('respond', event, 'deny')">
                {{ t('common.action.deny.label') }}
              </button>
            </template>

            <!-- AskUserQuestion: expand inline answer panel -->
            <button
              v-if="event.status === 'todo' && event.toolName === 'AskUserQuestion'"
              class="wc-btn wc-btn-ask"
              @click.stop="openAsk(event)"
            >
              {{ askOpenId === event.id ? t('workcenter.ask.back') : t('workcenter.ask.answer') }}
            </button>

            <!-- Jump to source -->
            <button
              class="wc-btn wc-btn-jump"
              :title="t('workcenter.action.jump')"
              @click="emit('jump-to-source', event)"
            >
              {{ t('workcenter.action.jump') }}
            </button>
          </span>
        </div>

        <!-- AskUserQuestion inline panel (expanded) -->
        <div v-if="askOpenId === event.id && currentAskQuestion" class="wc-ask-panel">
          <div class="wc-ask-progress">
            {{
              t('workcenter.ask.question', {
                current: askCurrentIndex + 1,
                total: askQuestions.length,
              })
            }}
          </div>

          <!-- Current question -->
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

          <!-- Navigation -->
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
      </div>

      <!-- Empty state for a project group that has no events after filtering -->
      <div v-if="events.length === 0" class="wc-empty">
        {{ t('workcenter.empty') }}
      </div>
    </div>

    <!-- Global empty state -->
    <div v-if="Object.keys(groups).length === 0" class="wc-empty">
      {{ t('workcenter.empty') }}
    </div>
  </div>
</template>

<style scoped>
.wc-event-list-scroll {
  flex: 1;
  overflow-y: auto;
  padding: var(--sp-2) var(--sp-3);
}

/* Project group */
.wc-project-group {
  margin-bottom: var(--sp-3);
}
.wc-project-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--c-text);
  padding: var(--sp-1) 0;
  border-bottom: 1px solid var(--c-border);
  margin-bottom: var(--sp-1);
}

/* Event row */
.wc-event-row {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  margin-bottom: var(--sp-1);
  background: var(--c-bg);
  transition: background-color var(--dur-fast) var(--ease-standard);
}
.wc-event-row:hover {
  background: var(--c-card);
}
.wc-event-main {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-2);
  min-height: 36px;
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

/* Source icon */
.wc-source-icon {
  flex-shrink: 0;
  font-size: 16px;
  cursor: default;
}

/* Title */
.wc-event-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--c-text);
}

/* Timestamp */
.wc-event-time {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--c-text-muted);
  white-space: nowrap;
}

/* Action buttons */
.wc-event-actions {
  display: flex;
  gap: var(--sp-1);
  flex-shrink: 0;
}
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

/* AskUserQuestion inline panel */
.wc-ask-panel {
  border-top: 1px solid var(--c-border);
  padding: var(--sp-2);
  background: var(--c-card);
  border-radius: 0 0 var(--radius-sm) var(--radius-sm);
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

/* Ask navigation */
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

/* Empty state */
.wc-empty {
  text-align: center;
  padding: var(--sp-4);
  color: var(--c-text-muted);
  font-size: 13px;
}
</style>
