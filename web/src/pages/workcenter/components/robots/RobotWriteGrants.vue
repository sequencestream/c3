<script setup lang="ts">
import { ref } from 'vue'
import { useTypedI18n } from '@/i18n'
import ConfirmDialog from '@/components/ConfirmDialog/ConfirmDialog.vue'
import type { ImRobot, ImRobotWriteGrant, RobotWritableCapability } from '@ccc/shared/protocol'
import { ROBOT_WRITABLE_CAPABILITIES } from '@ccc/shared/protocol'

const WRITABLE = ROBOT_WRITABLE_CAPABILITIES as readonly RobotWritableCapability[]

const props = defineProps<{
  robot: ImRobot
}>()

const emit = defineEmits<{
  (e: 'acknowledge', capability: RobotWritableCapability): void
  (e: 'set-enabled', capability: RobotWritableCapability, enabled: boolean): void
}>()

const { t } = useTypedI18n()
const confirmCap = ref<RobotWritableCapability | null>(null)

function grantFor(cap: RobotWritableCapability): ImRobotWriteGrant | undefined {
  return props.robot.writeGrants.find((g) => g.capability === cap)
}

function statusLabel(status: ImRobotWriteGrant['status']): string {
  return t(`robot.writeGrants.status.${status}.label`)
}

function openAcknowledge(cap: RobotWritableCapability): void {
  confirmCap.value = cap
}

function confirmAcknowledge(): void {
  if (confirmCap.value) emit('acknowledge', confirmCap.value)
  confirmCap.value = null
}
</script>

<template>
  <section class="wg" data-testid="robot-write-grants">
    <h3 class="wg-title">{{ t('robot.writeGrants.title') }}</h3>
    <p class="wg-hint">{{ t('robot.writeGrants.hint') }}</p>
    <ul class="wg-list">
      <li v-for="cap in WRITABLE" :key="cap" class="wg-row">
        <div class="wg-main">
          <span class="wg-cap">{{ t(`robot.writeGrants.capability.${cap}.label`) }}</span>
          <span class="wg-desc">{{ t(`robot.writeGrants.capability.${cap}.description`) }}</span>
        </div>
        <span
          v-if="grantFor(cap)"
          class="wg-status"
          :class="grantFor(cap)!.status"
          data-testid="grant-status"
        >
          {{ statusLabel(grantFor(cap)!.status) }}
        </span>
        <div class="wg-actions">
          <button
            v-if="grantFor(cap)?.status === 'unauthorized' || grantFor(cap)?.status === 'stale'"
            type="button"
            class="wg-btn primary"
            :data-testid="`grant-ack-${cap}`"
            @click="openAcknowledge(cap)"
          >
            {{ t('robot.writeGrants.acknowledge.label') }}
          </button>
          <button
            v-else-if="grantFor(cap)?.status === 'disabled'"
            type="button"
            class="wg-btn"
            :data-testid="`grant-enable-${cap}`"
            @click="emit('set-enabled', cap, true)"
          >
            {{ t('robot.writeGrants.enable.label') }}
          </button>
          <button
            v-else-if="grantFor(cap)?.status === 'active'"
            type="button"
            class="wg-btn"
            :data-testid="`grant-disable-${cap}`"
            @click="emit('set-enabled', cap, false)"
          >
            {{ t('robot.writeGrants.disable.label') }}
          </button>
        </div>
      </li>
    </ul>

    <ConfirmDialog
      :open="confirmCap !== null"
      :title="t('robot.writeGrants.confirm.title')"
      :message="
        confirmCap
          ? `${t('robot.writeGrants.confirm.message')}\n\n${t(`robot.writeGrants.capability.${confirmCap}.description`)}`
          : ''
      "
      :confirm-label="t('robot.writeGrants.acknowledge.label')"
      :cancel-label="t('common.action.cancel.label')"
      @confirm="confirmAcknowledge"
      @cancel="confirmCap = null"
    />
  </section>
</template>

<style scoped>
.wg {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.wg-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.wg-hint {
  margin: 0;
  font-size: 12px;
  color: var(--c-text-muted);
}
.wg-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.wg-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  padding: 8px 10px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
}
.wg-main {
  flex: 1;
  min-width: 160px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.wg-cap {
  font-size: 13px;
  font-weight: 500;
}
.wg-desc {
  font-size: 12px;
  color: var(--c-text-muted);
}
.wg-status {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--c-input);
}
.wg-status.active {
  color: var(--c-success);
}
.wg-status.stale,
.wg-status.unauthorized {
  color: var(--c-warning);
}
.wg-status.disabled {
  color: var(--c-text-muted);
}
.wg-actions {
  margin-left: auto;
}
.wg-btn {
  border: 1px solid var(--c-border);
  background: var(--c-input);
  color: var(--c-text);
  border-radius: 6px;
  padding: 4px 10px;
  cursor: pointer;
  font-size: 12px;
}
.wg-btn.primary {
  border-color: var(--c-primary);
  color: var(--c-primary);
}
</style>
