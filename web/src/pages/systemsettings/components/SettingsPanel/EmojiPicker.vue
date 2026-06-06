<script setup lang="ts">
/*
 * EmojiPicker.vue — 轻量、零依赖的 emoji 选择器,写回到一个普通的 icon 字符串。
 *
 * 触发器是一颗「按钮」:按钮上显示当前 icon(为空时显示占位字形)。点击按钮弹出居中的
 * 模态弹框(背景遮罩 + 卡片),内含「搜索框 + 自定义输入框 + 分类网格」。点选某个 emoji
 * 即 emit `update:modelValue` 并关闭弹框;自定义输入框仍可直接手输任意字符(最长 16)。
 * emoji 数据见 `emoji-data.ts`(500+ 条,带英文关键词供搜索),不改协议、不改持久化。
 *
 * 无障碍:按钮 aria-haspopup=dialog;弹框 role=dialog aria-modal;Esc 关闭;点击遮罩关闭;
 * 打开时自动聚焦搜索框。遮罩用 `position: fixed` 覆盖全屏——`.settings-page` 虽为 fixed 但
 * 无 transform,不构成包含块,故 fixed 相对视口定位,无需 Teleport(便于组件单测)。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useTypedI18n } from '@/i18n'
import { EMOJI_CATEGORIES, type EmojiCategory, type EmojiEntry } from './emoji-data'

// `modelValue` is the agent's `icon` string. Optional + defaulted because legacy
// agents (and the system agent) may have no `icon` field at all (loads as undefined).
const props = withDefaults(defineProps<{ modelValue?: string }>(), { modelValue: '' })
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const { t } = useTypedI18n()

// 分类标签:逐项显式调用 typed `t`,使拼错的 key 在 vue-tsc 期失败(动态键无法静态校验)。
const CATEGORY_LABEL: Record<string, () => string> = {
  common: () => t('settings.agents.icon.picker.category.common'),
  faces: () => t('settings.agents.icon.picker.category.faces'),
  people: () => t('settings.agents.icon.picker.category.people'),
  animals: () => t('settings.agents.icon.picker.category.animals'),
  food: () => t('settings.agents.icon.picker.category.food'),
  travel: () => t('settings.agents.icon.picker.category.travel'),
  activities: () => t('settings.agents.icon.picker.category.activities'),
  objects: () => t('settings.agents.icon.picker.category.objects'),
  symbols: () => t('settings.agents.icon.picker.category.symbols'),
}

type Group = { key: string; label: string; emojis: readonly EmojiEntry[] }

const categories = computed<Group[]>(() =>
  EMOJI_CATEGORIES.map((c: EmojiCategory) => ({
    key: c.key,
    label: CATEGORY_LABEL[c.key]?.() ?? c.key,
    emojis: c.emojis,
  })),
)

const open = ref(false)
const query = ref('')
const searchInput = ref<HTMLInputElement | null>(null)

// 搜索时无视分类、跨全表按关键词/字符过滤;空查询时按分类分组展示。
const filtered = computed<Group[]>(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return categories.value
  const all = categories.value.flatMap((c) => c.emojis)
  const hits = all.filter(([char, kw]) => kw.includes(q) || char.includes(q))
  // 去重(同一 emoji 可能在多个分类出现)。
  const seen = new Set<string>()
  const dedup = hits.filter(([char]) => (seen.has(char) ? false : (seen.add(char), true)))
  return [{ key: 'search', label: t('settings.agents.icon.picker.category.common'), emojis: dedup }]
})

const hasResults = computed(() => filtered.value.some((g) => g.emojis.length > 0))

function openModal() {
  open.value = true
  query.value = ''
  // 打开后把焦点交给搜索框,方便直接键盘筛选。
  nextTick(() => searchInput.value?.focus())
}

function close() {
  open.value = false
}

function toggle() {
  if (open.value) close()
  else openModal()
}

// 手输自定义字符:直接写回同一字段(不改持久化、不校验是否真 emoji,与协议一致),弹框保持打开。
function onManualInput(e: Event) {
  emit('update:modelValue', (e.target as HTMLInputElement).value)
}

function pick(emoji: string) {
  emit('update:modelValue', emoji)
  close()
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) {
    e.stopPropagation()
    close()
  }
}

watch(open, (isOpen) => {
  if (isOpen) document.addEventListener('keydown', onKeydown)
  else document.removeEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="emoji-picker">
    <button
      type="button"
      class="agent-field icon-trigger"
      :class="{ 'is-empty': !props.modelValue, 'is-open': open }"
      :aria-label="t('settings.agents.icon.picker.open.aria')"
      :title="t('settings.agents.icon.picker.open.tooltip')"
      aria-haspopup="dialog"
      :aria-expanded="open"
      data-testid="emoji-picker-trigger"
      @click="toggle"
    >
      <span class="icon-trigger-glyph">{{
        props.modelValue || t('settings.agents.icon.placeholder')
      }}</span>
    </button>

    <div
      v-if="open"
      class="emoji-overlay"
      data-testid="emoji-picker-overlay"
      @pointerdown.self="close"
    >
      <div
        class="emoji-panel"
        role="dialog"
        aria-modal="true"
        :aria-label="t('settings.agents.icon.picker.open.aria')"
      >
        <div class="emoji-panel-head">
          <h3 class="emoji-panel-title">{{ t('settings.agents.col.icon.label') }}</h3>
          <button
            type="button"
            class="icon-btn emoji-panel-close"
            :title="t('common.action.close.tooltip')"
            @click="close"
          >
            ✕
          </button>
        </div>

        <input
          ref="searchInput"
          v-model="query"
          class="emoji-search"
          type="text"
          :placeholder="t('settings.agents.icon.picker.search.placeholder')"
          data-testid="emoji-picker-search"
        />

        <input
          class="emoji-manual"
          type="text"
          :value="props.modelValue"
          :placeholder="t('settings.agents.icon.placeholder')"
          :aria-label="t('settings.agents.col.icon.label')"
          maxlength="16"
          data-testid="emoji-picker-manual"
          @input="onManualInput"
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
                :title="char"
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
  </div>
</template>

<style scoped>
.emoji-picker {
  display: flex;
  width: 100%;
}

/* 触发按钮:展示当前 icon,点击弹出模态选择器。 */
.icon-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-width: 0;
  cursor: pointer;
}

