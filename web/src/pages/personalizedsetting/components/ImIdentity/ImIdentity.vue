<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTypedI18n } from '@/i18n'
import ConfirmDialog from '@/components/ConfirmDialog/ConfirmDialog.vue'
import type { ImIdentityChallengeCreated, ImRobot } from '@ccc/shared/protocol'
import type { MyImIdentityView } from '@/controls/state'

const { t, d } = useTypedI18n()

const props = withDefaults(
  defineProps<{
    identity: MyImIdentityView | null
    robots: ImRobot[]
    created?: ImIdentityChallengeCreated | null
  }>(),
  { created: null },
)

const emit = defineEmits<{
  create: [robotId: string]
  cancel: [challengeId: string]
  revoke: [bindingId: string]
  dismissReveal: []
}>()

const creating = ref(false)
const selectedRobotId = ref('')
const revokeBindingId = ref<string | null>(null)

function robotNamespace(r: ImRobot): string {
  return `${r.platform}:${r.appId}`
}

const bindableRobots = computed(() =>
  props.robots.filter((r) => r.enabled && r.outboundAckAt != null),
)

const boundNamespaces = computed(
  () => new Set(props.identity?.bindings.map((b) => b.accountNamespace) ?? []),
)

/** Robots whose account namespace is not yet bound for this subject. */
const robotsNeedingBind = computed(() =>
  bindableRobots.value.filter((r) => !boundNamespaces.value.has(robotNamespace(r))),
)

const canCreate = computed(
  () => robotsNeedingBind.value.length > 0 && selectedRobotId.value.length > 0,
)

function robotLabel(robotId: string): string {
  return props.robots.find((r) => r.id === robotId)?.name ?? robotId
}

function formatTime(ms: number | null | undefined): string {
  return ms ? d(new Date(ms), 'full') : '—'
}

function startCreate(): void {
  creating.value = true
  selectedRobotId.value = robotsNeedingBind.value[0]?.id ?? ''
}

function submitCreate(): void {
  if (!canCreate.value) return
  creating.value = false
  emit('create', selectedRobotId.value)
}

function confirmRevoke(): void {
  if (revokeBindingId.value) emit('revoke', revokeBindingId.value)
  revokeBindingId.value = null
}
</script>

