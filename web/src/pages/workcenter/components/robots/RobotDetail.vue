<script setup lang="ts">
// Right column of the chat-robot page: what this robot is configured to do, and
// what it has actually done.
//
// The enable control is the one place in c3 where a user authorizes data to leave
// the machine, so it never flips directly: it opens a dialog that states exactly
// what is sent (ADR-0046). Confirming records the acknowledgement the server
// requires — the server refuses to enable without it, so skipping this dialog
// cannot turn a robot on.
import { computed, ref, watch } from 'vue'
import { useTypedI18n } from '@/i18n'
import ConfirmDialog from '@/components/ConfirmDialog/ConfirmDialog.vue'
import RobotIdentityAdmin from './RobotIdentityAdmin.vue'
import RobotWriteGrants from './RobotWriteGrants.vue'
import type {
  ImGroupWorkspaceGrant,
  ImIdentityBinding,
  ImRobot,
  ImRobotTurnLog,
  RobotWritableCapability,
  WorkspaceInfo,
} from '@ccc/shared/protocol'

const { t } = useTypedI18n()

const props = defineProps<{
  robot: ImRobot | null
  turns: ImRobotTurnLog[]
  isAdmin: boolean
  workspaces?: WorkspaceInfo[]
  imIdentityBindings?: ImIdentityBinding[]
  imGroupWorkspaceScopes?: ImGroupWorkspaceGrant[]
}>()

const emit = defineEmits<{
  (e: 'edit', robotId: string): void
  (e: 'delete', robotId: string): void
  (e: 'disable', robotId: string): void
  (e: 'enable', robotId: string): void
  (e: 'adminRevokeImIdentity', bindingId: string): void
  (e: 'loadImGroupScopes', chatId: string): void
  (e: 'saveImGroupScopes', chatId: string, workspaceNames: string[]): void
  (e: 'acknowledgeWriteGrant', capability: RobotWritableCapability): void
  (e: 'setWriteGrantEnabled', capability: RobotWritableCapability, enabled: boolean): void
}>()

const enableOpen = ref(false)
const deleteOpen = ref(false)

type DetailTab = 'basic' | 'recent'
const activeTab = ref<DetailTab>('basic')

watch(
  () => props.robot?.id,
  () => {
    activeTab.value = 'basic'
  },
)

const OUTCOME_LABEL = {
  complete: 'robot.detail.turns.outcome.complete.label',
  error: 'robot.detail.turns.outcome.error.label',
  blocked: 'robot.detail.turns.outcome.blocked.label',
  timeout: 'robot.detail.turns.outcome.timeout.label',
  guard_refused: 'robot.detail.turns.outcome.guard_refused.label',
  input_rejected: 'robot.detail.turns.outcome.input_rejected.label',
  busy: 'robot.detail.turns.outcome.busy.label',
  identity_required: 'robot.detail.turns.outcome.identity_required.label',
  scope_changed: 'robot.detail.turns.outcome.scope_changed.label',
} as const

/** Read-only unless the robot was deliberately widened; that is the default. */
const permissionText = computed(() =>
  props.robot && props.robot.toolAllowlist.length > 0
    ? props.robot.toolAllowlist.join(', ')
    : t('robot.detail.readonly.label'),
)

/** The robot's directory. A path, not copy — bound rather than written inline. */
const workdirPath = computed(() => (props.robot ? `~/.c3/robots/${props.robot.name}` : ''))

const reachText = computed(() =>
  props.robot?.requireMention ? t('robot.detail.mentionOnly') : t('robot.detail.anyGroup'),
)

function formatTime(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString() : '—'
}

function confirmEnable(): void {
  enableOpen.value = false
  if (props.robot) emit('enable', props.robot.id)
}

function confirmDelete(): void {
  deleteOpen.value = false
  if (props.robot) emit('delete', props.robot.id)
}
</script>

