<script setup lang="ts">
/*
 * MessageInput.vue — 底部输入区：斜杠命令自动补全 + 文本框 + 图片附件 + 发送/停止。
 *
 * 自身持有输入文本、斜杠菜单状态与待发图片；可用命令由 App 注入（懒加载，按会话 cwd）。
 * 首次输入 `/` 且命令未加载时上抛 list-commands，由 App 向服务端请求。
 *
 * 图片附件（点击附件按钮 / 粘贴 / 拖拽放下）：经 lib/prompt-image 正规化（仅图片，
 * 超阈压缩），在文本框上方以缩略图列表展示，可逐张删除；submit/enqueue 时以 wire 形态
 * 的 PromptImage 随文本一并上抛（image-only 也可发送），发送后清空。非图片被忽略并提示。
 */
import { ref, computed, nextTick, watch, onMounted, onUnmounted } from 'vue'
import type { PromptImage, SlashCommandInfo } from '@ccc/shared/protocol'
import { useSpeechRecognition } from '../../composables/useSpeechRecognition'
import { composerAction, mergeIntoDraft } from '../../lib/pending-queue'
import { fromWire, readImageFiles, toWire, type SelectedImage } from '../../lib/prompt-image'
import { autoGrowHeight } from '../../lib/textarea'
import { useTypedI18n } from '@/i18n'

const { t } = useTypedI18n()

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
  submit: [text: string, images: PromptImage[]]
  enqueue: [text: string, images: PromptImage[]]
  'list-commands': []
}>()

const input = ref('')
const inputEl = ref<HTMLTextAreaElement | null>(null)

// ---- Attached images (click / paste / drag-drop) ----
// Selected-but-not-yet-sent images, shown as thumbnails above the textarea. They
// ride along with the next submit/enqueue (toWire), then clear. Non-images are
// ignored at intake and surface a transient notice.
const images = ref<SelectedImage[]>([])
const fileInput = ref<HTMLInputElement | null>(null)
const dragOver = ref(false)
const attachNotice = ref(false)
let nextImageId = 0
let noticeTimer: ReturnType<typeof setTimeout> | null = null

function flashAttachNotice(): void {
  attachNotice.value = true
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => (attachNotice.value = false), 4000)
}

// Normalize a batch of files into selected images (filter non-images, compress
// oversize), append to the pending thumbnails, and notice any rejections.
async function intakeFiles(files: File[]): Promise<void> {
  if (files.length === 0) return
  const { images: processed, rejectedCount } = await readImageFiles(files)
  for (const img of processed) images.value.push({ id: nextImageId++, ...img })
  if (rejectedCount > 0) flashAttachNotice()
}

function openFilePicker(): void {
  if (!props.hasActiveSession) return
  fileInput.value?.click()
}

function onFileChange(e: Event): void {
  const el = e.target as HTMLInputElement
  void intakeFiles(Array.from(el.files ?? []))
  // Reset so picking the same file again re-triggers change.
  el.value = ''
}

function onPaste(e: ClipboardEvent): void {
  const files = Array.from(e.clipboardData?.files ?? [])
  if (files.length === 0) return // plain-text paste — leave default behavior
  e.preventDefault()
  void intakeFiles(files)
}

function onDrop(e: DragEvent): void {
  dragOver.value = false
  const files = Array.from(e.dataTransfer?.files ?? [])
  if (files.length === 0) return
  e.preventDefault()
  void intakeFiles(files)
}

function onDragOver(e: DragEvent): void {
  if (!props.hasActiveSession) return
  if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return
  e.preventDefault()
  dragOver.value = true
}

function onDragLeave(): void {
  dragOver.value = false
}

function removeImage(id: number): void {
  images.value = images.value.filter((img) => img.id !== id)
}

function updateKeyboardOffset(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  const viewport = window.visualViewport
  if (!viewport) {
    document.documentElement.style.setProperty('--composer-keyboard-offset', '0px')
    return
  }
  const hiddenBottom = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
  document.documentElement.style.setProperty('--composer-keyboard-offset', `${hiddenBottom}px`)
}

onMounted(() => {
  updateKeyboardOffset()
  window.visualViewport?.addEventListener('resize', updateKeyboardOffset)
  window.visualViewport?.addEventListener('scroll', updateKeyboardOffset)
  window.addEventListener('orientationchange', updateKeyboardOffset)
})

onUnmounted(() => {
  window.visualViewport?.removeEventListener('resize', updateKeyboardOffset)
  window.visualViewport?.removeEventListener('scroll', updateKeyboardOffset)
  window.removeEventListener('orientationchange', updateKeyboardOffset)
  document.documentElement.style.removeProperty('--composer-keyboard-offset')
})

