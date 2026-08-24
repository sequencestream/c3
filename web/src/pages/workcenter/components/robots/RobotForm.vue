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
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { QrcodeSvg } from 'qrcode.vue'
import { useTypedI18n, type LocaleKey } from '@/i18n'
import { groupAgentsOfVendor } from '@/lib/group-agents'
import { IM_DM_MODES, IM_PLATFORMS, VENDOR_IDS } from '@ccc/shared/protocol'
import type {
  AgentConfig,
  ImDmMode,
  ImPlatform,
  ImRobot,
  RobotConfigInput,
  RobotMessageLocale,
  ToolManifestEntry,
  VendorId,
} from '@ccc/shared/protocol'
import { ROBOT_MESSAGE_LOCALES } from '@ccc/shared/protocol'
import ToolPermissionGrid from '@/components/ToolPermissionGrid/ToolPermissionGrid.vue'
import { isFeishuRegistrationActive } from '@/controls/state'
import type { FeishuAppRegistrationState } from '@/controls/state'

const { t } = useTypedI18n()

const props = defineProps<{
  open: boolean
  /** The robot being edited, or null when creating. */
  robot: ImRobot | null
  agents: AgentConfig[]
  /** Tool manifest per vendor (cached by App.vue; no workspace scope — a robot
   *  is not bound to one, so its manifest is the vendor's built-ins plus c3's
   *  own MCP tools, with no `mcp__<server>__` workspace namespaces). */
  toolManifest: Record<string, ToolManifestEntry[] | null>
  toolManifestLoading: boolean
  toolManifestError: string | null
  /** One-click Feishu app registration view state (controls-owned). */
  feishuRegistration: FeishuAppRegistrationState
}>()

const emit = defineEmits<{
  (e: 'create', name: string, platform: ImPlatform, config: RobotConfigInput): void
  (e: 'update', robotId: string, config: RobotConfigInput): void
  (e: 'cancel'): void
  (e: 'load-tool-manifest', vendor: string): void
  (e: 'start-feishu-registration', platform: ImPlatform): void
  (e: 'cancel-feishu-registration'): void
  (e: 'clear-feishu-registration'): void
}>()

const name = ref('')
const platform = ref<ImPlatform>('feishu')
const appId = ref('')
const appSecret = ref('')
const vendor = ref<VendorId>('claude')
const agentId = ref('')
// Real tool names plus, possibly, the `network-access` pseudo-entry. Seeded from
// the manifest (read-only tools pre-checked on create) or restored from the robot.
const toolAllowlist = ref<string[]>([])
// Tracks whether the open-watch has restored the persisted vendor/agent, so a
// real vendor change clears the tool selection but the initial restore does not.
const vendorInitialised = ref(false)
const requireMention = ref(true)
const chatAllowlist = ref('')
const dmMode = ref<ImDmMode>('disabled')
const dmAllowlist = ref('')
const maxTurnMs = ref('')
/** Empty string = system default (null). */
const locale = ref<'' | RobotMessageLocale>('')
/** Countdown clock while the QR is being shown; drives display only. */
const now = ref(Date.now())
let countdownTimer: ReturnType<typeof setInterval> | null = null
const copyLabel = ref<'label' | 'copied'>('label')

const LOCALE_LABELS: Record<RobotMessageLocale, string> = {
  en: 'English',
  zh: '中文',
  ja: '日本語',
  ko: '한국어',
  ru: 'Русский',
}

const isEdit = computed(() => props.robot !== null)

/** The one-click entry exists only in Feishu CREATE mode (edit keeps manual
 *  credentials and never touches an existing app). */
const showFeishuOneClick = computed(() => props.robot === null && platform.value === 'feishu')
const feishuActive = computed(() => isFeishuRegistrationActive(props.feishuRegistration))
const feishuRemainingSeconds = computed(() => {
  if (!props.feishuRegistration.expiresAt) return 0
  return Math.max(0, Math.ceil((props.feishuRegistration.expiresAt - now.value) / 1000))
})

