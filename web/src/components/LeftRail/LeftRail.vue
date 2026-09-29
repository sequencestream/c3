<script setup lang="ts">
/* 桌面系统导航竖条。工作台页面各有独立入口，连接、升级、设置与账户固定在底部。 */
import { computed, ref } from 'vue'
import type { SelfUpdateState, UpdateStatus } from '@ccc/shared/protocol'
import type { WorkcenterPage } from '@/controls/state'
import { useTypedI18n } from '@/i18n'
import { useAuth } from '@/composables/useAuth'
import { useIsMobile } from '@/composables/useBreakpoint'
import { logsUrl } from '@/lib/logs-route'
import ConfirmDialog from '@/components/ConfirmDialog/ConfirmDialog.vue'

const { t } = useTypedI18n()
const { isAdmin, subject } = useAuth()
const isMobile = useIsMobile()
const logsHref = logsUrl(window.location)
const RELEASES_URL = 'https://github.com/sequencestream/c3/releases/latest'

const props = defineProps<{
  status: 'connecting' | 'open' | 'closed'
  viewMode: 'workspace' | 'workcenter'
  systemSettingsOpen?: boolean
  personalizedSettingOpen?: boolean
  workcenterPage?: WorkcenterPage
  workcenterPendingCount?: number
  showLogout?: boolean
  updateStatus?: UpdateStatus | null
  selfUpdate?: SelfUpdateState | null
}>()

const emit = defineEmits<{
  'enter-workspace': []
  'select-workcenter-page': [page: WorkcenterPage]
  'open-personalized-setting': []
  'open-settings': []
  'start-self-update': []
  'apply-self-update': []
  logout: []
}>()

const pendingCount = computed(() => props.workcenterPendingCount ?? 0)
const downloadPercent = computed(() => {
  const update = props.selfUpdate
  if (!update || update.totalBytes <= 0) return 0
  return Math.min(100, Math.round((update.downloadedBytes / update.totalBytes) * 100))
})

type UpdateActionKind =
  'link' | 'download' | 'progress' | 'restart' | 'pending' | 'applying' | 'retry'

const updateAction = computed<{ kind: UpdateActionKind; text: string } | null>(() => {
  const update = props.selfUpdate
  const latest = props.updateStatus?.latestVersion ?? null
  const target = update?.targetVersion ?? latest
  const phase = update?.phase ?? 'idle'

  if (phase === 'applying') return { kind: 'applying', text: t('nav.update.restarting') }
  if (phase === 'ready' && target) {
    return isAdmin.value
      ? { kind: 'restart', text: t('nav.update.restart', { version: target }) }
      : { kind: 'pending', text: t('nav.update.pendingAdmin', { version: target }) }
  }
  if ((phase === 'downloading' || phase === 'verifying') && target) {
    return {
      kind: 'progress',
      text: t('nav.update.downloading', { version: target, percent: downloadPercent.value }),
    }
  }
  if (props.updateStatus?.available !== true || !latest) return null
  if (update?.capable && isAdmin.value) {
    return phase === 'failed'
      ? { kind: 'retry', text: t('nav.update.failed', { version: latest }) }
      : { kind: 'download', text: t('nav.update.download', { version: latest }) }
  }
  return { kind: 'link', text: t('nav.update.available', { version: latest }) }
})

const restartConfirmOpen = ref(false)

function onUpdateClick(): void {
  const kind = updateAction.value?.kind
  if (kind === 'restart') restartConfirmOpen.value = true
  else if (kind === 'download' || kind === 'retry') emit('start-self-update')
}

function confirmRestart(): void {
  restartConfirmOpen.value = false
  emit('apply-self-update')
}
</script>

