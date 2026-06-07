<script setup lang="ts">
/*
 * PermissionPrompt.vue — 单条权限提示块
 *
 * 渲染两种形态：AskUserQuestion 的逐题作答面板，以及其它工具的 allow/deny 提示。
 * 两者都可附带多 agent 共识（分歧）意见。组件不持有 WebSocket，决策通过事件上抛，
 * 由 App 统一发送并回写 m.decision。
 */
import { computed, ref } from 'vue'
import {
  askQuestionsOf,
  agentsForOption,
  agentsForCustom,
  initAskDraft,
  type AskQuestionView,
  type AskDraftSlot,
} from '../../lib/ask'
import { fmt, oneLine } from '../../lib/format'
import { VENDOR_LABEL } from '../../lib/vendor'
import { useTypedI18n } from '@/i18n'
import type { PermissionMsg } from '../../lib/chat-types'
import type { ProposedIntent } from '@ccc/shared/protocol'

const { t } = useTypedI18n()

// Fixed tool identifiers shown verbatim in <code> tags (do-not-translate; bound
// via a const so `no-raw-text` doesn't flag them as hard-coded copy).
const ASK_TOOL_LABEL = 'AskUserQuestion'
const SAVE_TOOL_LABEL = 'save_intents'

// `actionable` is true only for the live, still-pending permission the user can
// answer. When false and undecided, this prompt is a history record replayed
// from the buffer (or a superseded earlier request) and renders as a single
// static line — no buttons, no decision verdict.
const props = defineProps<{ m: PermissionMsg; actionable: boolean }>()

/** The c3 save_intents tool's name (mirrors SAVE_INTENTS_TOOL server-side). */
const SAVE_INTENTS_TOOL = 'mcp__c3__save_intents'

/** The proposed intents carried by a save_intents permission request. */
const proposedIntents = computed<ProposedIntent[]>(() => {
  const reqs = (props.m.input as { intents?: unknown })?.intents
  return Array.isArray(reqs) ? (reqs as ProposedIntent[]) : []
})

/**
 * Human-readable labels for an item's intra-batch dependencies (`dependsOnIndexes`),
 * resolving each 0-based index to the sibling's `#N「title」` in this same batch so the
 * user sees the order relationship before allowing the save. Out-of-range indexes (the
 * server rejects them) fall back to a bare `#N`.
 */
function batchDepLabels(r: ProposedIntent): string[] {
  const reqs = proposedIntents.value
  return (r.dependsOnIndexes ?? []).map((j) => {
    const sib = reqs[j]
    return sib ? `#${j + 1}「${sib.title}」` : `#${j + 1}`
  })
}

/**
 * Undecided but not actionable ⇒ a historical request (buffer replay) the user
 * can no longer act on. Render it as one static line instead of a live card.
 */
const isStatic = computed(() => props.m.decision === null && !props.actionable)

/** The one-line label for a static history record, per tool type. */
const historyLine = computed<string>(() => {
  if (props.m.toolName === 'AskUserQuestion') {
    // 复数 key:传 number 形参触发分支选择,消息内 {count} 自动暴露。
    return t('permission.history.askQuestion', askQuestionsOf(props.m.input).length)
  }
  if (props.m.toolName === SAVE_INTENTS_TOOL) {
    return t('permission.history.saveIntents', proposedIntents.value.length)
  }
  return t('permission.history.useTool', { toolName: props.m.toolName })
})

const emit = defineEmits<{
  respond: [m: PermissionMsg, decision: 'allow' | 'deny']
  'submit-ask': [m: PermissionMsg, answers: Record<string, string>]
}>()

// Local toggle for the non-ask tool-input preview (pre vs one-line).
const expandedInput = ref(false)

// Per-question answer draft (q index → choice), seeded from the agents' consensus
// where they agreed. Local state: this is the user's working copy, not the message.
const draft = ref<Record<number, AskDraftSlot>>(initAskDraft(props.m.input, props.m.consensus))

function respond(decision: 'allow' | 'deny') {
  if (props.m.decision) return
  emit('respond', props.m, decision)
}

function isOptionChosen(qIndex: number, label: string): boolean {
  return draft.value[qIndex]?.labels.includes(label) ?? false
}

function toggleAskOption(q: AskQuestionView, label: string) {
  if (props.m.decision) return
  const slot = draft.value[q.index]
  if (!slot) return
  if (q.multiSelect) {
    const i = slot.labels.indexOf(label)
    if (i >= 0) slot.labels.splice(i, 1)
    else slot.labels.push(label)
  } else {
    slot.labels = slot.labels[0] === label ? [] : [label]
    // Single-select: a normal option and the custom reply are mutually exclusive.
    slot.customActive = false
  }
}

function isCustomChosen(qIndex: number): boolean {
  return draft.value[qIndex]?.customActive ?? false
}

