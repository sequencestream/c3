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
} from '../lib/ask'
import { fmt, oneLine } from '../lib/format'
import type { PermissionMsg } from '../lib/chat-types'
import type { ProposedRequirement } from '@ccc/shared/protocol'

// `actionable` is true only for the live, still-pending permission the user can
// answer. When false and undecided, this prompt is a history record replayed
// from the buffer (or a superseded earlier request) and renders as a single
// static line — no buttons, no decision verdict.
const props = defineProps<{ m: PermissionMsg; actionable: boolean }>()

/** The c3 save_requirements tool's name (mirrors SAVE_REQUIREMENTS_TOOL server-side). */
const SAVE_REQUIREMENTS_TOOL = 'mcp__c3__save_requirements'

/** The proposed requirements carried by a save_requirements permission request. */
const proposedRequirements = computed<ProposedRequirement[]>(() => {
  const reqs = (props.m.input as { requirements?: unknown })?.requirements
  return Array.isArray(reqs) ? (reqs as ProposedRequirement[]) : []
})

/**
 * Human-readable labels for an item's intra-batch dependencies (`dependsOnIndexes`),
 * resolving each 0-based index to the sibling's `#N「title」` in this same batch so the
 * user sees the order relationship before allowing the save. Out-of-range indexes (the
 * server rejects them) fall back to a bare `#N`.
 */
function batchDepLabels(r: ProposedRequirement): string[] {
  const reqs = proposedRequirements.value
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
    return `🙋 Asked to answer ${askQuestionsOf(props.m.input).length} question(s) · AskUserQuestion`
  }
  if (props.m.toolName === SAVE_REQUIREMENTS_TOOL) {
    return `💾 Asked to save ${proposedRequirements.value.length} requirement(s)`
  }
  return `🔧 Asked to use tool ${props.m.toolName}`
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
      🙋 Answer question · <code>AskUserQuestion</code>
      <span v-if="m.consensus" class="consensus-badge split">Multi-agent suggestion</span>
    </div>
    <div v-if="m.consensus" class="consensus-summary ask-summary">🤝 {{ m.consensus.summary }}</div>
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
              <span class="ask-option-label">✏️ Custom reply</span>
              <span class="ask-option-desc">Type your own answer</span>
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
          placeholder="Type a custom reply…"
          :value="askCustomOf(q.index)"
          @input="setAskCustom(q.index, ($event.target as HTMLInputElement).value)"
        />
      </div>
    </div>
    <div v-if="actionable" class="actions">
      <button class="deny" @click="respond('deny')">Deny</button>
      <button :disabled="!isAskAnswered()" @click="submitAsk()">Submit answers</button>
    </div>
    <div v-else class="decided">— {{ m.decision === 'allow' ? 'answered' : 'denied' }} —</div>
  </template>

  <!-- save_requirements: render the proposed requirements as cards -->
  <template v-else-if="m.toolName === SAVE_REQUIREMENTS_TOOL">
    <div class="label">💾 Save requirements · <code>save_requirements</code></div>
    <div class="req-confirm">
      <div v-for="(r, i) in proposedRequirements" :key="i" class="req-confirm-card">
        <div class="req-confirm-head">
          <span class="req-priority" :class="r.priority">{{ r.priority }}</span>
          <span class="req-confirm-title">{{ r.title }}</span>
        </div>
        <div class="req-confirm-content">{{ r.content }}</div>
        <div v-if="r.dependsOn && r.dependsOn.length" class="req-confirm-deps">
          Depends on:{{ r.dependsOn.join(', ') }}
        </div>
        <div v-if="batchDepLabels(r).length" class="req-confirm-deps">
          Depends on (this batch):{{ batchDepLabels(r).join(', ') }}
        </div>
      </div>
    </div>
    <div v-if="actionable" class="actions">
      <button class="deny" @click="respond('deny')">Cancel</button>
      <button @click="respond('allow')">Save</button>
    </div>
    <div v-else class="decided">— {{ m.decision === 'allow' ? 'Saved' : 'Cancelled' }} —</div>
  </template>

  <!-- Every other tool: allow / deny -->
  <template v-else>
    <div class="label">
      Allow tool: <code>{{ m.toolName }}</code> ?
    </div>
    <pre v-if="expandedInput" class="tool-body">{{ fmt(m.input) }}</pre>
    <div v-else class="tool-oneline" @click="expandedInput = true">
      {{ oneLine(fmt(m.input)) }}
    </div>
    <div v-if="m.consensus && m.consensus.kind === 'tool'" class="consensus consensus-split">
      <div class="consensus-summary">🤝 Agents disagree: {{ m.consensus.summary }}</div>
      <ul class="consensus-votes">
        <li v-for="v in m.consensus.votes" :key="v.agentId">
          <span class="vote-name">{{ v.agentName }}</span>
          <span class="vote-decision" :class="v.decision">{{ v.decision }}</span>
          <span class="vote-reason">{{ v.reason }}</span>
        </li>
      </ul>
    </div>
    <div v-if="actionable" class="actions">
      <button class="deny" @click="respond('deny')">Deny</button>
      <button @click="respond('allow')">Allow</button>
    </div>
    <div v-else class="decided">— {{ m.decision === 'allow' ? 'allowed' : 'denied' }} —</div>
  </template>
</template>
