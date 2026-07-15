<script setup lang="ts">
// Workcenter Dashboard: a cross-workspace overview table (running sessions,
// session/intent/discussion/automation totals, and the automation master gate).
// Each row carries its own slide switch that flips that workspace's gate directly
// (admin only); a viewer sees the same state as a read-only badge. Presentational:
// all state and the server round-trips live in the controls layer; this only
// renders props and emits intent. The table degrades to stacked, labelled cards on
// narrow screens (each cell carries its column label via `data-label`).
import { computed } from 'vue'
import { useTypedI18n } from '@/i18n'
import type { WorkspaceDashboardRow } from '@ccc/shared/protocol'

const { t } = useTypedI18n()

const props = defineProps<{
  rows: WorkspaceDashboardRow[]
  loading: boolean
  refreshFailed: boolean
  pending: Set<string>
  isAdmin: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle', workspaceId: string, enabled: boolean): void
  (e: 'refresh'): void
}>()

const isEmpty = computed(() => !props.loading && props.rows.length === 0)
</script>

<template>
  <div class="dashboard">
    <header class="dash-head">
      <h2 class="dash-title">{{ t('dashboard.title') }}</h2>
    </header>

    <div v-if="refreshFailed" class="dash-banner" role="alert" data-testid="dash-banner">
      <span>{{ t('dashboard.refreshFailed') }}</span>
      <button type="button" class="dash-retry" data-testid="dash-retry" @click="emit('refresh')">
        {{ t('dashboard.retry') }}
      </button>
    </div>

    <p v-if="loading && rows.length === 0" class="dash-hint">{{ t('dashboard.loading') }}</p>
    <p v-else-if="isEmpty" class="dash-hint">{{ t('dashboard.empty') }}</p>

    <table v-else class="dash-table">
      <thead>
        <tr>
          <th scope="col">{{ t('dashboard.column.workspace') }}</th>
          <th scope="col" class="dash-num">{{ t('dashboard.column.running') }}</th>
          <th scope="col" class="dash-num">{{ t('dashboard.column.sessions') }}</th>
          <th scope="col" class="dash-num">{{ t('dashboard.column.intents') }}</th>
          <th scope="col" class="dash-num">{{ t('dashboard.column.discussions') }}</th>
          <th scope="col" class="dash-num">{{ t('dashboard.column.automations') }}</th>
          <th scope="col">{{ t('dashboard.column.gate') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.workspaceId">
          <td :data-label="t('dashboard.column.workspace')">
            <div class="dash-ws-name">{{ row.name }}</div>
            <div class="dash-ws-path">{{ row.path }}</div>
          </td>
          <td class="dash-num" :data-label="t('dashboard.column.running')">
            {{ row.sessions.running }}
          </td>
          <td class="dash-num" :data-label="t('dashboard.column.sessions')">
            {{ row.sessions.total }}
          </td>
          <td class="dash-num" :data-label="t('dashboard.column.intents')">
            {{ row.intents.total }}
          </td>
          <td class="dash-num" :data-label="t('dashboard.column.discussions')">
            {{ row.discussions.total }}
          </td>
          <td class="dash-num" :data-label="t('dashboard.column.automations')">
            {{ row.automations.total }}
          </td>
          <td :data-label="t('dashboard.column.gate')">
            <button
              v-if="isAdmin"
              type="button"
              class="dash-gate-switch"
              role="switch"
              data-testid="dash-gate-switch"
              :aria-checked="row.automationEnabled"
              :aria-label="t('dashboard.toggle.ariaLabel', { name: row.name })"
              :title="row.automationEnabled ? t('dashboard.gate.on') : t('dashboard.gate.off')"
              :disabled="pending.has(row.workspaceId)"
              @click="emit('toggle', row.workspaceId, !row.automationEnabled)"
            >
              <span class="dash-gate-track" :class="{ on: row.automationEnabled }">
                <span class="dash-gate-thumb"></span>
              </span>
            </button>
            <span
              v-else
              class="dash-gate"
              :class="row.automationEnabled ? 'on' : 'off'"
              :aria-label="row.automationEnabled ? t('dashboard.gate.on') : t('dashboard.gate.off')"
            >
              {{ row.automationEnabled ? t('dashboard.gate.on') : t('dashboard.gate.off') }}
            </span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.dashboard {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  overflow: auto;
}
.dash-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.dash-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--c-text);
}
.dash-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--c-warning);
  border-radius: 6px;
  background: color-mix(in srgb, var(--c-warning) 12%, transparent);
  color: var(--c-text);
  font-size: 13px;
}
.dash-retry {
  padding: 3px 10px;
  font-size: 12px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  background: var(--c-input);
  color: var(--c-text);
  cursor: pointer;
}
.dash-hint {
  color: var(--c-text-muted);
  font-size: 13px;
  padding: 24px 0;
  text-align: center;
}
.dash-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.dash-table th,
.dash-table td {
  padding: 8px 10px;
  text-align: left;
  border-bottom: 1px solid var(--c-border);
}
.dash-table th {
  color: var(--c-text-muted);
  font-weight: 600;
  white-space: nowrap;
}
.dash-num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.dash-ws-name {
  font-weight: 600;
  color: var(--c-text);
}
.dash-ws-path {
  font-size: 11px;
  color: var(--c-text-muted);
  word-break: break-all;
}
/* Read-only gate badge (viewers). */
.dash-gate {
  display: inline-block;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 10px;
}
.dash-gate.on {
  color: var(--c-success);
  background: color-mix(in srgb, var(--c-success) 14%, transparent);
}
.dash-gate.off {
  color: var(--c-text-muted);
  background: var(--c-hover);
}
/* Per-row automation gate: an accessible slide switch (admins). */
.dash-gate-switch {
  display: inline-flex;
  align-items: center;
  padding: 2px;
  background: transparent;
  border: none;
  cursor: pointer;
}
.dash-gate-switch:disabled {
  cursor: default;
  opacity: 0.6;
}
.dash-gate-track {
  position: relative;
  display: inline-block;
  width: 30px;
  height: 16px;
  flex-shrink: 0;
  background: var(--c-hover-strong);
  border-radius: var(--radius-pill);
  transition: background 0.15s ease;
}
.dash-gate-track.on {
  background: var(--c-success);
}
.dash-gate-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  background: #fff;
  border-radius: 50%;
  transition: transform 0.15s ease;
}
.dash-gate-track.on .dash-gate-thumb {
  transform: translateX(14px);
}

/* Narrow screens: the table collapses to labelled cards. */
@media (max-width: 720px) {
  .dash-table,
  .dash-table tbody,
  .dash-table tr,
  .dash-table td {
    display: block;
    width: 100%;
  }
  .dash-table thead {
    display: none;
  }
  .dash-table tr {
    border: 1px solid var(--c-border);
    border-radius: 8px;
    margin-bottom: 10px;
    padding: 6px 10px;
  }
  .dash-table td {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    border-bottom: 1px solid var(--c-border);
    text-align: right;
  }
  .dash-table td:last-child {
    border-bottom: none;
  }
  .dash-table td::before {
    content: attr(data-label);
    color: var(--c-text-muted);
    font-size: 11px;
    text-align: left;
  }
  .dash-num {
    text-align: right;
  }
  .dash-ws-path {
    text-align: right;
  }
}
</style>