<template>
  <section class="settings-section" data-testid="im-identity-section">
    <p class="settings-section-title">{{ t('personalizedSetting.imIdentity.title.label') }}</p>
    <p class="settings-hint">{{ t('personalizedSetting.imIdentity.hint') }}</p>
    <p v-if="identity?.noAuthLocalHint" class="settings-hint im-warn">
      {{ t('personalizedSetting.imIdentity.noAuthHint') }}
    </p>

    <template v-if="!identity">
      <p class="settings-hint">{{ t('personalizedSetting.imIdentity.unavailable') }}</p>
    </template>

    <template v-else>
      <div v-if="created" class="im-reveal">
        <p class="settings-section-title">
          {{ t('personalizedSetting.imIdentity.reveal.title') }}
        </p>
        <p class="settings-hint">
          {{
            t('personalizedSetting.imIdentity.reveal.forRobot', {
              name: robotLabel(created.robotId),
            })
          }}
        </p>
        <p class="settings-hint">{{ t('personalizedSetting.imIdentity.reveal.onceOnly') }}</p>
        <div class="im-token-row">
          <span class="settings-hint">{{
            t('personalizedSetting.imIdentity.reveal.token.label')
          }}</span>
          <code class="im-token" data-testid="im-identity-token">{{ created.token }}</code>
        </div>
        <button type="button" class="primary" @click="emit('dismissReveal')">
          {{ t('personalizedSetting.imIdentity.reveal.dismiss.label') }}
        </button>
      </div>

      <div v-if="identity.bindings.length > 0" class="im-bound-list">
        <p class="settings-section-title">
          {{ t('personalizedSetting.imIdentity.bound.title') }}
        </p>
        <div v-for="binding in identity.bindings" :key="binding.id" class="im-bound">
          <p class="settings-hint">
            {{ t('personalizedSetting.imIdentity.bound.namespace') }}:
            {{ binding.accountNamespace }}
          </p>
          <p class="settings-hint">
            {{
              t('personalizedSetting.imIdentity.bound.verified', {
                time: formatTime(binding.verifiedAt),
              })
            }}
          </p>
          <button type="button" class="ghost danger" @click="revokeBindingId = binding.id">
            {{ t('personalizedSetting.imIdentity.revoke.label') }}
          </button>
        </div>
      </div>

      <div v-if="identity.pendingChallenges.length > 0" class="im-pending-list">
        <p v-for="ch in identity.pendingChallenges" :key="ch.challengeId" class="im-pending">
          <span class="settings-section-title">{{
            t('personalizedSetting.imIdentity.pending.title')
          }}</span>
          <span class="settings-hint">
            {{ robotLabel(ch.robotId) }} · {{ ch.accountNamespace }}
          </span>
          <span class="settings-hint">
            {{
              t('personalizedSetting.imIdentity.pending.expires', {
                time: formatTime(ch.expiresAt),
              })
            }}
          </span>
          <button type="button" class="ghost" @click="emit('cancel', ch.challengeId)">
            {{ t('personalizedSetting.imIdentity.pending.cancel.label') }}
          </button>
        </p>
      </div>

      <template v-if="!created">
        <p
          v-if="robotsNeedingBind.length === 0 && identity.bindings.length === 0"
          class="settings-hint"
        >
          {{ t('personalizedSetting.imIdentity.noRobot') }}
        </p>
        <p v-else-if="robotsNeedingBind.length === 0 && !creating" class="settings-hint">
          {{ t('personalizedSetting.imIdentity.allBound') }}
        </p>
        <p
          v-else-if="
            !creating && identity.bindings.length === 0 && identity.pendingChallenges.length === 0
          "
          class="settings-hint"
        >
          {{ t('personalizedSetting.imIdentity.empty') }}
        </p>
        <div v-if="creating" class="im-create">
          <label class="settings-hint">{{ t('personalizedSetting.imIdentity.robot.label') }}</label>
          <select v-model="selectedRobotId" data-testid="im-identity-robot">
            <option disabled value="">
              {{ t('personalizedSetting.imIdentity.robot.placeholder') }}
            </option>
            <option v-for="r in robotsNeedingBind" :key="r.id" :value="r.id">
              {{ r.name }} ({{ robotNamespace(r) }})
            </option>
          </select>
          <div class="im-actions">
            <button type="button" class="ghost" @click="creating = false">
              {{ t('common.action.cancel.label') }}
            </button>
            <button
              type="button"
              class="primary"
              :disabled="!canCreate"
              data-testid="im-identity-create"
              @click="submitCreate"
            >
              {{ t('personalizedSetting.imIdentity.create.submit.label') }}
            </button>
          </div>
        </div>
        <button
          v-else-if="robotsNeedingBind.length > 0"
          type="button"
          class="ghost"
          data-testid="im-identity-create-open"
          @click="startCreate"
        >
          {{ t('personalizedSetting.imIdentity.create.label') }}
        </button>
      </template>
    </template>

    <ConfirmDialog
      :open="revokeBindingId !== null"
      danger
      :title="t('personalizedSetting.imIdentity.revoke.confirm.title')"
      :message="t('personalizedSetting.imIdentity.revoke.confirm.body')"
      :confirm-label="t('personalizedSetting.imIdentity.revoke.confirm.confirm.label')"
      :cancel-label="t('common.action.cancel.label')"
      @confirm="confirmRevoke"
      @cancel="revokeBindingId = null"
    />
  </section>
</template>

<style scoped>
.im-warn {
  color: var(--c-warning-text);
}
.im-reveal,
.im-bound,
.im-pending,
.im-create,
.im-bound-list,
.im-pending-list {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.im-bound {
  padding-bottom: 8px;
  border-bottom: 1px solid var(--c-border);
}
.im-pending {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--c-border);
}
.im-token-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.im-token {
  word-break: break-all;
  padding: 8px;
  border-radius: 6px;
  background: var(--c-surface-2, rgba(127, 127, 127, 0.12));
}
.im-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
select {
  max-width: 360px;
}
</style>
