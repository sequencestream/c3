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
const revokeOpen = ref(false)

const bindableRobots = computed(() =>
  props.robots.filter((r) => r.enabled && r.outboundAckAt != null),
)

const canCreate = computed(
  () => bindableRobots.value.length > 0 && selectedRobotId.value.length > 0,
)

function formatTime(ms: number | null | undefined): string {
  return ms ? d(new Date(ms), 'full') : '—'
}

function startCreate(): void {
  creating.value = true
  selectedRobotId.value = bindableRobots.value[0]?.id ?? ''
}

function submitCreate(): void {
  if (!canCreate.value) return
  creating.value = false
  emit('create', selectedRobotId.value)
}

function confirmRevoke(): void {
  revokeOpen.value = false
  const id = props.identity?.binding?.id
  if (id) emit('revoke', id)
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

      <div v-if="identity.binding" class="im-bound">
        <p class="settings-section-title">
          {{ t('personalizedSetting.imIdentity.bound.title') }}
        </p>
        <p class="settings-hint">
          {{ t('personalizedSetting.imIdentity.bound.namespace') }}:
          {{ identity.binding.accountNamespace }}
        </p>
        <p class="settings-hint">
          {{
            t('personalizedSetting.imIdentity.bound.verified', {
              time: formatTime(identity.binding.verifiedAt),
            })
          }}
        </p>
        <button type="button" class="ghost danger" @click="revokeOpen = true">
          {{ t('personalizedSetting.imIdentity.revoke.label') }}
        </button>
      </div>

      <div v-else-if="identity.pendingChallenge" class="im-pending">
        <p class="settings-section-title">
          {{ t('personalizedSetting.imIdentity.pending.title') }}
        </p>
        <p class="settings-hint">
          {{
            t('personalizedSetting.imIdentity.pending.expires', {
              time: formatTime(identity.pendingChallenge.expiresAt),
            })
          }}
        </p>
        <button
          type="button"
          class="ghost"
          @click="emit('cancel', identity.pendingChallenge.challengeId)"
        >
          {{ t('personalizedSetting.imIdentity.pending.cancel.label') }}
        </button>
      </div>

      <template v-else-if="!created">
        <p v-if="bindableRobots.length === 0" class="settings-hint">
          {{ t('personalizedSetting.imIdentity.noRobot') }}
        </p>
        <p v-else-if="!creating" class="settings-hint">
          {{ t('personalizedSetting.imIdentity.empty') }}
        </p>
        <div v-if="creating" class="im-create">
          <label class="settings-hint">{{ t('personalizedSetting.imIdentity.robot.label') }}</label>
          <select v-model="selectedRobotId" data-testid="im-identity-robot">
            <option disabled value="">
              {{ t('personalizedSetting.imIdentity.robot.placeholder') }}
            </option>
            <option v-for="r in bindableRobots" :key="r.id" :value="r.id">
              {{ r.name }}
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
          v-else-if="bindableRobots.length > 0"
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
      :open="revokeOpen"
      danger
      :title="t('personalizedSetting.imIdentity.revoke.confirm.title')"
      :message="t('personalizedSetting.imIdentity.revoke.confirm.body')"
      :confirm-label="t('personalizedSetting.imIdentity.revoke.confirm.confirm.label')"
      :cancel-label="t('common.action.cancel.label')"
      @confirm="confirmRevoke"
      @cancel="revokeOpen = false"
    />
  </section>
</template>

<style scoped>
.im-warn {
  color: var(--c-warning, #b45309);
}
.im-reveal,
.im-bound,
.im-pending,
.im-create {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
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
  max-width: 320px;
}
</style>
