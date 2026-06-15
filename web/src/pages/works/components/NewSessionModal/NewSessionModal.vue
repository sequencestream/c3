<script setup lang="ts">
/*
 * NewSessionModal.vue — 新建会话的 vendor / agent 选择弹窗(ADR-0015 / ADR-0012)。
 *
 * 点「+」不再直接建会话,而是先选定承载它的 agent。默认 "Auto":不写 intent,
 * 服务端首跑回落 defaultAgentId。选定某 vendor 后再从该 vendor 的 agent 里挑一个,
 * 选定的 agent 作为 pending 会话的 intent 随 create_session 上送。
 *
 * host-binary 缺失的 vendor(其 CLI 不在 PATH)在 vendor 下拉里灰显并标注原因,
 * 无法选中;底部给出「前往检测面板」入口(emit goto-settings)。
 * presentational:确认/取消/跳转均上抛,实际建会话由 App 处理。
 */
import { computed, ref, watch } from 'vue'
import type { AgentConfig, VendorHostStatus, VendorId } from '@ccc/shared/protocol'
import { VENDOR_COLOR, VENDOR_LABEL } from '@/lib/vendor'
import { useTypedI18n } from '@/i18n'

const { t } = useTypedI18n()

const props = defineProps<{
  open: boolean
  agents: AgentConfig[]
  defaultAgentId: string | null
  hostStatus: VendorHostStatus[]
}>()

const emit = defineEmits<{
  /** Confirm: the chosen agent id, or null for Auto (inherit the default). */
  confirm: [agentId: string | null]
  close: []
  /** "binary not in PATH" → jump to the settings detection panel. */
  'goto-settings': []
}>()

// Stable vendor order so the dropdown is deterministic regardless of agent order.
const VENDOR_ORDER: VendorId[] = ['claude', 'codex', 'opencode']

// '' = Auto (inherit defaultAgentId); otherwise the chosen vendor.
const vendor = ref<'' | VendorId>('')
const agentId = ref<string>('')

// Only enabled agents are pickable (a disabled agent is still a valid *fallback*
// server-side, but the explicit picker offers the active roster only). Sorted by
// the user-controlled global order (`order_seq`), mirroring the server roster.
const enabledAgents = computed(() =>
  props.agents
    .filter((a) => a.enabled !== false)
    .sort((a, b) => (a.order_seq ?? 0) - (b.order_seq ?? 0)),
)

// The vendors that actually have an enabled agent, in canonical order.
const vendorsWithAgents = computed(() =>
  VENDOR_ORDER.filter((v) => enabledAgents.value.some((a) => a.vendor === v)),
)

// vendor → host-CLI present. A vendor with no probe entry is treated as present
// (unknown ⇒ don't falsely block); an explicit `present:false` greys it out.
const presentByVendor = computed(() => {
  const m = new Map<VendorId, boolean>()
  for (const h of props.hostStatus) m.set(h.vendor, h.present)
  return m
})

function vendorPresent(v: VendorId): boolean {
  return presentByVendor.value.get(v) !== false
}

// The vendor option's label — brand name, with a "binary not in PATH" suffix when
// its host CLI is missing. Built here so the template carries no string literals.
function vendorOptionLabel(v: VendorId): string {
  return vendorPresent(v)
    ? VENDOR_LABEL[v]
    : `${VENDOR_LABEL[v]} — ${t('session.new.missing.suffix')}`
}

// The agents of the currently-chosen vendor (empty when Auto).
const agentsOfVendor = computed(() =>
  vendor.value === '' ? [] : enabledAgents.value.filter((a) => a.vendor === vendor.value),
)

// The default agent's display name + vendor, for the Auto hint + dot.
const defaultAgent = computed(() =>
  props.defaultAgentId ? (props.agents.find((a) => a.id === props.defaultAgentId) ?? null) : null,
)

// The effective vendor whose colour the dot shows: the chosen one, or (for Auto)
// the default agent's vendor.
const effectiveVendor = computed<VendorId | null>(() =>
  vendor.value === '' ? (defaultAgent.value?.vendor ?? null) : vendor.value,
)

const dotColor = computed(() =>
  effectiveVendor.value ? VENDOR_COLOR[effectiveVendor.value] : null,
)

// Vendors that have agents but whose CLI is missing — drives the bottom warning.
const missingVendors = computed(() => vendorsWithAgents.value.filter((v) => !vendorPresent(v)))

// Reset to Auto each time the modal opens.
watch(
  () => props.open,
  (open) => {
    if (open) {
      vendor.value = ''
      agentId.value = ''
    }
  },
)

// When a vendor is chosen, default to its first enabled agent.
watch(vendor, (v) => {
  if (v === '') {
    agentId.value = ''
    return
  }
  const first = agentsOfVendor.value[0]
  agentId.value = first ? first.id : ''
})

function onVendorChange(e: Event): void {
  const v = (e.target as HTMLSelectElement).value as '' | VendorId
  // Guard: a disabled (missing-binary) option can't be selected via keyboard in
  // practice, but normalize anyway — fall back to Auto if it somehow lands there.
  vendor.value = v !== '' && !vendorPresent(v) ? '' : v
}

const canCreate = computed(() => vendor.value === '' || agentId.value !== '')