const FEISHU_SCOPES: { scope: string; labelKey: LocaleKey }[] = [
  {
    scope: 'im:message:send_as_bot',
    labelKey: 'robot.form.feishuRegistration.scopes.sendAsBot',
  },
  {
    scope: 'im:message.group_at_msg:readonly',
    labelKey: 'robot.form.feishuRegistration.scopes.groupAtRead',
  },
  {
    scope: 'im:message.p2p_msg:readonly',
    labelKey: 'robot.form.feishuRegistration.scopes.p2pRead',
  },
  {
    scope: 'application:bot.basic_info:read',
    labelKey: 'robot.form.feishuRegistration.scopes.botBasicInfoRead',
  },
  {
    scope: 'im.message.receive_v1',
    labelKey: 'robot.form.feishuRegistration.scopes.event',
  },
]

const FEISHU_FAILED_LABELS: Record<
  NonNullable<FeishuAppRegistrationState['failedReason']>,
  LocaleKey
> = {
  denied: 'robot.form.feishuRegistration.failed.denied',
  expired: 'robot.form.feishuRegistration.failed.expired',
  cancelled: 'robot.form.feishuRegistration.failed.cancelled',
  unsupported_region: 'robot.form.feishuRegistration.failed.unsupportedRegion',
  network_error: 'robot.form.feishuRegistration.failed.networkError',
  server_error: 'robot.form.feishuRegistration.failed.serverError',
}

function stopCountdown(): void {
  if (countdownTimer) {
    clearInterval(countdownTimer)
    countdownTimer = null
  }
}

function startCountdown(): void {
  stopCountdown()
  now.value = Date.now()
  countdownTimer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
}

watch(
  () => props.feishuRegistration.phase,
  (phase, prev) => {
    if (phase === 'waiting_scan' || phase === 'slow_down') startCountdown()
    else stopCountdown()
    // Backfill credentials exactly once, when a credential-bearing result
    // arrives. The countdown and the QR live purely in controls state; this
    // component only mirrors them into the draft, which stays editable.
    if (
      (phase === 'ready' || phase === 'manual_setup_required') &&
      prev !== 'ready' &&
      prev !== 'manual_setup_required'
    ) {
      const r = props.feishuRegistration
      if (r.appId && r.appSecret) {
        appId.value = r.appId
        appSecret.value = r.appSecret
      }
    }
  },
)

onBeforeUnmount(stopCountdown)

/**
 * The user touched a credential after a result: drop the result hint and the
 * registration reference. Backfilling by the form itself is a programmatic
 * write and never triggers this (the input event does not fire for it).
 */
function onCredentialEdited(): void {
  const phase = props.feishuRegistration.phase
  if (phase === 'ready' || phase === 'manual_setup_required') {
    emit('clear-feishu-registration')
  }
}

/** Close the dialog AND cancel any live registration in one gesture. */
function close(): void {
  emit('cancel')
  emit('cancel-feishu-registration')
}

async function copyVerificationUrl(): Promise<void> {
  const url = props.feishuRegistration.verificationUrl
  if (!url) return
  try {
    await navigator.clipboard?.writeText(url)
    copyLabel.value = 'copied'
    setTimeout(() => {
      copyLabel.value = 'label'
    }, 1500)
  } catch {
    // No clipboard access (permissions, non-secure context): the URL stays
    // visible and selectable, nothing else to do.
  }
}

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
  () => [props.open, props.robot?.id] as const,
  () => {
    if (!props.open) return
    const r = props.robot
    name.value = r?.name ?? ''
    platform.value = r?.platform ?? 'feishu'
    appId.value = r?.appId ?? ''
    appSecret.value = ''
    vendor.value = r?.vendor ?? 'claude'
    agentId.value = r?.agentId ?? ''
    toolAllowlist.value = r?.toolAllowlist ? [...r.toolAllowlist] : []
    requireMention.value = r?.requireMention ?? true
    chatAllowlist.value = (r?.chatAllowlist ?? []).join('\n')
    dmMode.value = r?.dmMode ?? 'disabled'
    dmAllowlist.value = (r?.dmAllowlist ?? []).join('\n')
    maxTurnMs.value = r?.maxTurnMs ? String(r.maxTurnMs) : ''
    locale.value = r?.locale ?? ''
    vendorInitialised.value = true
    // Load the initial vendor's manifest; the vendor watcher below won't fire if
    // the restore happens to equal the default, leaving the grid permanently blank.
    emit('load-tool-manifest', vendor.value)
  },
  { immediate: true },
)

