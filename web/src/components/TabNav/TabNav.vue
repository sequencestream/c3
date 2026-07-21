<script setup lang="ts" generic="T extends string">
/*
 * TabNav.vue — the settings-style tab bar shared by the system-settings and
 * workspace-setting pages.
 *
 * Purely presentational: it holds no draft state and never decides whether a
 * switch is allowed — it emits `select` and the page (via useTabbedDraftSave's
 * `requestTab`) applies the dirty guard. A dot marks a tab with unsaved changes.
 *
 * `prefix` names the page's existing class / data-testid family (`settings`,
 * `project-config`), so each page keeps its own styling and selectors; the nav
 * element is this component's root, which still carries the page's scoped-style
 * attribute.
 */
defineProps<{
  tabs: readonly T[]
  activeTab: T
  /** Per-tab unsaved-changes flags (from `useTabbedDraftSave().tabDirtyMap`). */
  dirtyMap: Record<T, boolean>
  /** Localized label for a tab. */
  tabLabel: (tab: T) => string
  /** Class / data-testid family, e.g. `settings` ⇒ `.settings-tabs`, `.settings-tab`. */
  prefix: string
  /** Localized tooltip on the unsaved-changes dot. */
  dirtyTitle: string
}>()

const emit = defineEmits<{ select: [tab: T] }>()
</script>

<template>
  <!-- Horizontally scrollable on mobile so every tab stays reachable. -->
  <nav :class="`${prefix}-tabs`" role="tablist" :data-testid="`${prefix}-tabs`">
    <button
      v-for="tab in tabs"
      :key="tab"
      :class="[`${prefix}-tab`, { active: activeTab === tab }]"
      role="tab"
      :aria-selected="activeTab === tab"
      :data-testid="`${prefix}-tab-btn-${tab}`"
      @click="emit('select', tab)"
    >
      <span>{{ tabLabel(tab) }}</span>
      <span
        v-if="dirtyMap[tab]"
        :class="`${prefix}-tab-dot`"
        :data-testid="`${prefix}-tab-dirty-${tab}`"
        :title="dirtyTitle"
        >●</span
      >
    </button>
  </nav>
</template>