.icon-trigger-glyph {
  font-size: 1.15rem;
  line-height: 1;
}

/* 为空时占位字形淡显,提示这里可设置 icon。 */
.icon-trigger.is-empty .icon-trigger-glyph {
  opacity: 0.4;
}

.icon-trigger.is-open {
  border-color: var(--accent, #6b8afd);
}

/* 全屏遮罩 + 居中卡片:覆盖在设置页(z-index:100)之上。 */
.emoji-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(0, 0, 0, 0.4);
}

.emoji-panel {
  display: flex;
  flex-direction: column;
  width: 20rem;
  max-width: 100%;
  max-height: 80vh;
  padding: 0.75rem;
  border: 1px solid var(--border, #d0d0d0);
  border-radius: 10px;
  background: var(--surface, #fff);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
}

.emoji-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.5rem;
}

.emoji-panel-title {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 600;
}

.emoji-panel-close {
  border: 0;
  background: transparent;
  cursor: pointer;
  font-size: 0.9rem;
  line-height: 1;
}

.emoji-search,
.emoji-manual {
  width: 100%;
  box-sizing: border-box;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--border, #d0d0d0);
  border-radius: 6px;
  font-size: 0.85rem;
}

.emoji-search {
  margin-bottom: 0.4rem;
}

.emoji-manual {
  margin-bottom: 0.5rem;
  text-align: center;
}

.emoji-empty {
  padding: 0.75rem 0.25rem;
  color: var(--muted, #888);
  font-size: 0.85rem;
  text-align: center;
}

.emoji-scroll {
  flex: 1;
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
  grid-template-columns: repeat(7, 1fr);
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