<template>
  <div v-if="!robot" class="rb-detail empty">
    <p class="rb-hint">{{ t('robot.detail.empty') }}</p>
  </div>

  <div v-else class="rb-detail">
    <header class="rb-head">
      <h2 class="rb-title">{{ robot.name }}</h2>
      <div v-if="isAdmin" class="rb-actions">
        <button
          type="button"
          class="rb-btn"
          data-testid="robot-edit"
          @click="emit('edit', robot.id)"
        >
          {{ t('robot.detail.edit.label') }}
        </button>
        <button
          v-if="robot.enabled"
          type="button"
          class="rb-btn"
          data-testid="robot-disable"
          @click="emit('disable', robot.id)"
        >
          {{ t('robot.detail.disable.label') }}
        </button>
        <button
          v-else
          type="button"
          class="rb-btn primary"
          data-testid="robot-enable"
          @click="enableOpen = true"
        >
          {{ t('robot.detail.enable.label') }}
        </button>
        <button
          type="button"
          class="rb-btn danger"
          data-testid="robot-delete"
          @click="deleteOpen = true"
        >
          {{ t('robot.detail.delete.label') }}
        </button>
      </div>
    </header>

    <nav
      class="rb-tabs"
      role="tablist"
      :aria-label="t('robot.detail.tabs.label')"
      data-testid="robot-detail-tabs"
    >
      <button
        id="robot-detail-tab-basic"
        type="button"
        class="rb-tab"
        :class="{ active: activeTab === 'basic' }"
        role="tab"
        :aria-selected="activeTab === 'basic'"
        aria-controls="robot-detail-panel-basic"
        data-testid="robot-detail-tab-basic"
        @click="activeTab = 'basic'"
      >
        {{ t('robot.detail.tabs.basic') }}
      </button>
      <button
        id="robot-detail-tab-recent"
        type="button"
        class="rb-tab"
        :class="{ active: activeTab === 'recent' }"
        role="tab"
        :aria-selected="activeTab === 'recent'"
        aria-controls="robot-detail-panel-recent"
        data-testid="robot-detail-tab-recent"
        @click="activeTab = 'recent'"
      >
        {{ t('robot.detail.tabs.recent') }}
      </button>
    </nav>

    <section
      v-if="activeTab === 'basic'"
      id="robot-detail-panel-basic"
      class="rb-panel"
      role="tabpanel"
      aria-labelledby="robot-detail-tab-basic"
      data-testid="robot-detail-panel-basic"
    >
      <dl class="rb-meta">
        <dt>{{ t('robot.detail.agent.label') }}</dt>
        <dd>{{ robot.vendor }} · {{ robot.agentId }}</dd>
        <dt>{{ t('robot.detail.permission.label') }}</dt>
        <dd data-testid="robot-permission">{{ permissionText }}</dd>
        <dt>{{ t('robot.detail.reach.label') }}</dt>
        <dd>{{ reachText }}</dd>
        <dt>{{ t('robot.detail.workdir.label') }}</dt>
        <dd class="rb-path">{{ workdirPath }}</dd>
      </dl>

      <RobotWriteGrants
        v-if="isAdmin"
        :robot="robot"
        @acknowledge="emit('acknowledgeWriteGrant', $event)"
        @set-enabled="(cap, enabled) => emit('setWriteGrantEnabled', cap, enabled)"
      />

      <RobotIdentityAdmin
        v-if="isAdmin"
        :robot="robot"
        :bindings="imIdentityBindings ?? []"
        :group-grants="imGroupWorkspaceScopes ?? []"
        :workspaces="workspaces ?? []"
        @revoke-binding="emit('adminRevokeImIdentity', $event)"
        @load-group-scopes="emit('loadImGroupScopes', $event)"
        @save-group-scopes="(chatId, names) => emit('saveImGroupScopes', chatId, names)"
      />
    </section>

    <section
      v-else
      id="robot-detail-panel-recent"
      class="rb-panel rb-turns"
      role="tabpanel"
      aria-labelledby="robot-detail-tab-recent"
      data-testid="robot-detail-panel-recent"
    >
      <h3 class="rb-turns-title">{{ t('robot.detail.turns.title') }}</h3>
      <p v-if="turns.length === 0" class="rb-hint">{{ t('robot.detail.turns.empty') }}</p>
      <table v-else class="rb-turns-table">
        <tbody>
          <tr v-for="turn in turns" :key="turn.id">
            <td class="rb-turn-time">{{ formatTime(turn.startedAt) }}</td>
            <td>
              <span v-if="turn.outcome" class="rb-outcome" :class="turn.outcome">
                {{ t(OUTCOME_LABEL[turn.outcome]) }}
              </span>
            </td>
            <td class="rb-turn-chars">{{ turn.outboundChars }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <ConfirmDialog
      :open="enableOpen"
      :title="t('robot.enable.confirm.title')"
      :message="`${t('robot.enable.confirm.message')}\n\n${t('robot.enable.confirm.scope')}`"
      :confirm-label="t('robot.enable.confirm.confirm.label')"
      :cancel-label="t('common.action.cancel.label')"
      @confirm="confirmEnable"
      @cancel="enableOpen = false"
    />
    <ConfirmDialog
      :open="deleteOpen"
      danger
      :title="t('robot.delete.confirm.title')"
      :message="t('robot.delete.confirm.message')"
      :confirm-label="t('common.action.delete.label')"
      :cancel-label="t('common.action.cancel.label')"
      @confirm="confirmDelete"
      @cancel="deleteOpen = false"
    />
  </div>
</template>

<style scoped>
.rb-detail {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
  flex: 1;
}
.rb-detail.empty {
  justify-content: center;
  align-items: center;
}
.rb-hint {
  color: var(--c-text-muted);
  font-size: 13px;
  margin: 0;
}
.rb-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.rb-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}
.rb-actions {
  margin-left: auto;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.rb-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--c-border);
}
.rb-tab {
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--c-text-muted);
  padding: 6px 10px;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
}
.rb-tab.active {
  border-bottom-color: var(--c-primary);
  color: var(--c-primary);
}
.rb-tab:focus-visible {
  outline: 2px solid var(--c-primary);
  outline-offset: 2px;
}
.rb-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.rb-btn {
  border: 1px solid var(--c-border);
  background: var(--c-input);
  color: var(--c-text);
  border-radius: 6px;
  padding: 4px 10px;
  cursor: pointer;
  font-size: 13px;
}
.rb-btn.primary {
  border-color: var(--c-primary);
  color: var(--c-primary);
}
.rb-btn.danger {
  border-color: var(--c-error);
  color: var(--c-error);
}
.rb-meta {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 16px;
  margin: 0;
  font-size: 13px;
}
.rb-meta dt {
  color: var(--c-text-muted);
}
.rb-meta dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}
.rb-path {
  font-family: var(--font-mono, monospace);
}
.rb-turns-title {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
}
.rb-turns-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.rb-turns-table td {
  padding: 4px 8px;
  border-bottom: 1px solid var(--c-border);
}
.rb-turn-time {
  color: var(--c-text-muted);
  white-space: nowrap;
}
.rb-turn-chars {
  text-align: right;
  color: var(--c-text-muted);
}
.rb-outcome.complete {
  color: var(--c-success);
}
.rb-outcome.error,
.rb-outcome.guard_refused {
  color: var(--c-error);
}
.rb-outcome.blocked,
.rb-outcome.timeout,
.rb-outcome.busy {
  color: var(--c-warning);
}
</style>
