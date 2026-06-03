<script setup lang="ts">
/*
 * MessageInput.vue — 底部输入区：斜杠命令自动补全 + 文本框 + 发送/停止。
 *
 * 自身持有输入文本与斜杠菜单状态；可用命令由 App 注入（懒加载，按会话 cwd）。
 * 首次输入 `/` 且命令未加载时上抛 list-commands，由 App 向服务端请求。
 */
import { ref, computed, nextTick, watch, onUnmounted } from 'vue'
import type { SlashCommandInfo } from '@ccc/shared/protocol'
import { useSpeechRecognition } from '../../composables/useSpeechRecognition'
import { composerAction, mergeIntoDraft } from '../../lib/pending-queue'

const props = defineProps<{
  running: boolean
  /**
   * The viewed session is a persistent agent team: the lead process stays alive
   * across turns. The composer stays usable even while the lead is busy (messages
   * route to the live lead and the SDK queues them); a separate control ends the
   * team.
   */
  teamActive: boolean
  hasActiveSession: boolean
  availableCommands: SlashCommandInfo[]
  voiceLang: string
}>()

// The input is never disabled for an active session. For an ordinary in-flight
// turn the server rejects user_prompt (single-turn), so Send enqueues instead of
// submitting — but the textarea itself stays editable so the user can compose
// ahead. Only the absence of a session disables it.
const inputDisabled = computed(() => !props.hasActiveSession)
// An ordinary (non-team) turn is in flight: show Stop alongside Send.
const ordinaryRunning = computed(() => props.running && !props.teamActive)

const emit = defineEmits<{
  submit: [text: string]
  enqueue: [text: string]
  stop: []
  'list-commands': []
}>()

const input = ref('')
const inputEl = ref<HTMLTextAreaElement | null>(null)

// 语音输入：聆听开始时记录 baseText（已有内容），识别结果追加其后。
let voiceBase = ''
const {
  supported: voiceSupported,
  state: voiceState,
  errorMessage: voiceError,
  start: voiceStart,
  stop: voiceStop,
} = useSpeechRecognition((final, interim) => {
  input.value = voiceBase + final + interim
})

function toggleMic() {
  if (!voiceSupported || !props.hasActiveSession) return
  if (voiceState.value === 'listening') {
    voiceStop()
    return
  }
  voiceBase = input.value ? input.value.replace(/\s*$/, '') + ' ' : ''
  voiceStart(props.voiceLang)
  nextTick(() => inputEl.value?.focus())
}

// 连续两次裸 Enter（间隔内）直接发送；记录上一次裸 Enter 的事件时间戳。
const DOUBLE_ENTER_MS = 400
let lastEnterAt = -Infinity

// 鼠标在 Send 按钮上停留超过 2s 时弹出发送方式提示。
const showSendHint = ref(false)
let hintTimer: ReturnType<typeof setTimeout> | null = null
function onSendHover() {
  if (hintTimer) clearTimeout(hintTimer)
  hintTimer = setTimeout(() => (showSendHint.value = true), 2000)
}
function onSendLeave() {
  if (hintTimer) clearTimeout(hintTimer)
  hintTimer = null
  showSendHint.value = false
}
onUnmounted(() => {
  if (hintTimer) clearTimeout(hintTimer)
})
const slashIndex = ref(0)
const slashDismissed = ref(false)
const slashMenuEl = ref<HTMLElement | null>(null)
const slashItemEls = ref<(HTMLElement | null)[]>([])

function setSlashItemRef(el: Element | { $el: Element } | null, i: number) {
  slashItemEls.value[i] = (el && '$el' in el ? el.$el : el) as HTMLElement | null
}

// Keep the highlighted command vertically centered in the scroll viewport.
watch(slashIndex, (i) => {
  nextTick(() => {
    const menu = slashMenuEl.value
    const item = slashItemEls.value[i]
    if (!menu || !item) return
    menu.scrollTop = item.offsetTop - menu.clientHeight / 2 + item.clientHeight / 2
  })
})

// The filter text when the input is a slash command being typed at the start
// (leading `/`, no whitespace yet). `null` ⇒ not in slash mode (closed menu).
const slashQuery = computed<string | null>(() => {
  const v = input.value
  if (!v.startsWith('/')) return null
  const rest = v.slice(1)
  if (/\s/.test(rest)) return null // a space means args are being typed — close
  return rest
})

const menuCommands = computed<SlashCommandInfo[]>(() => {
  if (slashQuery.value === null || slashDismissed.value) return []
  const q = slashQuery.value.toLowerCase()
  return props.availableCommands.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      (c.aliases ?? []).some((a) => a.toLowerCase().includes(q)),
  )
})
const slashOpen = computed(() => menuCommands.value.length > 0)

watch(input, (v) => {
  slashIndex.value = 0
  if (v.startsWith('/')) {
    if (props.availableCommands.length === 0) emit('list-commands')
  } else {
    slashDismissed.value = false
  }
})

function applyCommand(c: SlashCommandInfo) {
  input.value = `/${c.name} `
  slashDismissed.value = true
  nextTick(() => inputEl.value?.focus())
}