// Vendor switch: clear the previous vendor's tool selection (a tool name that
// exists for one vendor must never leak onto another) and load the new vendor's
// manifest. The initial restore of an existing robot's vendor is not a change.
watch(vendor, (v) => {
  const isInitialExistingVendor = props.robot !== null && v === props.robot.vendor
  if (vendorInitialised.value && !isInitialExistingVendor) {
    agentId.value = ''
    toolAllowlist.value = []
    emit('load-tool-manifest', v)
  }
})

// Whether the allowlist selects at least one of the vendor's LOCAL write/exec
// tools. Mirrors the server's `selectsLocalWriteTool`: a c3 MCP write tool runs
// inside the c3 server behind its own domain guards, so it must never be what
// opens a writable codex sandbox (and with it, the network boundary).
function selectsLocalWriteTool(): boolean {
  const tools = props.toolManifest[vendor.value] ?? []
  return tools.some(
    (t) => t.isWrite && !t.name.startsWith('mcp__') && toolAllowlist.value.includes(t.name),
  )
}

// The codex sandbox is `read-only` (network-denied) exactly when no local write
// tool is selected — the same derivation the dispatcher applies at run time, so
// the switch never offers a network that the runtime would silently drop.
const networkAccessBlocked = computed(() => vendor.value === 'codex' && !selectsLocalWriteTool())

// Derive default selections when a fresh manifest arrives on CREATE: a new robot
// is read-only by default — real read tools checked, write/exec tools unchecked,
// network off. Editing never seeds: the allowlist was restored from the robot and
// must be preserved verbatim, including an intentionally-empty one (a failed or
// empty manifest therefore cannot wipe a saved allowlist).
watch(
  () => props.toolManifest[vendor.value],
  (manifest) => {
    if (!manifest) return
    if (props.robot === null && toolAllowlist.value.length === 0) {
      toolAllowlist.value = manifest.filter((t) => !t.isWrite).map((t) => t.name)
    }
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
    toolAllowlist: [...toolAllowlist.value],
    requireMention: requireMention.value,
    chatAllowlist: lines(chatAllowlist.value),
    dmMode: dmMode.value,
    dmAllowlist: lines(dmAllowlist.value),
    maxTurnMs: maxTurnMs.value.trim() && Number.isFinite(limit) ? limit : null,
    locale: locale.value === '' ? null : locale.value,
  }
}