// Auto-grow: the composer grows with its content up to this cap, then scrolls
// internally so a long draft never pushes the layout. The CSS `min-height`
// (56px) floors the single-line state, so clearing/sending shrinks back to it.
const MAX_TEXTAREA_PX = 200
function resizeInput(): void {
  const el = inputEl.value
  if (!el) return
  el.style.height = 'auto'
  const { height, overflowY } = autoGrowHeight(el.scrollHeight, MAX_TEXTAREA_PX)
  el.style.height = `${height}px`
  el.style.overflowY = overflowY
}
// One source of truth for every text mutation — typing (v-model), voice append,
// prefill from the send queue, slash-command apply, and the post-send clear all
// flow through `input`, so a single watch keeps the height in sync after render.
watch(input, () => nextTick(resizeInput))

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
  if (noticeTimer) clearTimeout(noticeTimer)
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
  // Send when there is text OR at least one attached image (image-only is allowed).
  if ((!t && images.value.length === 0) || !props.hasActiveSession) return
  if (voiceState.value === 'listening') voiceStop()
  const wire = toWire(images.value)
  // Ordinary in-flight turn → enqueue (server would reject user_prompt); else
  // submit immediately (idle, or a team session feeding its live lead).
  if (composerAction(props.running, props.teamActive) === 'enqueue') emit('enqueue', t, wire)
  else emit('submit', t, wire)
  input.value = ''
  images.value = []
}

// Re-open a queued item for editing: fold its text back into the current draft
// (single-newline append so an in-progress draft isn't lost) and restore its
// images (rebuilding preview metadata from the wire shape), then focus.
function prefill(text: string, queuedImages: PromptImage[] = []) {
  input.value = mergeIntoDraft(input.value, text)
  for (const img of queuedImages) images.value.push(fromWire(img, nextImageId++))
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
  <footer
    class="message-input"
    :class="{ 'drag-over': dragOver }"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div v-if="attachNotice" class="attach-notice" role="status">
      {{ t('session.input.attach.rejected') }}
    </div>
    <div
      v-if="images.length"
      class="image-previews"
      :aria-label="t('session.input.attach.listAriaLabel')"
    >
      <div v-for="img in images" :key="img.id" class="image-thumb">
        <img :src="img.previewUrl" :alt="img.name" />
        <button
          class="image-remove"
          :title="t('session.input.attach.remove.tooltip')"
          :aria-label="t('session.input.attach.remove.ariaLabel')"
          @click="removeImage(img.id)"
        >
          ×
        </button>
      </div>
    </div>
    <input
      ref="fileInput"
      class="file-input"
      type="file"
      accept="image/*"
      multiple
      hidden
      @change="onFileChange"
    />
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
    <!-- The action buttons are embedded inside this field as a bottom bar: attach+mic
         at the inner bottom-left, send at the inner bottom-right. Laying them out in a
         flex column (textarea above, bar below) keeps text and buttons in normal flow so
         they never overlap in any state; the border/focus ring lives on the container. -->
    <div class="composer-field">
      <textarea
        ref="inputEl"
        v-model="input"
        :placeholder="
          !hasActiveSession
            ? t('session.input.placeholder.noSession')
            : teamActive
              ? t('session.input.placeholder.team')
              : ordinaryRunning
                ? t('session.input.placeholder.running')
                : voiceState === 'listening'
                  ? t('session.input.placeholder.listening')
                  : t('session.input.placeholder.ready')
        "
        :disabled="inputDisabled"
        @keydown="onKey"
        @paste="onPaste"
      />
      <div class="composer-bar">
        <div class="composer-actions">
          <button
            class="attach-btn"
            :disabled="!hasActiveSession"
            :title="t('session.input.attach.tooltip')"
            :aria-label="t('session.input.attach.ariaLabel')"
            @click="openFilePicker"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
              <path
                d="M16.5 6.5v9a4.5 4.5 0 0 1-9 0V6a3 3 0 0 1 6 0v9a1.5 1.5 0 0 1-3 0V7h-1.5v8a3 3 0 0 0 6 0V6a4.5 4.5 0 0 0-9 0v9.5a6 6 0 0 0 12 0v-9z"
              />
            </svg>
          </button>
          <button
            v-if="voiceSupported"
            class="mic-btn"
            :class="{ listening: voiceState === 'listening', error: voiceState === 'error' }"
            :disabled="!hasActiveSession"
            :title="voiceState === 'error' ? voiceError : t('session.input.voice.tooltip')"
            :aria-label="
              voiceState === 'listening'
                ? t('session.input.voice.stop.ariaLabel')
                : t('session.input.voice.start.ariaLabel')
            "
            :aria-pressed="voiceState === 'listening'"
            @click="toggleMic"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
              <rect x="2" y="8" width="2.4" height="8" rx="1.2" />
              <rect x="6.4" y="5" width="2.4" height="14" rx="1.2" />
              <rect x="10.8" y="2" width="2.4" height="20" rx="1.2" />
              <rect x="15.2" y="5" width="2.4" height="14" rx="1.2" />
              <rect x="19.6" y="8" width="2.4" height="8" rx="1.2" />
            </svg>
          </button>
        </div>
        <!-- Send is an icon button now; while a turn is in flight it enqueues (composerAction).
             Stop/End team live in the status bar, not here. -->
        <div class="send-wrap" @mouseenter="onSendHover" @mouseleave="onSendLeave">
          <div v-if="showSendHint" class="send-hint" role="tooltip">
            {{
              ordinaryRunning
                ? t('session.input.sendHint.running')
                : t('session.input.sendHint.ready')
            }}
          </div>
          <button
            class="send-btn"
            :disabled="(!input.trim() && images.length === 0) || !hasActiveSession"
            :title="t('session.input.send.label')"
            :aria-label="t('session.input.send.label')"
            @click="submit"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
              <path
                d="M12 5v14M12 19l-6-6M12 19l6-6"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>
  </footer>
</template>
