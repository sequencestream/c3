<script setup lang="ts">
/*
 * SettingsPanel.vue — 系统设置页：agent 列表（含默认 agent）与共识投票开关。
 *
 * 编辑用本地草稿，打开时从 App 注入的服务端设置深拷贝而来，保存时整体上抛。
 */
import { ref, watch } from 'vue'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'
import type { AgentConfig, PermissionMode, SystemSettings } from '@ccc/shared/protocol'

const MODES: PermissionMode[] = ['default', 'auto', 'plan', 'acceptEdits', 'bypassPermissions']

// Per-stage discussion round cap: floor enforced both here and server-side.
const MIN_ROUNDS_PER_STAGE = 8
const DEFAULT_ROUNDS_PER_STAGE = 12

// Discussion speech character limit: minimum enforced both here and server-side.
const MIN_SPEECH_CHARS = 300
const DEFAULT_SPEECH_CHARS = 300

// 浏览器语音输入的可选识别语言（BCP-47）。
const VOICE_LANGS: { value: string; label: string }[] = [
  { value: 'zh-CN', label: 'Chinese (Mandarin)' },
  { value: 'en-US', label: 'English (US)' },
  { value: 'zh-TW', label: 'Chinese (Traditional)' },
  { value: 'zh-HK', label: 'Cantonese' },
]

const props = defineProps<{
  open: boolean
  settings: SystemSettings | null
}>()

const emit = defineEmits<{
  close: []
  save: [settings: SystemSettings]
}>()

// A local, editable copy of the server settings; committed on Save.
const draft = ref<SystemSettings>({
  agents: [],
  defaultAgentId: SYSTEM_AGENT_ID,
  defaultMode: 'default',
  consensus: { enabled: false },
  voiceLang: 'zh-CN',
  showToolSessions: false,
  devSkill: '',
  maxRoundsPerStage: DEFAULT_ROUNDS_PER_STAGE,
  maxSpeechChars: DEFAULT_SPEECH_CHARS,
})

// Re-seed the draft whenever the panel opens or fresh server settings arrive.
// Deep-copy so edits to the draft don't mutate the rendered server state.
watch(
  () => [props.open, props.settings] as const,
  ([open, settings]) => {
    if (!open || !settings) return
    draft.value = {
      agents: settings.agents.map((a) => ({ ...a })),
      defaultAgentId: settings.defaultAgentId,
      defaultMode: settings.defaultMode ?? 'default',
      consensus: { enabled: settings.consensus?.enabled ?? false },
      voiceLang: settings.voiceLang ?? 'zh-CN',
      showToolSessions: settings.showToolSessions ?? false,
      devSkill: settings.devSkill ?? '',
      maxRoundsPerStage: settings.maxRoundsPerStage ?? DEFAULT_ROUNDS_PER_STAGE,
      maxSpeechChars: settings.maxSpeechChars ?? DEFAULT_SPEECH_CHARS,
    }
  },
  { immediate: true },
)

function addAgent() {
  // Locally-unique id so the default-agent radio can target it before save; the
  // server keeps it as-is (only id-less agents get a fresh uuid on normalize).
  const id = `new-${Date.now()}-${draft.value.agents.length}`
  draft.value.agents.push({ id, name: '', baseUrl: '', apiKey: '', model: '', enabled: true })
}

// An agent counts as enabled unless explicitly disabled (back-compat with
// configs/drafts that predate the field).
function isEnabled(a: AgentConfig): boolean {
  return a.enabled !== false
}

function removeAgent(id: string) {
  if (id === SYSTEM_AGENT_ID) return
  draft.value.agents = draft.value.agents.filter((a) => a.id !== id)
  if (draft.value.defaultAgentId === id) draft.value.defaultAgentId = SYSTEM_AGENT_ID
}

function isSystemAgent(a: AgentConfig): boolean {
  return a.id === SYSTEM_AGENT_ID
}
</script>