<template>
  <nav v-if="!isMobile" class="left-rail" :aria-label="t('nav.rail.ariaLabel')">
    <div class="rail-primary">
      <button
        type="button"
        class="rail-btn"
        :class="{
          active: viewMode === 'workspace' && !systemSettingsOpen && !personalizedSettingOpen,
        }"
        :title="t('nav.viewMode.workspace')"
        :aria-label="t('nav.viewMode.workspace')"
        data-testid="rail-workspace"
        @click="emit('enter-workspace')"
      >
        <svg class="rail-icon" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="4" width="18" height="13" rx="1.5" />
          <path d="M9 20h6M12 17v3M7 8h7M7 11h10M7 14h5" />
        </svg>
      </button>

      <button
        type="button"
        class="rail-btn"
        :class="{
          active:
            viewMode === 'workcenter' &&
            workcenterPage === 'notifications' &&
            !systemSettingsOpen &&
            !personalizedSettingOpen,
        }"
        :title="t('dashboard.nav.notifications')"
        :aria-label="t('dashboard.nav.notifications')"
        data-testid="rail-notifications"
        @click="emit('select-workcenter-page', 'notifications')"
      >
        <svg class="rail-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7Z" />
          <path d="M13.7 19a2 2 0 0 1-3.4 0" />
        </svg>
        <span
          v-if="pendingCount > 0"
          class="rail-badge"
          :aria-label="t('dashboard.nav.notificationsBadgeAriaLabel', { count: pendingCount })"
          data-testid="rail-notifications-badge"
          >{{ pendingCount }}</span
        >
      </button>

      <button
        type="button"
        class="rail-btn"
        :class="{
          active:
            viewMode === 'workcenter' &&
            workcenterPage === 'dashboard' &&
            !systemSettingsOpen &&
            !personalizedSettingOpen,
        }"
        :title="t('dashboard.nav.dashboard')"
        :aria-label="t('dashboard.nav.dashboard')"
        data-testid="rail-dashboard"
        @click="emit('select-workcenter-page', 'dashboard')"
      >
        <svg class="rail-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 13h6V4H4v9Zm10 7h6v-9h-6v9ZM4 20h6v-3H4v3Zm10-13h6V4h-6v3Z" />
        </svg>
      </button>

      <button
        type="button"
        class="rail-btn"
        :class="{
          active:
            viewMode === 'workcenter' &&
            workcenterPage === 'robots' &&
            !systemSettingsOpen &&
            !personalizedSettingOpen,
        }"
        :title="t('dashboard.nav.robots')"
        :aria-label="t('dashboard.nav.robots')"
        data-testid="rail-robots"
        @click="emit('select-workcenter-page', 'robots')"
      >
        <svg class="rail-icon" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="4" y="7" width="16" height="12" rx="3" />
          <path d="M12 3v4M9 12h.01M15 12h.01M8 16h8" />
        </svg>
      </button>
    </div>

    <div class="rail-utilities">
      <a
        v-if="updateAction?.kind === 'link'"
        class="rail-btn rail-update"
        :href="RELEASES_URL"
        target="_blank"
        rel="noopener noreferrer"
        :title="updateAction.text"
        :aria-label="updateAction.text"
        data-testid="rail-update-link"
      >
        <svg class="rail-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14" />
        </svg>
      </a>
      <button
        v-else-if="updateAction"
        type="button"
        class="rail-btn rail-update"
        :class="{ error: updateAction.kind === 'retry' }"
        :disabled="['progress', 'pending', 'applying'].includes(updateAction.kind)"
        :title="updateAction.text"
        :aria-label="updateAction.text"
        data-testid="rail-update-action"
        @click="onUpdateClick"
      >
        <svg class="rail-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14" />
        </svg>
      </button>

      <button
        type="button"
        class="rail-btn"
        :class="{ active: personalizedSettingOpen }"
        :title="t('nav.personalizedSetting.tooltip')"
        :aria-label="t('nav.personalizedSetting.tooltip')"
        data-testid="rail-personalized-setting"
        @click="emit('open-personalized-setting')"
      >
        <svg class="rail-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 7h6M14 7h6M4 17h10M18 17h2" />
          <circle cx="12" cy="7" r="2" />
          <circle cx="16" cy="17" r="2" />
        </svg>
      </button>

      <button
        v-if="isAdmin"
        type="button"
        class="rail-btn"
        :class="{ active: systemSettingsOpen }"
        :title="t('nav.settings.tooltip')"
        :aria-label="t('nav.settings.tooltip')"
        data-testid="rail-settings"
        @click="emit('open-settings')"
      >
        <svg class="rail-icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path
            d="M19 15a2 2 0 0 0 .4 2l-2.8 2.8a2 2 0 0 0-2-.4A2 2 0 0 0 13 21h-2a2 2 0 0 0-1.6-1.6 2 2 0 0 0-2 .4L4.6 17a2 2 0 0 0 .4-2A2 2 0 0 0 3 13v-2a2 2 0 0 0 2-1 2 2 0 0 0-.4-2l2.8-2.8a2 2 0 0 0 2 .4A2 2 0 0 0 11 3h2a2 2 0 0 0 1.6 1.6 2 2 0 0 0 2-.4L19.4 7a2 2 0 0 0-.4 2 2 2 0 0 0 2 2v2a2 2 0 0 0-2 2Z"
          />
        </svg>
      </button>

      <details v-if="showLogout" class="rail-account">
        <summary
          class="rail-btn"
          :title="t('auth.account.tooltip')"
          :aria-label="t('auth.account.tooltip')"
          data-testid="rail-account"
        >
          <svg class="rail-icon" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="8" r="4" />
            <path d="M5 21a7 7 0 0 1 14 0" />
          </svg>
        </summary>
        <div class="rail-popover">
          <div v-if="subject" class="rail-account-name" :title="subject">{{ subject }}</div>
          <button type="button" class="rail-popover-action" @click="emit('logout')">
            {{ t('auth.logout.label') }}
          </button>
        </div>
      </details>

      <a
        class="rail-btn rail-status"
        :class="status === 'open' ? 'ok' : 'error'"
        :href="logsHref"
        target="_blank"
        rel="noopener noreferrer"
        :title="t('nav.logs.tooltip')"
        :aria-label="`${t('nav.logs.tooltip')}: ${status}`"
        data-testid="rail-logs-link"
      >
        <svg class="rail-icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="8" />
          <circle cx="12" cy="12" r="2" />
        </svg>
      </a>
    </div>

    <ConfirmDialog
      :open="restartConfirmOpen"
      :title="t('nav.update.confirmRestart.title')"
      :message="t('nav.update.confirmRestart.message')"
      :confirm-label="t('nav.update.confirmRestart.confirm')"
      :cancel-label="t('common.action.cancel.label')"
      danger
      @confirm="confirmRestart"
      @cancel="restartConfirmOpen = false"
    />
  </nav>
