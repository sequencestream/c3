<script setup lang="ts">
// Create / edit a chat robot. Modelled on the automation form, which already
// established the "vendor + agent (or agent group) + preset permission" shape for
// unattended work; a robot needs the same execution identity plus its platform
// credentials and the reach settings.
//
// Two fields behave differently from the rest and both are deliberate:
//   - `name` is only editable on create. It is also the working directory name,
//     so renaming would orphan every thread's history.
//   - `appSecret` is write-only. Left blank on an edit, the stored secret stays;
//     it is never sent back to the browser, so there is nothing to prefill.
import { computed, ref, watch } from 'vue'
import { useTypedI18n } from '@/i18n'
import { groupAgentsOfVendor } from '@/lib/group-agents'
import { IM_DM_MODES, IM_PLATFORMS, VENDOR_IDS } from '@ccc/shared/protocol'
import type {
  AgentConfig,
  ImDmMode,
  ImPlatform,
  ImRobot,
  RobotConfigInput,
  VendorId,
} from '@ccc/shared/protocol'

const { t } = useTypedI18n()

const props = defineProps<{
  open: boolean
  /** The robot being edited, or null when creating. */
  robot: ImRobot | null
  agents: AgentConfig[]
}>()

const emit = defineEmits<{
  (e: 'create', name: string, platform: ImPlatform, config: RobotConfigInput): void
  (e: 'update', robotId: string, config: RobotConfigInput): void
  (e: 'cancel'): void
}>()

const name = ref('')
const platform = ref<ImPlatform>('feishu')
const appId = ref('')
const appSecret = ref('')
const vendor = ref<VendorId>('claude')
const agentId = ref('')
const toolAllowlist = ref('')
const requireMention = ref(true)
const chatAllowlist = ref('')
const dmMode = ref<ImDmMode>('disabled')
const dmAllowlist = ref('')
const maxTurnMs = ref('')

const isEdit = computed(() => props.robot !== null)

/** Real agents of the chosen vendor, plus its virtual group agents (ADR-0029). */
const agentOptions = computed(() => {
  const real = props.agents
    .filter((a) => a.vendor === vendor.value && a.enabled !== false)
    .map((a) => ({ id: a.id, label: a.displayName || a.id }))
  const groups = groupAgentsOfVendor(props.agents, vendor.value).map((g) => ({
    id: g.id,
    label: g.group,
  }))
  return [...real, ...groups]
})

const canSave = computed(() => {
  if (!agentId.value) return false
  if (isEdit.value) return true
  return name.value.trim().length > 0 && appId.value.trim().length > 0 && appSecret.value.length > 0
})

/** Reset the draft each time the dialog opens, so nothing leaks between edits. */
watch(
  () => [props.open, props.robot?.id],
  () => {
    if (!props.open) return
    const r = props.robot
    name.value = r?.name ?? ''
    platform.value = r?.platform ?? 'feishu'
    appId.value = r?.appId ?? ''
    appSecret.value = ''
    vendor.value = r?.vendor ?? 'claude'
    agentId.value = r?.agentId ?? ''
    toolAllowlist.value = (r?.toolAllowlist ?? []).join('\n')
    requireMention.value = r?.requireMention ?? true
    chatAllowlist.value = (r?.chatAllowlist ?? []).join('\n')
    dmMode.value = r?.dmMode ?? 'disabled'
    dmAllowlist.value = (r?.dmAllowlist ?? []).join('\n')
    maxTurnMs.value = r?.maxTurnMs ? String(r.maxTurnMs) : ''
  },
  { immediate: true },
)

