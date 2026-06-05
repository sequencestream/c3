<script setup lang="ts">
/*
 * EmojiPicker.vue — 轻量、零依赖的 emoji 选择器,写回到一个普通的 icon 字符串。
 *
 * 触发按钮显示当前值(或占位图标);点开后是「搜索框 + 分类网格」的弹层。点选某个
 * emoji 即 emit `update:modelValue` 并关闭。手动输入仍由父级的文本框承担——本组件只
 * 负责「可视化选取 → 写回同一字段」,不改协议、不改持久化。
 *
 * 无障碍:触发/选项均为原生 <button>(键盘可达);弹层 role=dialog;Esc 关闭;
 * 点击组件外部关闭。emoji 数据是模块内静态常量,带英文关键词供搜索过滤。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useTypedI18n } from '@/i18n'

// `modelValue` is the agent's `icon` string. Optional + defaulted because legacy
// agents (and the system agent) may have no `icon` field at all (loads as undefined).
const props = withDefaults(defineProps<{ modelValue?: string }>(), { modelValue: '' })
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const { t } = useTypedI18n()

// 触发按钮兜底图标(与 icon placeholder 一致),仅用于「当前值为空」时的视觉提示。
const FALLBACK_ICON = '🙂'

// 每个分类:稳定的 key(代码侧)+ emoji 条目 [字符, 英文关键词]。关键词仅供搜索,
// 不渲染、不翻译。精选若干常见 emoji,刻意不求全——目标是「快速选一个识别图标」。
type EmojiEntry = readonly [string, string]
const COMMON: EmojiEntry[] = [
  ['🤖', 'robot bot'],
  ['🙂', 'smile face'],
  ['🚀', 'rocket launch'],
  ['⭐', 'star'],
  ['🔥', 'fire hot'],
  ['💡', 'idea bulb light'],
  ['🧠', 'brain'],
  ['✅', 'check done'],
  ['🛠️', 'tools build'],
  ['🎯', 'target goal'],
  ['📌', 'pin'],
  ['🔧', 'wrench tool'],
]
const FACES: EmojiEntry[] = [
  ['😀', 'grin happy'],
  ['😄', 'smile happy'],
  ['😎', 'cool sunglasses'],
  ['🤔', 'think'],
  ['🤓', 'nerd geek'],
  ['😴', 'sleep tired'],
  ['😇', 'angel innocent'],
  ['🥳', 'party celebrate'],
  ['😜', 'wink tongue'],
  ['🙃', 'upside silly'],
  ['😱', 'shock scream'],
  ['🤖', 'robot bot'],
]
const PEOPLE: EmojiEntry[] = [
  ['🙋', 'hand raise'],
  ['🧑‍💻', 'developer coder'],
  ['👩‍🔬', 'scientist'],
  ['🕵️', 'detective spy'],
  ['🧙', 'wizard mage'],
  ['🦸', 'hero super'],
  ['👨‍🏫', 'teacher'],
  ['🧑‍🚀', 'astronaut'],
  ['👷', 'worker build'],
  ['🧑‍⚖️', 'judge law'],
  ['🥷', 'ninja'],
  ['👻', 'ghost'],
]
const ANIMALS: EmojiEntry[] = [
  ['🐱', 'cat'],
  ['🐶', 'dog'],
  ['🦊', 'fox'],
  ['🐼', 'panda'],
  ['🐧', 'penguin'],
  ['🦉', 'owl'],
  ['🐢', 'turtle'],
  ['🐝', 'bee'],
  ['🦄', 'unicorn'],
  ['🐙', 'octopus'],
  ['🦁', 'lion'],
  ['🐉', 'dragon'],
]
const SYMBOLS: EmojiEntry[] = [
  ['❤️', 'heart love'],
  ['⚡', 'lightning bolt'],
  ['💎', 'diamond gem'],
  ['🌟', 'star sparkle'],
  ['♻️', 'recycle'],
  ['⚙️', 'gear settings'],
  ['🔒', 'lock secure'],
  ['🔔', 'bell notify'],
  ['✨', 'sparkle'],
  ['❓', 'question'],
  ['❗', 'exclaim'],
  ['🔵', 'blue circle'],
]
const OBJECTS: EmojiEntry[] = [
  ['📦', 'box package'],
  ['📚', 'books'],
  ['💻', 'laptop computer'],
  ['📱', 'phone mobile'],
  ['🗂️', 'folder files'],
  ['🔑', 'key'],
  ['🧩', 'puzzle piece'],
  ['🎨', 'art palette'],
  ['🔬', 'microscope science'],
  ['🧪', 'test tube lab'],
  ['📡', 'satellite signal'],
  ['🕹️', 'joystick game'],
]

const categories = computed(() => [
  { key: 'common', label: t('settings.agents.icon.picker.category.common'), emojis: COMMON },
  { key: 'faces', label: t('settings.agents.icon.picker.category.faces'), emojis: FACES },
  { key: 'people', label: t('settings.agents.icon.picker.category.people'), emojis: PEOPLE },
  { key: 'animals', label: t('settings.agents.icon.picker.category.animals'), emojis: ANIMALS },
  { key: 'symbols', label: t('settings.agents.icon.picker.category.symbols'), emojis: SYMBOLS },
  { key: 'objects', label: t('settings.agents.icon.picker.category.objects'), emojis: OBJECTS },
])

const open = ref(false)
const query = ref('')
const root = ref<HTMLElement | null>(null)

// 搜索时无视分类、跨全表按关键词/字符过滤;空查询时按分类分组展示。
const filtered = computed<{ key: string; label: string; emojis: EmojiEntry[] }[]>(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return categories.value
  const all = categories.value.flatMap((c) => c.emojis)
  const hits = all.filter(([char, kw]) => kw.includes(q) || char.includes(q))
  // 去重(同一 emoji 可能在多个分类出现,如 🤖)。
  const seen = new Set<string>()
  const dedup = hits.filter(([char]) => (seen.has(char) ? false : (seen.add(char), true)))
  return [{ key: 'search', label: t('settings.agents.icon.picker.category.common'), emojis: dedup }]
})

const hasResults = computed(() => filtered.value.some((g) => g.emojis.length > 0))

function toggle() {
  open.value = !open.value
  if (open.value) {
    query.value = ''
    nextTick(() => searchInput.value?.focus())
  }
}

function close() {
  open.value = false
}

function pick(emoji: string) {
  emit('update:modelValue', emoji)
  close()
}

const searchInput = ref<HTMLInputElement | null>(null)

function onDocPointerDown(e: PointerEvent) {
  if (!open.value) return
  if (root.value && !root.value.contains(e.target as Node)) close()
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) {
    e.stopPropagation()
    close()
  }
}

watch(open, (isOpen) => {
  if (isOpen) document.addEventListener('pointerdown', onDocPointerDown)
  else document.removeEventListener('pointerdown', onDocPointerDown)
})

onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocPointerDown))
</script>

<template>
  <div ref="root" class="emoji-picker" @keydown="onKeydown">
    <button
      type="button"
      class="emoji-trigger"
      :class="{ 'is-open': open }"
      :aria-expanded="open"
      :aria-label="t('settings.agents.icon.picker.open.aria')"
      :title="t('settings.agents.icon.picker.open.tooltip')"
      data-testid="emoji-picker-trigger"
      @click="toggle"
    >
      <span class="emoji-trigger-glyph">{{ props.modelValue || FALLBACK_ICON }}</span>
    </button>

    <div
      v-if="open"
      class="emoji-panel"
      role="dialog"
      :aria-label="t('settings.agents.icon.picker.open.aria')"
    >
      <input
        ref="searchInput"
        v-model="query"
        class="emoji-search"
        type="text"
        :placeholder="t('settings.agents.icon.picker.search.placeholder')"
        data-testid="emoji-picker-search"
      />
      <div v-if="!hasResults" class="emoji-empty">
        {{ t('settings.agents.icon.picker.empty.text') }}
      </div>
      <div v-else class="emoji-scroll">
        <div v-for="group in filtered" :key="group.key" class="emoji-group">
          <p v-if="!query" class="emoji-group-title">{{ group.label }}</p>
          <div class="emoji-grid">
            <button
              v-for="[char, kw] in group.emojis"
              :key="group.key + char"
              type="button"
              class="emoji-cell"
              :aria-label="kw"
              data-testid="emoji-picker-cell"
              @click="pick(char)"
            >
              {{ char }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.emoji-picker {
  position: relative;
  display: inline-flex;
}

.emoji-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  padding: 0;
  border: 1px solid var(--border, #d0d0d0);
  border-radius: 6px;
  background: var(--surface, #fff);
  cursor: pointer;
  font-size: 1.1rem;
  line-height: 1;
}

.emoji-trigger.is-open,
.emoji-trigger:hover {
  border-color: var(--accent, #6b8afd);
}

.emoji-trigger-glyph {
  pointer-events: none;
}

.emoji-panel {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 50;
  width: 16rem;
  padding: 0.5rem;
  border: 1px solid var(--border, #d0d0d0);
  border-radius: 8px;
  background: var(--surface, #fff);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.15);
}

.emoji-search {
  width: 100%;
  box-sizing: border-box;
  padding: 0.35rem 0.5rem;
  margin-bottom: 0.4rem;
  border: 1px solid var(--border, #d0d0d0);
  border-radius: 6px;
  font-size: 0.85rem;
}

.emoji-empty {
  padding: 0.75rem 0.25rem;
  color: var(--muted, #888);
  font-size: 0.85rem;
  text-align: center;
}

.emoji-scroll {
  max-height: 14rem;
  overflow-y: auto;
}

.emoji-group-title {
  margin: 0.3rem 0 0.2rem;
  color: var(--muted, #888);
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.emoji-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 2px;
}

.emoji-cell {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 1;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  font-size: 1.15rem;
  line-height: 1;
}

.emoji-cell:hover,
.emoji-cell:focus-visible {
  background: var(--hover, #eef1ff);
  outline: none;
}
</style>
