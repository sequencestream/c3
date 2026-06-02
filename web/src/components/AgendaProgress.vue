<script setup lang="ts">
/*
 * AgendaProgress.vue — read-only agenda progress for the open discussion.
 *
 * Shows the organizer's explicit agenda: the ordered subtopic list, which one is
 * current, and overall completion. Data comes straight from `activeDiscussion`
 * (`agenda` + `agendaIndex`); all derivation lives in the pure selector
 * `agendaProgressView` (see lib/discussion-view.ts). The component is the selector's
 * `v-if` — it renders nothing until the engine sets an agenda. Live updates ride the
 * reactive `discussion` prop (engine advances the index → `discussions` re-broadcast).
 */
import { computed } from 'vue'
import type { Discussion } from '@ccc/shared/protocol'
import { agendaProgressView } from '../lib/discussion-view'

const props = defineProps<{ discussion: Discussion | null }>()

const view = computed(() => agendaProgressView(props.discussion))
</script>

<template>
  <div v-if="view.visible" class="agenda-panel" aria-label="Discussion agenda">
    <div class="agenda-head">
      <span class="agenda-title">Agenda</span>
      <span class="agenda-count">{{ view.completed }}/{{ view.total }} ({{ view.percent }}%)</span>
    </div>
    <div class="agenda-bar" role="progressbar" :aria-valuenow="view.percent">
      <div class="agenda-bar-fill" :style="{ width: view.percent + '%' }"></div>
    </div>
    <div
      v-for="it in view.items"
      :key="it.index"
      class="agenda-row"
      :class="'agenda-' + it.status"
      :title="it.text"
    >
      <span class="agenda-mark">{{
        it.status === 'done' ? '✓' : it.status === 'current' ? '▶' : '○'
      }}</span>
      <span class="agenda-subject">{{ it.text }}</span>
    </div>
  </div>
</template>
