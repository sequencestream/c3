<script setup lang="ts">
// Left column of the chat-robot page: the global roster. Presentational — the
// roster and every round trip live in the controls layer.
//
// Each row shows the one thing an operator checks first: whether the robot is
// actually connected. A disabled robot shows as disabled rather than as a
// connection state, because "not connected" and "deliberately off" are different
// answers to that question.
import { useTypedI18n } from '@/i18n'
import type { ImRobot } from '@ccc/shared/protocol'

const { t } = useTypedI18n()

defineProps<{
  robots: ImRobot[]
  selectedId: string | null
  isAdmin: boolean
}>()

const emit = defineEmits<{
  (e: 'select', robotId: string): void
  (e: 'create'): void
}>()

const STATE_LABEL = {
  idle: 'robot.list.state.idle.label',
  connecting: 'robot.list.state.connecting.label',
  connected: 'robot.list.state.connected.label',
  reconnecting: 'robot.list.state.reconnecting.label',
  failed: 'robot.list.state.failed.label',
} as const
</script>

<template>
  <div class="rb-list">
    <header class="rb-list-head">
      <h2 class="rb-list-title">{{ t('robot.list.title') }}</h2>
      <button
        v-if="isAdmin"
        type="button"
        class="rb-create"
        data-testid="robot-create"
        @click="emit('create')"
      >
        {{ t('robot.list.create.label') }}
      </button>
    </header>

    <p v-if="robots.length === 0" class="rb-empty">{{ t('robot.list.empty') }}</p>

    <ul v-else class="rb-rows">
      <li v-for="robot in robots" :key="robot.id">
        <button
          type="button"
          class="rb-row"
          :class="{ active: robot.id === selectedId }"
          :data-testid="`robot-row-${robot.name}`"
          @click="emit('select', robot.id)"
        >
          <span class="rb-name">{{ robot.name }}</span>
          <span class="rb-platform">{{ robot.platform }}</span>
          <span v-if="!robot.enabled" class="rb-state off">
            {{ t('robot.list.disabled.label') }}
          </span>
          <span
            v-else
            class="rb-state"
            :class="robot.connection?.state ?? 'idle'"
            :data-testid="`robot-state-${robot.name}`"
          >
            {{ t(STATE_LABEL[robot.connection?.state ?? 'idle']) }}
          </span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.rb-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.rb-list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.rb-list-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.rb-create {
  border: 1px solid var(--c-border);
  background: var(--c-input);
  color: var(--c-text);
  border-radius: 6px;
  padding: 4px 10px;
  cursor: pointer;
  font-size: 13px;
}
.rb-empty {
  color: var(--c-text-muted);
  font-size: 13px;
  margin: 8px 0;
}
.rb-rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.rb-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--c-text);
  cursor: pointer;
  text-align: left;
}
.rb-row:hover {
  background: var(--c-input);
}
.rb-row.active {
  border-color: var(--c-primary);
  background: var(--c-input);
}
.rb-name {
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rb-platform {
  color: var(--c-text-muted);
  font-size: 12px;
}
.rb-state {
  margin-left: auto;
  font-size: 12px;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--c-border);
  color: var(--c-text-muted);
  white-space: nowrap;
}
.rb-state.connected {
  border-color: var(--c-success);
  color: var(--c-success);
}
.rb-state.failed {
  border-color: var(--c-error);
  color: var(--c-error);
}
.rb-state.connecting,
.rb-state.reconnecting {
  border-color: var(--c-warning);
  color: var(--c-warning);
}
</style>