/** Toggle the synthetic "custom reply" option that lives at the end of each option list. */
function toggleAskCustomOption(q: AskQuestionView) {
  if (props.m.decision) return
  const slot = draft.value[q.index]
  if (!slot) return
  slot.customActive = !slot.customActive
  // Single-select: picking the custom reply clears any chosen option.
  if (slot.customActive && !q.multiSelect) slot.labels = []
}

function askCustomOf(qIndex: number): string {
  return draft.value[qIndex]?.custom ?? ''
}

function setAskCustom(qIndex: number, value: string) {
  if (draft.value[qIndex]) draft.value[qIndex].custom = value
}

/** Every question must have at least one option chosen, or an active non-empty custom reply. */
function isAskAnswered(): boolean {
  const qs = askQuestionsOf(props.m.input)
  if (qs.length === 0) return false
  return qs.every((q) => {
    const slot = draft.value[q.index]
    if (!slot) return false
    return slot.labels.length > 0 || (slot.customActive && slot.custom.trim().length > 0)
  })
}

function submitAsk() {
  if (props.m.decision || !isAskAnswered()) return
  const answers: Record<string, string> = {}
  for (const q of askQuestionsOf(props.m.input)) {
    const slot = draft.value[q.index]
    const parts = [...slot.labels]
    if (slot.customActive && slot.custom.trim()) parts.push(slot.custom.trim())
    answers[q.question] = parts.join(', ')
  }
  emit('submit-ask', props.m, answers)
}
</script>