function onCreate(): void {
  if (!canCreate.value) return
  emit('confirm', vendor.value === '' ? null : agentId.value)
}
</script>

<template>
  <div v-if="open" class="ns-overlay" @click.self="emit('close')">
    <div class="ns-modal" role="dialog" aria-modal="true" data-testid="new-session-modal">
      <div class="ns-head">
        <h2>
          <span
            v-if="dotColor"
            class="vendor-dot"
            :style="{ backgroundColor: dotColor }"
            :title="effectiveVendor ? VENDOR_LABEL[effectiveVendor] : ''"
          ></span>
          {{ t('session.new.title') }}
        </h2>
        <button
          class="ns-icon-btn"
          :title="t('common.action.close.tooltip')"
          @click="emit('close')"
        >
          ✕
        </button>
      </div>

      <div class="ns-body">
        <label class="ns-field">
          <span class="ns-label">{{ t('session.new.vendor.label') }}</span>
          <select
            class="ns-select"
            :value="vendor"
            data-testid="new-session-vendor"
            @change="onVendorChange"
          >
            <option value="">{{ t('session.new.vendor.auto') }}</option>
            <option
              v-for="v in vendorsWithAgents"
              :key="v"
              :value="v"
              :disabled="!vendorPresent(v)"
              :title="vendorPresent(v) ? VENDOR_LABEL[v] : t('session.new.missing.suffix')"
            >
              {{ vendorOptionLabel(v) }}
            </option>
          </select>
        </label>

        <label class="ns-field">
          <span class="ns-label">{{ t('session.new.agent.label') }}</span>
          <select
            v-if="vendor !== ''"
            v-model="agentId"
            class="ns-select"
            data-testid="new-session-agent"
          >
            <option v-for="a in agentsOfVendor" :key="a.id" :value="a.id">
              {{ a.displayName }}
            </option>
          </select>
          <span v-else class="ns-hint" data-testid="new-session-auto-hint">
            {{
              defaultAgent
                ? t('session.new.agent.autoHint', { name: defaultAgent.displayName })
                : t('session.new.agent.autoHintNoDefault')
            }}
          </span>
        </label>

        <div v-if="missingVendors.length > 0" class="ns-missing" data-testid="new-session-missing">
          <span class="ns-missing-text">{{ t('session.new.missing.hint') }}</span>
          <button
            type="button"
            class="ns-link"
            data-testid="new-session-goto-settings"
            @click="emit('goto-settings')"
          >
            {{ t('session.new.missing.gotoDetection') }}
          </button>
        </div>
      </div>

      <div class="ns-foot">
        <button type="button" class="ns-btn" @click="emit('close')">
          {{ t('session.new.cancel') }}
        </button>
        <button
          type="button"
          class="ns-btn ns-btn-primary"
          :disabled="!canCreate"
          data-testid="new-session-create"
          @click="onCreate"
        >
          {{ t('session.new.create') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ns-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
}
.ns-modal {
  width: 24rem;
  max-width: 90vw;
  max-height: 80vh;
  overflow: auto;
  background: var(--c-panel);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md, 8px);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.3);
  display: flex;
  flex-direction: column;
}
.ns-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--c-border);
}
.ns-head h2 {
  margin: 0;
  font-size: var(--fs-title-sm);
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.ns-icon-btn {
  background: none;
  border: none;
  color: var(--c-text-dim);
  cursor: pointer;
  font-size: 1rem;
}
.ns-body {
  padding: var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.ns-field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.ns-label {
  font-size: var(--fs-body-sm);
  color: var(--c-text-dim);
}
.ns-select {
  padding: var(--sp-2);
  background: var(--c-bg);
  color: var(--c-text);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm, 4px);
}
.ns-hint {
  font-size: var(--fs-body-sm);
  color: var(--c-text-dim);
}
.ns-missing {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-2);
  font-size: var(--fs-body-sm);
  color: var(--c-warn, #c08a00);
}
.ns-link {
  background: none;
  border: none;
  padding: 0;
  color: var(--c-accent, #4a8);
  cursor: pointer;
  text-decoration: underline;
  font-size: inherit;
}
.ns-foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4);
  border-top: 1px solid var(--c-border);
}
.ns-btn {
  padding: var(--sp-2) var(--sp-3);
  background: var(--c-bg);
  color: var(--c-text);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
}
.ns-btn-primary {
  background: var(--c-accent, #4a8);
  border-color: var(--c-accent, #4a8);
  color: #fff;
}
.ns-btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.vendor-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}

@media (max-width: 767px) {
  .ns-overlay {
    align-items: stretch;
    justify-content: stretch;
    background: var(--c-panel);
  }

  .ns-modal {
    width: 100vw;
    max-width: none;
    height: 100dvh;
    max-height: none;
    border: 0;
    border-radius: 0;
    box-shadow: none;
  }

  .ns-head {
    flex-shrink: 0;
    padding: calc(var(--sp-3) + env(safe-area-inset-top)) var(--sp-4) var(--sp-3);
  }

  .ns-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: var(--sp-4);
  }

  .ns-foot {
    flex-shrink: 0;
    padding: var(--sp-3) var(--sp-4) calc(var(--sp-3) + env(safe-area-inset-bottom));
  }
}
</style>
