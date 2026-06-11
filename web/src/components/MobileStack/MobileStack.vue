<script setup lang="ts">
/*
 * MobileStack.vue - mobile-only drill-down layout shell.
 *
 * Desktop renders every pane slot in order. Mobile renders only the current
 * stack top and emits `back` when the shell back button pops to a previous pane.
 */
import { computed, ref, watch } from 'vue'
import { useBreakpoint } from '../../composables/useBreakpoint'

export interface MobileStackPane {
  key: string
  title: string
}

interface StackEntry {
  key: string
  token: string
}

const props = withDefaults(
  defineProps<{
    panes: readonly MobileStackPane[]
    activeKey?: string | null
    activeToken?: string | number | null
    breakpoint?: string
    backLabel?: string
  }>(),
  {
    activeKey: null,
    activeToken: null,
    breakpoint: 'mobile',
    backLabel: 'Back',
  },
)

const emit = defineEmits<{
  back: [targetKey: string]
}>()

const isMobile = useBreakpoint(props.breakpoint)

const firstKey = computed(() => props.panes[0]?.key ?? '')
const paneKeys = computed(() => new Set(props.panes.map((pane) => pane.key)))
const resolvedActiveKey = computed(() => {
  const key = props.activeKey ?? firstKey.value
  return paneKeys.value.has(key) ? key : firstKey.value
})
const resolvedActiveToken = computed(() => String(props.activeToken ?? resolvedActiveKey.value))

const stack = ref<StackEntry[]>([])

function resetStack(): void {
  stack.value = firstKey.value ? [{ key: firstKey.value, token: firstKey.value }] : []
}

function syncActivePane(key: string, token: string): void {
  if (!key) {
    stack.value = []
    return
  }

  if (stack.value.length === 0) {
    stack.value = [{ key, token }]
    return
  }

  const existingIndex = stack.value.findIndex((entry) => entry.key === key)
  if (existingIndex >= 0) {
    stack.value = stack.value.slice(0, existingIndex + 1)
    stack.value[existingIndex] = { key, token }
    return
  }

  stack.value = [...stack.value, { key, token }]
}

watch(
  [resolvedActiveKey, resolvedActiveToken, isMobile],
  ([key, token, mobile]) => {
    if (!mobile) {
      resetStack()
      return
    }
    syncActivePane(key, token)
  },
  { immediate: true },
)

watch(
  () => props.panes.map((pane) => pane.key).join('\u0000'),
  () => {
    if (!isMobile.value) {
      resetStack()
      return
    }
    syncActivePane(resolvedActiveKey.value, resolvedActiveToken.value)
  },
)

const activePane = computed(() => {
  const top = stack.value.at(-1)
  const key = top?.key ?? firstKey.value
  return props.panes.find((pane) => pane.key === key) ?? props.panes[0] ?? null
})

const canGoBack = computed(() => isMobile.value && stack.value.length > 1)

function goBack(): void {
  if (!canGoBack.value) return

  const nextStack = stack.value.slice(0, -1)
  stack.value = nextStack
  const targetKey = nextStack.at(-1)?.key
  if (targetKey) emit('back', targetKey)
}
</script>

<template>
  <div
    v-if="!isMobile"
    class="mobile-stack mobile-stack-desktop"
    data-testid="mobile-stack-desktop"
  >
    <slot v-for="pane in panes" :key="pane.key" :name="pane.key" />
  </div>

  <div v-else class="mobile-stack mobile-stack-mobile" data-testid="mobile-stack-mobile">
    <div v-if="activePane" class="mobile-stack-toolbar">
      <button
        v-if="canGoBack"
        type="button"
        class="mobile-stack-back"
        data-testid="mobile-stack-back"
        @click="goBack"
      >
        <span aria-hidden="true">&lsaquo;</span>
        <span>{{ backLabel }}</span>
      </button>
      <h2 class="mobile-stack-title">{{ activePane.title }}</h2>
    </div>

    <Transition name="mobile-stack-slide" mode="out-in">
      <section
        v-if="activePane"
        :key="`${activePane.key}:${stack.at(-1)?.token ?? ''}`"
        class="mobile-stack-pane"
        :data-pane-key="activePane.key"
        data-testid="mobile-stack-pane"
      >
        <slot :name="activePane.key" />
      </section>
    </Transition>
  </div>
</template>

<style scoped>
.mobile-stack-desktop {
  display: contents;
}

.mobile-stack-mobile {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--c-bg);
}

.mobile-stack-toolbar {
  flex-shrink: 0;
  height: 44px;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 0 var(--sp-3);
  background: var(--c-panel);
  border-bottom: 1px solid var(--c-border);
}

.mobile-stack-back {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  padding: var(--sp-1) var(--sp-2);
  color: var(--c-text);
  background: var(--c-input);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  font-size: var(--fs-caption);
  line-height: 1;
  cursor: pointer;
}

.mobile-stack-back:active {
  background: var(--c-card);
}

@media (hover: hover) and (pointer: fine) {
  .mobile-stack-back:hover {
    background: var(--c-card);
  }
}

.mobile-stack-title {
  min-width: 0;
  margin: 0;
  color: var(--c-text);
  font-size: var(--fs-title-sm);
  font-weight: 600;
  line-height: var(--lh-tight);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mobile-stack-pane {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.mobile-stack-slide-enter-active,
.mobile-stack-slide-leave-active {
  transition:
    opacity var(--dur-panel) var(--ease-standard),
    transform var(--dur-panel) var(--ease-standard);
}

.mobile-stack-slide-enter-from {
  opacity: 0;
  transform: translateX(20px);
}

.mobile-stack-slide-leave-to {
  opacity: 0;
  transform: translateX(-12px);
}

@media (prefers-reduced-motion: reduce) {
  .mobile-stack-slide-enter-active,
  .mobile-stack-slide-leave-active {
    transition: none;
  }
}
</style>