<template>
  <!-- Replayed / superseded history: a single static line, no actions, no verdict -->
  <div v-if="isStatic" class="perm-history">{{ historyLine }}</div>

  <!-- AskUserQuestion: per-question answer panel -->
  <template v-else-if="m.toolName === 'AskUserQuestion'">
    <div class="label">
      {{ t('permission.ask.answerQuestion.label') }} <code>{{ ASK_TOOL_LABEL }}</code>
      <span v-if="m.consensus" class="consensus-badge split">{{
        t('permission.ask.multiAgentSuggestion.label')
      }}</span>
    </div>
    <div v-if="m.consensus" class="consensus-summary ask-summary">🤝 {{ m.consensus.summary }}</div>
    <div
      v-if="m.consensus && m.consensus.vendorScope && (m.consensus.crossVendorExcluded ?? 0) > 0"
      class="consensus-vendor-scope"
    >
      {{
        t('discussion.consensus.vendorScope.label', {
          vendor: VENDOR_LABEL[m.consensus.vendorScope],
          count: m.consensus.crossVendorExcluded ?? 0,
        })
      }}
    </div>
    <div class="ask-panel">
      <div v-for="q in askQuestionsOf(m.input)" :key="q.index" class="ask-q">
        <div class="ask-q-head">
          <span v-if="q.header" class="ask-q-header">{{ q.header }}</span>
          {{ q.question }}
        </div>
        <div class="ask-options">
          <label
            v-for="o in q.options"
            :key="o.label"
            class="ask-option"
            :class="{
              chosen: isOptionChosen(q.index, o.label),
              locked: !!m.decision,
            }"
          >
            <input
              :type="q.multiSelect ? 'checkbox' : 'radio'"
              :name="`q-${m.id}-${q.index}`"
              :checked="isOptionChosen(q.index, o.label)"
              :disabled="!!m.decision"
              @change="toggleAskOption(q, o.label)"
            />
            <span class="ask-option-body">
              <span class="ask-option-label">{{ o.label }}</span>
              <span v-if="o.description" class="ask-option-desc">{{ o.description }}</span>
            </span>
            <span class="ask-agents">
              <span
                v-for="a in agentsForOption(m.consensus, q.index, o.label)"
                :key="a.agentName"
                class="ask-agent-badge"
                :title="a.reason"
                >{{ a.agentName }}</span
              >
            </span>
          </label>
          <!-- Synthetic "custom reply" option: lets the user type a free answer. -->
          <label
            class="ask-option ask-option-custom"
            :class="{
              chosen: isCustomChosen(q.index),
              locked: !!m.decision,
            }"
          >
            <input
              :type="q.multiSelect ? 'checkbox' : 'radio'"
              :name="`q-${m.id}-${q.index}`"
              :checked="isCustomChosen(q.index)"
              :disabled="!!m.decision"
              @change="toggleAskCustomOption(q)"
            />
            <span class="ask-option-body">
              <span class="ask-option-label">{{ t('permission.ask.customReply.label') }}</span>
              <span class="ask-option-desc">{{ t('permission.ask.customReply.hint') }}</span>
            </span>
            <span class="ask-agents">
              <span
                v-for="a in agentsForCustom(m.consensus, q.index)"
                :key="a.agentName"
                class="ask-agent-badge"
                :title="`${a.custom}（${a.reason}）`"
                >{{ a.agentName }}</span
              >
            </span>
          </label>
        </div>
        <div
          v-for="a in agentsForCustom(m.consensus, q.index)"
          :key="a.agentName"
          class="ask-custom-hint"
          :title="a.reason"
        >
          {{ a.agentName }}：{{ a.custom }}
        </div>
        <input
          v-if="actionable && isCustomChosen(q.index)"
          class="ask-custom"
          type="text"
          :placeholder="t('permission.ask.custom.placeholder')"
          :value="askCustomOf(q.index)"
          @input="setAskCustom(q.index, ($event.target as HTMLInputElement).value)"
        />
      </div>
    </div>
    <div v-if="actionable" class="actions">
      <button class="deny" @click="respond('deny')">{{ t('common.action.deny.label') }}</button>
      <button :disabled="!isAskAnswered()" @click="submitAsk()">
        {{ t('permission.ask.submit.label') }}
      </button>
    </div>
    <div v-else class="decided">
      —
      {{ m.decision === 'allow' ? t('permission.status.answered') : t('permission.status.denied') }}
      —
    </div>
  </template>

  <!-- save_intents: render the proposed intents as cards -->
  <template v-else-if="m.toolName === SAVE_INTENTS_TOOL">
    <div class="label">
      {{ t('permission.save.label') }} <code>{{ SAVE_TOOL_LABEL }}</code>
    </div>
    <div class="req-confirm">
      <div v-for="(r, i) in proposedIntents" :key="i" class="req-confirm-card">
        <div class="req-confirm-head">
          <span class="req-priority" :class="r.priority">{{ r.priority }}</span>
          <span class="req-confirm-title">{{ r.title }}</span>
        </div>
        <div class="req-confirm-content">{{ r.content }}</div>
        <div v-if="r.dependsOn && r.dependsOn.length" class="req-confirm-deps">
          {{ t('permission.save.dependsOn') }}{{ r.dependsOn.join(', ') }}
        </div>
        <div v-if="batchDepLabels(r).length" class="req-confirm-deps">
          {{ t('permission.save.dependsOnBatch') }}{{ batchDepLabels(r).join(', ') }}
        </div>
      </div>
    </div>
    <div v-if="actionable" class="actions">
      <button class="deny" @click="respond('deny')">{{ t('common.action.cancel.label') }}</button>
      <button @click="respond('allow')">{{ t('common.action.save.label') }}</button>
    </div>
    <div v-else class="decided">
      —
      {{ m.decision === 'allow' ? t('permission.status.saved') : t('permission.status.cancelled') }}
      —
    </div>
  </template>

  <!-- Every other tool: allow / deny -->
  <template v-else>
    <div class="label">
      {{ t('permission.tool.allow.label') }} <code>{{ m.toolName }}</code> ?
    </div>
    <pre v-if="expandedInput" class="tool-body">{{ fmt(m.input) }}</pre>
    <div v-else class="tool-oneline" @click="expandedInput = true">
      {{ oneLine(fmt(m.input)) }}
    </div>
    <div v-if="m.consensus && m.consensus.kind === 'tool'" class="consensus consensus-split">
      <div class="consensus-summary">
        {{ t('permission.consensus.disagree.label') }} {{ m.consensus.summary }}
      </div>
      <div
        v-if="m.consensus.vendorScope && (m.consensus.crossVendorExcluded ?? 0) > 0"
        class="consensus-vendor-scope"
      >
        {{
          t('discussion.consensus.vendorScope.label', {
            vendor: VENDOR_LABEL[m.consensus.vendorScope],
            count: m.consensus.crossVendorExcluded ?? 0,
          })
        }}
      </div>
      <ul class="consensus-votes">
        <li v-for="v in m.consensus.votes" :key="v.agentId">
          <span class="vote-name">{{ v.agentName }}</span>
          <span class="vote-decision" :class="v.decision">{{ v.decision }}</span>
          <span class="vote-reason">{{ v.reason }}</span>
        </li>
      </ul>
    </div>
    <div v-if="actionable" class="actions">
      <button class="deny" @click="respond('deny')">{{ t('common.action.deny.label') }}</button>
      <button @click="respond('allow')">{{ t('common.action.allow.label') }}</button>
    </div>
    <div v-else class="decided">
      —
      {{ m.decision === 'allow' ? t('permission.status.allowed') : t('permission.status.denied') }}
      —
      <!--
        c3-gateway provenance tag — a c3/human decision gated this tool. The green
        「c3 allowed」 tag is the deliberate counterpart to ChatMessages' amber
        「vendor pre-approved」 tag: together the two colors make explicit that c3
        is the gateway here, but not the sole authority (a vendor rule engine can
        pre-approve without ever reaching this prompt). PG-R12.
      -->
      <span v-if="m.decision === 'allow'" class="approval-tag c3-gateway">{{
        t('permission.status.c3Gateway')
      }}</span>
    </div>
  </template>
</template>
