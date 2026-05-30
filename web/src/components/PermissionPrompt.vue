<script setup lang="ts">
/*
 * PermissionPrompt.vue — 单条权限提示块
 *
 * 渲染两种形态：AskUserQuestion 的逐题作答面板，以及其它工具的 allow/deny 提示。
 * 两者都可附带多 agent 共识（分歧）意见。组件不持有 WebSocket，决策通过事件上抛，
 * 由 App 统一发送并回写 m.decision。
 */
import { ref } from 'vue'
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

const props = defineProps<{ m: PermissionMsg }>()

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
  <!-- AskUserQuestion: per-question answer panel -->
  <template v-if="m.toolName === 'AskUserQuestion'">
    <div class="label">
      🙋 回答提问 · <code>AskUserQuestion</code>
      <span v-if="m.consensus" class="consensus-badge split">多 agent 建议</span>
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
              <span class="ask-option-label">✏️ 自定义回复</span>
              <span class="ask-option-desc">自己输入答案</span>
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
          v-if="m.decision === null && isCustomChosen(q.index)"
          class="ask-custom"
          type="text"
          placeholder="输入自定义回复…"
          :value="askCustomOf(q.index)"
          @input="setAskCustom(q.index, ($event.target as HTMLInputElement).value)"
        />
      </div>
    </div>
    <div v-if="m.decision === null" class="actions">
      <button class="deny" @click="respond('deny')">Deny</button>
      <button :disabled="!isAskAnswered()" @click="submitAsk()">提交答案</button>
    </div>
    <div v-else class="decided">— {{ m.decision === 'allow' ? 'answered' : 'denied' }} —</div>
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
      <div class="consensus-summary">🤝 多 agent 意见分歧：{{ m.consensus.summary }}</div>
      <ul class="consensus-votes">
        <li v-for="v in m.consensus.votes" :key="v.agentId">
          <span class="vote-name">{{ v.agentName }}</span>
          <span class="vote-decision" :class="v.decision">{{ v.decision }}</span>
          <span class="vote-reason">{{ v.reason }}</span>
        </li>
      </ul>
    </div>
    <div v-if="m.decision === null" class="actions">
      <button class="deny" @click="respond('deny')">Deny</button>
      <button @click="respond('allow')">Allow</button>
    </div>
    <div v-else class="decided">— {{ m.decision === 'allow' ? 'allowed' : 'denied' }} —</div>
  </template>
</template>
