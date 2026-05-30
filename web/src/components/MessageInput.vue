<script setup lang="ts">
/*
 * MessageInput.vue — 底部输入区：斜杠命令自动补全 + 文本框 + 发送/停止。
 *
 * 自身持有输入文本与斜杠菜单状态；可用命令由 App 注入（懒加载，按会话 cwd）。
 * 首次输入 `/` 且命令未加载时上抛 list-commands，由 App 向服务端请求。
 */
import { ref, computed, nextTick, watch, onUnmounted } from 'vue'
import type { SlashCommandInfo } from '@ccc/shared/protocol'

const props = defineProps<{
  running: boolean
  hasActiveSession: boolean
  availableCommands: SlashCommandInfo[]
}>()

const emit = defineEmits<{
  submit: [text: string]
  stop: []
  'list-commands': []
}>()

const input = ref('')
const inputEl = ref<HTMLTextAreaElement | null>(null)

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
  if (!t || props.running || !props.hasActiveSession) return
  emit('submit', t)
  input.value = ''
}

function onKey(e: KeyboardEvent) {
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
          : running
            ? 'running…'
            : 'Type a prompt — Enter×2 or ⌘/Ctrl+Enter to send, / for commands'
      "
      :disabled="running || !hasActiveSession"
      @keydown="onKey"
    />
    <button v-if="running" class="stop-btn" title="Stop the running turn" @click="emit('stop')">
      Stop
    </button>
    <div v-else class="send-wrap" @mouseenter="onSendHover" @mouseleave="onSendLeave">
      <div v-if="showSendHint" class="send-hint" role="tooltip">
        连续回车两次，或 ⌘/Ctrl+Enter 发送
      </div>
      <button :disabled="!input.trim() || !hasActiveSession" @click="submit">Send</button>
    </div>
  </footer>
</template>