function lines(value: string): string[] {
  return value
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

function draft(): RobotConfigInput {
  const limit = Number(maxTurnMs.value.trim())
  return {
    appId: appId.value.trim(),
    // Omitted on an edit that left it blank, which keeps the stored secret.
    ...(appSecret.value ? { appSecret: appSecret.value } : {}),
    vendor: vendor.value,
    agentId: agentId.value,
    toolAllowlist: lines(toolAllowlist.value),
    requireMention: requireMention.value,
    chatAllowlist: lines(chatAllowlist.value),
    dmMode: dmMode.value,
    dmAllowlist: lines(dmAllowlist.value),
    maxTurnMs: maxTurnMs.value.trim() && Number.isFinite(limit) ? limit : null,
  }
}

function submit(): void {
  if (!canSave.value) return
  if (props.robot) emit('update', props.robot.id, draft())
  else emit('create', name.value.trim(), platform.value, { ...draft(), appSecret: appSecret.value })
}

const DM_LABEL = {
  disabled: 'robot.form.dmMode.disabled.label',
  allowlist: 'robot.form.dmMode.allowlist.label',
  open: 'robot.form.dmMode.open.label',
} as const
</script>

<template>
  <div v-if="open" class="rf-overlay" @click.self="emit('cancel')">
    <div class="rf-panel" role="dialog" aria-modal="true">
      <h2 class="rf-title">
        {{ isEdit ? t('robot.form.edit.title') : t('robot.form.create.title') }}
      </h2>

      <div class="rf-body">
        <label class="rf-field">
          <span class="rf-label">{{ t('robot.form.name.label') }}</span>
          <input v-model="name" :disabled="isEdit" data-testid="robot-name" />
          <span class="rf-hint">{{ t('robot.form.name.hint') }}</span>
        </label>

        <label class="rf-field">
          <span class="rf-label">{{ t('robot.form.platform.label') }}</span>
          <select v-model="platform" :disabled="isEdit">
            <option v-for="p in IM_PLATFORMS" :key="p" :value="p">{{ p }}</option>
          </select>
        </label>

        <label class="rf-field">
          <span class="rf-label">{{ t('robot.form.appId.label') }}</span>
          <input v-model="appId" data-testid="robot-app-id" />
        </label>

        <label class="rf-field">
          <span class="rf-label">{{ t('robot.form.appSecret.label') }}</span>
          <input
            v-model="appSecret"
            type="password"
            :placeholder="isEdit ? t('robot.form.appSecret.placeholder') : ''"
            data-testid="robot-app-secret"
          />
          <span class="rf-hint">{{ t('robot.form.appSecret.hint') }}</span>
        </label>

        <label class="rf-field">
          <span class="rf-label">{{ t('robot.form.vendor.label') }}</span>
          <select v-model="vendor" data-testid="robot-vendor">
            <option v-for="v in VENDOR_IDS" :key="v" :value="v">{{ v }}</option>
          </select>
        </label>

        <label class="rf-field">
          <span class="rf-label">{{ t('robot.form.agent.label') }}</span>
          <select v-model="agentId" data-testid="robot-agent">
            <option value="" disabled></option>
            <option v-for="a in agentOptions" :key="a.id" :value="a.id">{{ a.label }}</option>
          </select>
        </label>

        <label class="rf-field">
          <span class="rf-label">{{ t('robot.form.tools.label') }}</span>
          <textarea v-model="toolAllowlist" rows="3" data-testid="robot-tools"></textarea>
          <span class="rf-hint">{{ t('robot.form.tools.hint') }}</span>
        </label>

        <label class="rf-check">
          <input v-model="requireMention" type="checkbox" data-testid="robot-require-mention" />
          <span>{{ t('robot.form.requireMention.label') }}</span>
        </label>

        <label class="rf-field">
          <span class="rf-label">{{ t('robot.form.chatAllowlist.label') }}</span>
          <textarea v-model="chatAllowlist" rows="2"></textarea>
          <span class="rf-hint">{{ t('robot.form.chatAllowlist.hint') }}</span>
        </label>

        <label class="rf-field">
          <span class="rf-label">{{ t('robot.form.dmMode.label') }}</span>
          <select v-model="dmMode" data-testid="robot-dm-mode">
            <option v-for="m in IM_DM_MODES" :key="m" :value="m">{{ t(DM_LABEL[m]) }}</option>
          </select>
        </label>

        <label v-if="dmMode === 'allowlist'" class="rf-field">
          <span class="rf-label">{{ t('robot.form.dmAllowlist.label') }}</span>
          <textarea v-model="dmAllowlist" rows="2"></textarea>
          <span class="rf-hint">{{ t('robot.form.dmAllowlist.hint') }}</span>
        </label>

        <label class="rf-field">
          <span class="rf-label">{{ t('robot.form.maxTurnMs.label') }}</span>
          <input v-model="maxTurnMs" inputmode="numeric" />
          <span class="rf-hint">{{ t('robot.form.maxTurnMs.hint') }}</span>
        </label>
      </div>

      <footer class="rf-foot">
        <button type="button" class="rf-btn" @click="emit('cancel')">
          {{ t('common.action.cancel.label') }}
        </button>
        <button
          type="button"
          class="rf-btn primary"
          :disabled="!canSave"
          data-testid="robot-save"
          @click="submit"
        >
          {{ t('robot.form.save.label') }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.rf-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 900;
  padding: 16px;
}
.rf-panel {
  background: var(--c-bg);
  color: var(--c-text);
  border: 1px solid var(--c-border);
  border-radius: 10px;
  width: min(50vw, 560px);
  min-width: 320px;
  max-height: 88vh;
  display: flex;
  flex-direction: column;
}
.rf-title {
  margin: 0;
  padding: 14px 16px;
  font-size: 15px;
  font-weight: 600;
  border-bottom: 1px solid var(--c-border);
}
.rf-body {
  padding: 14px 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.rf-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.rf-label {
  font-size: 13px;
  color: var(--c-text-muted);
}
.rf-hint {
  font-size: 12px;
  color: var(--c-text-muted);
}
.rf-check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
input,
select,
textarea {
  background: var(--c-input);
  color: var(--c-text);
  border: 1px solid var(--c-border);
  border-radius: 6px;
  padding: 6px 8px;
  font: inherit;
  width: 100%;
}
textarea {
  resize: vertical;
}
.rf-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--c-border);
}
.rf-btn {
  border: 1px solid var(--c-border);
  background: var(--c-input);
  color: var(--c-text);
  border-radius: 6px;
  padding: 6px 14px;
  cursor: pointer;
  font-size: 13px;
}
.rf-btn.primary {
  border-color: var(--c-primary);
  color: var(--c-primary);
}
.rf-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
@media (max-width: 767px) {
  .rf-overlay {
    padding: 0;
  }
  .rf-panel {
    width: 100%;
    height: 100%;
    max-height: none;
    border-radius: 0;
  }
}
</style>