function submit() {
  const t = input.value.trim()
  if (!t || !props.hasActiveSession) return
  if (voiceState.value === 'listening') voiceStop()
  // Ordinary in-flight turn → enqueue (server would reject user_prompt); else
  // submit immediately (idle, or a team session feeding its live lead).
  if (composerAction(props.running, props.teamActive) === 'enqueue') emit('enqueue', t)
  else emit('submit', t)
  input.value = ''
}

// Re-open a queued item for editing: fold its text back into the current draft
// (single-newline append so an in-progress draft isn't lost), then focus.
function prefill(text: string) {
  input.value = mergeIntoDraft(input.value, text)
  nextTick(() => inputEl.value?.focus())
}

defineExpose({ prefill })

function onKey(e: KeyboardEvent) {
  // 聆听中按 Esc 先停止语音识别（不触发其他逻辑）。
  if (e.key === 'Escape' && voiceState.value === 'listening') {
    e.preventDefault()
    voiceStop()
    return
  }
  // While the slash menu is open it owns navigation/selection keys so they
  // don't fall through to the ⌘/Ctrl+Enter submit path.
  if (slashOpen.value) {
    const n = menuCommands.value.length
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      slashIndex.value = (slashIndex.value + 1) % n
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      slashIndex.value = (slashIndex.value - 1 + n) % n
      return
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      applyCommand(menuCommands.value[slashIndex.value])
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      slashDismissed.value = true
      return
    }
  }
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    submit()
    return
  }
  // 裸 Enter：短间隔内连按两次直接发送，否则保持默认换行。
  // 跳过输入法组合态（中文候选词回车确认）与 Shift+Enter 手动换行。
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    if (e.timeStamp - lastEnterAt < DOUBLE_ENTER_MS) {
      e.preventDefault()
      lastEnterAt = -Infinity
      submit()
    } else {
      lastEnterAt = e.timeStamp
    }
  }
}
</script>

<template>
  <footer>
    <div v-if="slashOpen" ref="slashMenuEl" class="slash-menu">
      <div
        v-for="(c, i) in menuCommands"
        :key="c.name"
        :ref="(el) => setSlashItemRef(el, i)"
        class="slash-item"
        :class="{ active: i === slashIndex }"
        @mousedown.prevent="applyCommand(c)"
        @mouseenter="slashIndex = i"
      >
        <span class="slash-name">/{{ c.name }}</span>
        <span v-if="c.argumentHint" class="slash-hint">{{ c.argumentHint }}</span>
        <span class="slash-desc">{{ c.description }}</span>
      </div>
    </div>
    <textarea
      ref="inputEl"
      v-model="input"
      :placeholder="
        !hasActiveSession
          ? 'Select or create a session to start'
          : teamActive
            ? 'Team running — type a message to send to the team lead (anytime)'
            : ordinaryRunning
              ? 'Turn in progress — your message will be queued and merged into the next turn'
              : voiceState === 'listening'
                ? 'Listening… click the mic again or press Esc to stop'
                : 'Type a prompt — Enter×2 or ⌘/Ctrl+Enter to send, / for commands'
      "
      :disabled="inputDisabled"
      @keydown="onKey"
    />
    <button
      v-if="voiceSupported"
      class="mic-btn"
      :class="{ listening: voiceState === 'listening', error: voiceState === 'error' }"
      :disabled="!hasActiveSession"
      :title="voiceState === 'error' ? voiceError : 'Voice input'"
      :aria-label="voiceState === 'listening' ? 'Stop voice input' : 'Start voice input'"
      :aria-pressed="voiceState === 'listening'"
      @click="toggleMic"
    >
      <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
        <rect x="2" y="8" width="2.4" height="8" rx="1.2" />
        <rect x="6.4" y="5" width="2.4" height="14" rx="1.2" />
        <rect x="10.8" y="2" width="2.4" height="20" rx="1.2" />
        <rect x="15.2" y="5" width="2.4" height="14" rx="1.2" />
        <rect x="19.6" y="8" width="2.4" height="8" rx="1.2" />
      </svg>
    </button>
    <!-- Ordinary in-flight turn: Stop is available alongside Send (which queues). -->
    <button
      v-if="ordinaryRunning"
      class="stop-btn"
      title="Stop the running turn"
      @click="emit('stop')"
    >
      Stop
    </button>
    <!-- Team session: end the whole team (lead + teammates) explicitly. -->
    <button
      v-else-if="teamActive"
      class="stop-btn"
      title="End team: shut down the team lead and all teammates"
      @click="emit('stop')"
    >
      End team
    </button>
    <div class="send-wrap" @mouseenter="onSendHover" @mouseleave="onSendLeave">
      <div v-if="showSendHint" class="send-hint" role="tooltip">
        {{
          ordinaryRunning
            ? 'Turn in progress — your message will be queued'
            : 'Press Enter twice, or ⌘/Ctrl+Enter to send'
        }}
      </div>
      <button class="send-btn" :disabled="!input.trim() || !hasActiveSession" @click="submit">
        {{ ordinaryRunning ? 'Queue' : 'Send' }}
      </button>
    </div>
  </footer>
</template>