function submit(): void {
  if (!canSave.value) return
  // A credential-bearing result is consumed by the create/update; drop the
  // registration reference so the next open starts clean.
  if (
    props.feishuRegistration.phase === 'ready' ||
    props.feishuRegistration.phase === 'manual_setup_required'
  ) {
    emit('clear-feishu-registration')
  }
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
  <div v-if="open" class="rf-overlay" @click.self="close">
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
          <div class="rf-app-id-row">
            <input
              v-model="appId"
              :disabled="feishuActive"
              data-testid="robot-app-id"
              @input="onCredentialEdited"
            />
            <button
              v-if="showFeishuOneClick"
              type="button"
              class="rf-btn rf-btn-secondary"
              :disabled="feishuActive"
              data-testid="feishu-one-click"
              @click="emit('start-feishu-registration', platform)"
            >
              {{ t('robot.form.feishuRegistration.create.label') }}
            </button>
          </div>
        </label>

        <div
          v-if="showFeishuOneClick && feishuRegistration.phase !== 'idle'"
          class="rf-feishu-reg"
          data-testid="feishu-registration-panel"
        >
          <template v-if="feishuRegistration.phase === 'starting'">
            <p class="rf-feishu-status" data-testid="feishu-status-starting">
              {{ t('robot.form.feishuRegistration.starting.label') }}
            </p>
          </template>

          <template
            v-else-if="
              feishuRegistration.phase === 'waiting_scan' ||
              feishuRegistration.phase === 'slow_down'
            "
          >
            <h3 class="rf-feishu-title" data-testid="feishu-waiting-title">
              {{ t('robot.form.feishuRegistration.waitingScan.title') }}
            </h3>
            <p
              v-if="feishuRegistration.phase === 'slow_down'"
              class="rf-feishu-status"
              data-testid="feishu-status-slow-down"
            >
              {{ t('robot.form.feishuRegistration.slowDown.label') }}
            </p>
            <div class="rf-feishu-qr">
              <QrcodeSvg
                v-if="feishuRegistration.verificationUrl"
                :value="feishuRegistration.verificationUrl"
                :size="180"
                data-testid="feishu-qr"
              />
            </div>
            <a
              class="rf-feishu-url"
              :href="feishuRegistration.verificationUrl ?? '#'"
              target="_blank"
              rel="noreferrer"
              data-testid="feishu-url"
            >
              {{ feishuRegistration.verificationUrl }}
            </a>
            <div class="rf-feishu-row">
              <button
                type="button"
                class="rf-btn rf-btn-secondary"
                data-testid="feishu-copy"
                @click="copyVerificationUrl"
              >
                {{
                  copyLabel === 'copied'
                    ? t('robot.form.feishuRegistration.waitingScan.copy.copied')
                    : t('robot.form.feishuRegistration.waitingScan.copy.label')
                }}
              </button>
              <span class="rf-feishu-countdown" data-testid="feishu-countdown">
                {{
                  t('robot.form.feishuRegistration.waitingScan.expiresIn', {
                    seconds: feishuRemainingSeconds,
                  })
                }}
              </span>
            </div>
            <div class="rf-feishu-scopes" data-testid="feishu-scopes">
              <h4 class="rf-feishu-scopes-title">
                {{ t('robot.form.feishuRegistration.scopes.title') }}
              </h4>
              <ul>
                <li v-for="item in FEISHU_SCOPES" :key="item.scope">
                  <code>{{ item.scope }}</code>
                  — {{ t(item.labelKey) }}
                </li>
              </ul>
              <p class="rf-feishu-warning" data-testid="feishu-scope-warning">
                {{ t('robot.form.feishuRegistration.scopes.warning') }}
              </p>
            </div>
            <button
              type="button"
              class="rf-btn rf-btn-secondary"
              data-testid="feishu-cancel"
              @click="close"
            >
              {{ t('robot.form.feishuRegistration.cancel.label') }}
            </button>
          </template>

          <template v-else-if="feishuRegistration.phase === 'configuring'">
            <p class="rf-feishu-status" data-testid="feishu-status-configuring">
              {{ t('robot.form.feishuRegistration.configuring.label') }}
            </p>
          </template>

          <template v-else-if="feishuRegistration.phase === 'ready'">
            <p class="rf-feishu-status" data-testid="feishu-status-ready">
              {{ t('robot.form.feishuRegistration.ready.label') }}
            </p>
          </template>

          <template v-else-if="feishuRegistration.phase === 'manual_setup_required'">
            <h3 class="rf-feishu-title" data-testid="feishu-manual-title">
              {{ t('robot.form.feishuRegistration.manualSetup.title') }}
            </h3>
            <p class="rf-feishu-warning" data-testid="feishu-manual-warning">
              {{ t('robot.form.feishuRegistration.manualSetup.warning') }}
            </p>
            <ol class="rf-feishu-steps">
              <li>{{ t('robot.form.feishuRegistration.manualSetup.step1') }}</li>
              <li>{{ t('robot.form.feishuRegistration.manualSetup.step2') }}</li>
            </ol>
            <a
              class="rf-feishu-url"
              href="https://open.feishu.cn/app"
              target="_blank"
              rel="noreferrer"
              data-testid="feishu-manual-console"
            >
              {{ t('robot.form.feishuRegistration.manualSetup.consoleLink') }}
            </a>
          </template>

          <template v-else-if="feishuRegistration.phase === 'failed'">
            <p class="rf-feishu-status" data-testid="feishu-status-failed">
              {{ t(FEISHU_FAILED_LABELS[feishuRegistration.failedReason ?? 'server_error']) }}
            </p>
            <button
              type="button"
              class="rf-btn rf-btn-secondary"
              data-testid="feishu-cancel"
              @click="close"
            >
              {{ t('robot.form.feishuRegistration.cancel.label') }}
            </button>
          </template>
        </div>

        <label class="rf-field">
          <span class="rf-label">{{ t('robot.form.appSecret.label') }}</span>
          <input
            v-model="appSecret"
            type="password"
            :disabled="feishuActive"
            :placeholder="isEdit ? t('robot.form.appSecret.placeholder') : ''"
            data-testid="robot-app-secret"
            @input="onCredentialEdited"
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

        <!-- The shared permission grid: read/write checklist, select-all/clear-all,
         and the codex-only network switch. The robot form keeps the caller-owned
         meaning — read-only default seeding, sandbox-derived network block. -->
        <ToolPermissionGrid
          :tools="toolManifest[vendor] ?? []"
          :model-value="toolAllowlist"
          :loading="toolManifestLoading"
          :error="toolManifestError"
          :show-network-access="vendor === 'codex'"
          :network-access-blocked="networkAccessBlocked"
          @update:model-value="toolAllowlist = $event"
        />

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
          <span class="rf-label">{{ t('robot.form.locale.label') }}</span>
          <select v-model="locale" data-testid="robot-locale">
            <option value="">{{ t('robot.form.locale.systemDefault.label') }}</option>
            <option v-for="lang in ROBOT_MESSAGE_LOCALES" :key="lang" :value="lang">
              {{ LOCALE_LABELS[lang] }}
            </option>
          </select>
          <span class="rf-hint">{{ t('robot.form.locale.hint') }}</span>
        </label>

        <label class="rf-field">
          <span class="rf-label">{{ t('robot.form.maxTurnMs.label') }}</span>
          <input v-model="maxTurnMs" inputmode="numeric" />
          <span class="rf-hint">{{ t('robot.form.maxTurnMs.hint') }}</span>
        </label>
      </div>

      <footer class="rf-foot">
        <button type="button" class="rf-btn" @click="close">
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
  /* Desktop: half the viewport width (spec: the editing window is one half of
     the page), so the tool grid has room to lay out in columns. */
  width: 50vw;
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
.rf-btn-secondary {
  flex: none;
}
.rf-app-id-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.rf-feishu-reg {
  margin-top: 8px;
  padding: 12px;
  border: 1px solid var(--c-border);
  border-radius: 8px;
  background: var(--c-bg-subtle, var(--c-input));
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
}
.rf-feishu-title {
  margin: 0;
  font-size: 14px;
}
.rf-feishu-qr {
  align-self: center;
}
.rf-feishu-url {
  word-break: break-all;
  font-size: 12px;
}
.rf-feishu-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.rf-feishu-countdown {
  font-variant-numeric: tabular-nums;
}
.rf-feishu-scopes {
  width: 100%;
  padding: 8px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
}
.rf-feishu-scopes-title {
  margin: 0 0 4px;
  font-size: 12px;
}
.rf-feishu-scopes ul {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.rf-feishu-warning {
  margin: 6px 0 0;
  color: var(--c-warning-text);
  font-size: 12px;
}
.rf-feishu-steps {
  margin: 0;
  padding-left: 18px;
}
.rf-feishu-status {
  margin: 0;
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