<template>
  <div v-if="open" class="settings-page">
    <div class="settings-head">
      <h2>System Settings</h2>
      <button class="icon-btn" title="Close" @click="emit('close')">✕</button>
    </div>
    <div class="settings-body">
      <section class="settings-section">
        <p class="settings-section-title">Agents</p>
        <p class="settings-hint">
          New sessions launch Claude Code with the default agent. The system agent uses no overrides
          (your existing <code>claude</code> login) and cannot be edited or removed. Toggle
          <strong>On</strong> to enable an agent; a disabled agent is excluded from discussion
          participants, consensus voting, the degradation chain, and the default picker — but bound
          or fallback launches still work, so no existing session is locked out.
        </p>
        <div class="agent-table">
          <div class="agent-row agent-row-head">
            <span class="col-on">On</span>
            <span class="col-default">Default</span>
            <span class="col-name">Name</span>
            <span class="col-url">Base URL</span>
            <span class="col-key">API Key</span>
            <span class="col-model">Model</span>
            <span class="col-actions"></span>
          </div>
          <div v-for="a in draft.agents" :key="a.id" class="agent-row">
            <label class="col-on">
              <input
                type="checkbox"
                :checked="isEnabled(a)"
                title="Enable / disable this agent"
                @change="a.enabled = ($event.target as HTMLInputElement).checked"
              />
            </label>
            <label class="col-default">
              <input
                type="radio"
                name="default-agent"
                :value="a.id"
                :checked="draft.defaultAgentId === a.id"
                :disabled="!isEnabled(a)"
                title="Only an enabled agent can be the default"
                @change="draft.defaultAgentId = a.id"
              />
            </label>
            <input
              v-model="a.name"
              class="agent-field col-name"
              :placeholder="isSystemAgent(a) ? 'System' : 'Agent name'"
              :disabled="isSystemAgent(a)"
            />
            <input
              v-model="a.baseUrl"
              class="agent-field col-url"
              :placeholder="isSystemAgent(a) ? '—' : 'ANTHROPIC_BASE_URL'"
              :disabled="isSystemAgent(a)"
            />
            <input
              v-model="a.apiKey"
              class="agent-field col-key"
              type="password"
              autocomplete="off"
              :placeholder="isSystemAgent(a) ? '—' : 'API key'"
              :disabled="isSystemAgent(a)"
            />
            <input
              v-model="a.model"
              class="agent-field col-model"
              :placeholder="isSystemAgent(a) ? '—' : 'e.g. claude-opus-4-8'"
              :disabled="isSystemAgent(a)"
            />
            <span class="col-actions">
              <button
                v-if="!isSystemAgent(a)"
                class="icon-btn"
                title="Remove agent"
                @click="removeAgent(a.id)"
              >
                🗑
              </button>
              <span v-else class="agent-badge">built-in</span>
            </span>
          </div>
        </div>
        <button class="agent-add" @click="addAgent">+ Add agent</button>
      </section>

      <section class="settings-section">
        <p class="settings-section-title">Default mode</p>
        <p class="settings-hint">
          The permission mode new sessions start in. You can still switch a session's mode at any
          time from its header.
        </p>
        <select v-model="draft.defaultMode" class="mode-select">
          <option v-for="m in MODES" :key="m" :value="m">{{ m }}</option>
        </select>
      </section>

      <section class="settings-section">
        <p class="settings-section-title">Dev skill</p>
        <p class="settings-hint">
          When starting a development task, this slash command is prepended to the requirement text.
          Leave it empty to add no skill prefix.
        </p>
        <input
          v-model="draft.devSkill"
          class="agent-field dev-skill-input"
          placeholder="/your-skill (leave empty for no prefix)"
        />
      </section>

      <section class="settings-section">
        <p class="settings-section-title">Discussion rounds per stage</p>
        <p class="settings-hint">
          The maximum number of speaking rounds a multi-agent discussion spends in each workflow
          stage before the organizer is forced to advance. Higher values allow deeper, longer
          discussions. Minimum {{ MIN_ROUNDS_PER_STAGE }} (lower values are clamped up on save).
        </p>
        <input
          v-model.number="draft.maxRoundsPerStage"
          class="agent-field rounds-input"
          type="number"
          :min="MIN_ROUNDS_PER_STAGE"
          step="1"
        />
      </section>

      <section class="settings-section">
        <p class="settings-section-title">Discussion speech character limit</p>
        <p class="settings-hint">
          The per-turn character budget participants see in their prompt guidance. Participants are
          asked to keep replies within this limit, but over-long replies are accepted verbatim (no
          hard truncation). Minimum {{ MIN_SPEECH_CHARS }} (lower values are clamped up on save).
        </p>
        <input
          v-model.number="draft.maxSpeechChars"
          class="agent-field rounds-input"
          type="number"
          :min="MIN_SPEECH_CHARS"
          step="1"
        />
      </section>

      <section class="settings-section">
        <p class="settings-section-title">Voice input language</p>
        <p class="settings-hint">
          The language the browser's speech recognition listens for when you use the microphone in
          the message box. Voice input is provided by the browser (Chrome/Edge) and may require a
          network connection.
        </p>
        <select v-model="draft.voiceLang" class="mode-select">
          <option v-for="l in VOICE_LANGS" :key="l.value" :value="l.value">{{ l.label }}</option>
        </select>
      </section>

      <section class="settings-section">
        <p class="settings-section-title">Consensus</p>
        <p class="settings-hint">
          When enabled, an allow/deny permission prompt is first put to the
          <em>other</em> configured agents. Each judges the tool call from the recent context and
          votes allow/deny with a reason; the session's own agent then summarizes their opinions. If
          every voter agrees, the prompt auto-resolves with no human needed — otherwise you decide,
          with each agent's vote and reason shown. Any error, timeout, or unparseable answer counts
          as an abstain, which keeps the decision with you. Needs at least one agent besides the
          session's own.
        </p>
        <p class="settings-hint">
          <strong>AskUserQuestion</strong> (where the agent asks <em>you</em> a multiple-choice
          question) takes a separate per-question path. c3 always shows you an answer panel and
          injects your picks back to the agent — that is the only way to answer it without a
          terminal, so it works regardless of this toggle. The consensus part only kicks in when
          it's <em>on</em>: the voters answer every question and the decider summarizes and
          reconciles answers that mean the same thing, so questions everyone agrees on get
          pre-filled or auto-answered and only the rest are left for you. With consensus off, no
          voting runs and you fill the whole panel yourself.
        </p>
        <label v-if="draft.consensus" class="consensus-toggle">
          <input v-model="draft.consensus.enabled" type="checkbox" />
          Enable multi-agent consensus voting
        </label>
      </section>

      <section class="settings-section">
        <p class="settings-section-title">Display</p>
        <label class="consensus-toggle">
          <input v-model="draft.showToolSessions" type="checkbox" />
          Show tool sessions
        </label>
      </section>
    </div>
    <div class="settings-foot">
      <button class="ghost" @click="emit('close')">Cancel</button>
      <button @click="emit('save', draft)">Save</button>
    </div>
  </div>
</template>
