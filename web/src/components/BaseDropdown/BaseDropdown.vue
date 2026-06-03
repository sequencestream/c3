<script setup lang="ts" generic="T extends string | number">
/*
 * BaseDropdown.vue — 标准下拉框组件
 *
 * 替代原生 <select>，统一项目内的下拉交互与外观（参见 style.css 的 .dd-* 标准样式）。
 * 支持：图标行、键盘导航（↑/↓/Enter/Esc）、点击外部关闭、选中态高亮。
 */
import { ref, computed, nextTick, onBeforeUnmount, watch } from 'vue'

export interface DropdownOption<V> {
  value: V
  label: string
  /** 可选：行首图标（emoji 或单字符）。 */
  icon?: string
  disabled?: boolean
}

const props = withDefaults(
  defineProps<{
    modelValue: T
    options: DropdownOption<T>[]
    disabled?: boolean
    /** 面板展开方向，默认向下。 */
    placement?: 'bottom' | 'top'
    /** 触发按钮无障碍标签。 */
    ariaLabel?: string
  }>(),
  { disabled: false, placement: 'bottom', ariaLabel: undefined },
)

const emit = defineEmits<{ 'update:modelValue': [T] }>()

const open = ref(false)
const activeIndex = ref(-1)
const rootEl = ref<HTMLElement | null>(null)
const panelEl = ref<HTMLElement | null>(null)

const selected = computed(() => props.options.find((o) => o.value === props.modelValue) ?? null)
const selectedLabel = computed(() => selected.value?.label ?? '')

function toggle() {
  if (props.disabled) return
  if (open.value) close()
  else openMenu()
}

function openMenu() {
  open.value = true
  activeIndex.value = Math.max(
    0,
    props.options.findIndex((o) => o.value === props.modelValue),
  )
  document.addEventListener('pointerdown', onOutside, true)
  nextTick(scrollActiveIntoView)
}

function close() {
  open.value = false
  document.removeEventListener('pointerdown', onOutside, true)
}

function onOutside(e: PointerEvent) {
  if (rootEl.value && !rootEl.value.contains(e.target as Node)) close()
}

function pick(opt: DropdownOption<T>) {
  if (opt.disabled) return
  if (opt.value !== props.modelValue) emit('update:modelValue', opt.value)
  close()
}

function move(delta: number) {
  const n = props.options.length
  if (!n) return
  let i = activeIndex.value
  for (let step = 0; step < n; step++) {
    i = (i + delta + n) % n
    if (!props.options[i]?.disabled) break
  }
  activeIndex.value = i
  nextTick(scrollActiveIntoView)
}

function onKeydown(e: KeyboardEvent) {
  if (props.disabled) return
  if (!open.value) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault()
      openMenu()
    }
    return
  }
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault()
      move(1)
      break
    case 'ArrowUp':
      e.preventDefault()
      move(-1)
      break
    case 'Enter':
    case ' ':
      e.preventDefault()
      if (props.options[activeIndex.value]) pick(props.options[activeIndex.value])
      break
    case 'Escape':
      e.preventDefault()
      close()
      break
    case 'Tab':
      close()
      break
  }
}

function scrollActiveIntoView() {
  const panel = panelEl.value
  const item = panel?.children[activeIndex.value] as HTMLElement | undefined
  if (panel && item) {
    const top = item.offsetTop
    const bottom = top + item.offsetHeight
    if (top < panel.scrollTop) panel.scrollTop = top
    else if (bottom > panel.scrollTop + panel.clientHeight)
      panel.scrollTop = bottom - panel.clientHeight
  }
}

watch(
  () => props.disabled,
  (d) => {
    if (d) close()
  },
)

onBeforeUnmount(() => document.removeEventListener('pointerdown', onOutside, true))
</script>

<template>
  <div ref="rootEl" class="dd" :class="{ 'dd-open': open, 'dd-disabled': disabled }">
    <div
      class="dd-trigger"
      role="button"
      :tabindex="disabled ? -1 : 0"
      :aria-label="ariaLabel"
      :aria-disabled="disabled"
      aria-haspopup="listbox"
      :aria-expanded="open"
      @click="toggle"
      @keydown="onKeydown"
    >
      <span class="dd-value">{{ selectedLabel }}</span>
      <span class="dd-arrow" aria-hidden="true">
        <svg width="10" height="6" viewBox="0 0 10 6">
          <path fill="currentColor" d="M1 1l4 4 4-4" />
        </svg>
      </span>
    </div>

    <ul v-if="open" ref="panelEl" class="dd-panel" :class="`dd-panel-${placement}`" role="listbox">
      <li
        v-for="(opt, i) in options"
        :key="String(opt.value)"
        class="dd-item"
        :class="{
          'dd-item-active': i === activeIndex,
          'dd-item-selected': opt.value === modelValue,
          'dd-item-disabled': opt.disabled,
        }"
        role="option"
        :aria-selected="opt.value === modelValue"
        @click="pick(opt)"
        @mousemove="activeIndex = i"
      >
        <span v-if="opt.icon" class="dd-icon">{{ opt.icon }}</span>
        <span class="dd-label">{{ opt.label }}</span>
        <span v-if="opt.value === modelValue" class="dd-check" aria-hidden="true">✓</span>
      </li>
    </ul>
  </div>
</template>