</template>

<style scoped>
.left-rail {
  width: 56px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--sp-2) 0;
  background: var(--c-panel);
  border-right: 1px solid var(--c-border);
}
.rail-primary,
.rail-utilities {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-2);
}
.rail-utilities {
  margin-top: auto;
}
.rail-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  color: var(--c-text-muted);
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition:
    color var(--dur-fast) var(--ease-standard),
    background-color var(--dur-fast) var(--ease-standard);
}
.rail-btn:hover:not(:disabled),
.rail-btn.active {
  color: var(--c-primary-text);
  background: var(--c-card);
}
.rail-btn:disabled {
  cursor: default;
  opacity: 0.45;
}
.rail-icon {
  width: 20px;
  height: 20px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.rail-badge {
  position: absolute;
  top: -4px;
  right: -5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  color: var(--c-badge-ink);
  background: var(--c-error-text);
  border: 1px solid var(--c-panel);
  border-radius: 999px;
  font-size: 9px;
  font-weight: 600;
  line-height: 1;
}
.rail-update,
.rail-status.ok {
  color: var(--c-primary-text);
}
.rail-btn.error {
  color: var(--c-error-text);
}
.rail-account {
  position: relative;
}
.rail-account > summary {
  list-style: none;
}
.rail-account > summary::-webkit-details-marker {
  display: none;
}
.rail-popover {
  position: absolute;
  left: calc(100% + var(--sp-3));
  bottom: 0;
  z-index: 120;
  min-width: 180px;
  max-width: 280px;
  padding: var(--sp-2);
  display: grid;
  gap: var(--sp-1);
  background: var(--c-panel);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-md);
}
.rail-account-name {
  padding: var(--sp-1) var(--sp-2);
  color: var(--c-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rail-popover-action {
  min-height: 32px;
  padding: 0 var(--sp-3);
  color: var(--c-text);
  text-align: left;
  background: transparent;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.rail-popover-action:hover {
  background: var(--c-card);
}
</style>
