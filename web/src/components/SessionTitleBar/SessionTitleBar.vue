<script setup lang="ts">
/*
 * SessionTitleBar.vue — 聊天列(.content)顶部的会话标题行:左侧会话标题。
 * 两种用途:
 *  - 「会话」tab(WC-R9):右侧渲染权限模式下拉,模式切换经 set-mode 上抛。
 *  - 需求视图(RM-R3):show-mode=false 不渲染模式选择器(新建沟通会话的 "+"
 *    按钮改由左栏需求列表头部承载)。
 * presentational:所有交互上抛由 App 处理。
 */
import { computed } from 'vue'
import BaseDropdown from '../BaseDropdown/BaseDropdown.vue'
import type {
  CodexPolicy,
  CodexSandboxMode,
  CodexApprovalPolicy,
  ModeToken,
  SessionAgentSwitch,
  VendorId,
} from '@ccc/shared/protocol'
import type { SessionSourceLabel } from '@/lib/session-jump'
import { useTypedI18n } from '@/i18n'
import { VENDOR_COLOR, VENDOR_LABEL } from '@/lib/vendor'

const { t } = useTypedI18n()

const props = withDefaults(
  defineProps<{
    activeTitle: string
    mode?: ModeToken
    modeOptions?: { value: ModeToken; label: string }[]
    showMode?: boolean
    /** The session's resolved agent vendor; absent ⇒ no dot (comm sessions). */
    vendor?: VendorId | null
    /** Codex dual-policy config (2026-06-08); null for non-codex sessions. */
    codexPolicy?: CodexPolicy | null
    /**
     * Same-vendor agent switcher data (ADR-0015): the current agent + the other
     * same-vendor available agents. Always present for real sessions (even with no
     * same-vendor alternative) so the status bar can display the correct agent name.
     * The agent group renders only when there are actually candidates to switch to
     * or the current agent is unavailable.
     */
    agentSwitch?: SessionAgentSwitch | null
    /**
     * The active session's source-button label family (works title bar only):
     * `intent`/`discussion`/`schedule` for owned sessions of that kind, `trace`
     * for work/tool sessions whose owner resolves generically. When set, a button
     * is shown that emits `open-source`; null ⇒ no button (no resolvable source).
     */
    sourceLabel?: SessionSourceLabel | null
  }>(),
  {
    mode: 'default',
    modeOptions: () => [],
    showMode: true,
    vendor: null,
    codexPolicy: null,
    agentSwitch: null,
    sourceLabel: null,
  },
)

// The source button's localized text + aria-label, keyed by label family. Literal
// keys (not a dynamic string) so the i18n gate can verify each one statically.
const SOURCE_TEXT: Record<SessionSourceLabel, () => string> = {
  intent: () => t('session.titleBar.intent.label'),
  discussion: () => t('session.titleBar.discussion.label'),
  schedule: () => t('session.titleBar.schedule.label'),
  trace: () => t('session.titleBar.trace.label'),
}
const SOURCE_ARIA: Record<SessionSourceLabel, () => string> = {
  intent: () => t('session.titleBar.intent.ariaLabel'),
  discussion: () => t('session.titleBar.discussion.ariaLabel'),
  schedule: () => t('session.titleBar.schedule.ariaLabel'),
  trace: () => t('session.titleBar.trace.ariaLabel'),
}
const sourceText = computed(() => (props.sourceLabel ? SOURCE_TEXT[props.sourceLabel]() : ''))
const sourceAria = computed(() => (props.sourceLabel ? SOURCE_ARIA[props.sourceLabel]() : ''))

// The vendor dot's colour + brand label (for its tooltip), or null when no vendor.
const vendorColor = (): string | null => (props.vendor ? VENDOR_COLOR[props.vendor] : null)
const vendorLabel = (): string => (props.vendor ? VENDOR_LABEL[props.vendor] : '')

// Switcher options: the current agent (selected) followed by the same-vendor
// candidates. Cross-vendor agents never reach here — vendor is frozen (AC-R17).
const agentOptions = computed(() => {
  const s = props.agentSwitch
  if (!s) return []
  return [
    { value: s.current.id, label: s.current.displayName },
    ...s.candidates.map((c) => ({ value: c.id, label: c.displayName })),
  ]
})

// Codex sandbox-mode dropdown options (2026-06-08).
const sandboxModeOptions = computed(() => [
  { value: 'workspace-write' as CodexSandboxMode, label: t('codex.sandboxMode.workspaceWrite') },
  { value: 'read-only' as CodexSandboxMode, label: t('codex.sandboxMode.readOnly') },
])

// Codex approval-policy dropdown options (2026-06-08).
const approvalPolicyOptions = computed(() => [
  { value: 'on-request' as CodexApprovalPolicy, label: t('codex.approvalPolicy.onRequest') },
  { value: 'on-failure' as CodexApprovalPolicy, label: t('codex.approvalPolicy.onFailure') },
  { value: 'never' as CodexApprovalPolicy, label: t('codex.approvalPolicy.never') },
])

const emit = defineEmits<{
  'set-mode': [mode: ModeToken]
  'set-codex-policy': [policy: CodexPolicy]
  'set-session-agent': [agentId: string]
  'open-source': []
}>()

function onPickAgent(agentId: string): void {
  if (agentId !== props.agentSwitch?.current.id) emit('set-session-agent', agentId)
}
</script>

<template>
  <div class="session-title-bar">
    <span
      v-if="vendorColor()"
      class="vendor-dot"
      :style="{ backgroundColor: vendorColor() as string }"
      :title="vendorLabel()"
      data-testid="session-vendor-dot"
    ></span>
    <span class="session-title-text" :title="activeTitle">{{ activeTitle }}</span>
    <button
      v-if="sourceLabel"
      type="button"
      class="intent-jump"
      data-testid="session-source-jump"
      :title="sourceAria"
      :aria-label="sourceAria"
      @click="emit('open-source')"
    >
      {{ sourceText }}
    </button>
    <slot name="action" />
    <div v-if="vendor || agentSwitch || showMode" class="right-controls">
      <span v-if="vendor" class="vendor-label" data-testid="session-vendor-label">{{
        vendorLabel()
      }}</span>
      <div
        v-if="agentSwitch && (agentSwitch.candidates.length > 0 || agentSwitch.currentUnavailable)"
        class="agent-group"
      >
        <span
          v-if="agentSwitch.currentUnavailable"
          class="agent-unavailable"
          data-testid="session-agent-unavailable"
          >{{ t('session.titleBar.agent.unavailable', { vendor: vendorLabel() }) }}</span
        >
        <label
          class="agent-switch"
          :title="t('session.titleBar.agent.vendorLocked', { vendor: vendorLabel() })"
        >
          <BaseDropdown
            :model-value="agentSwitch.current.id"
            :options="agentOptions"
            :aria-label="t('session.titleBar.agent.ariaLabel')"
            data-testid="session-agent-switch"
            @update:model-value="onPickAgent"
          />
        </label>
      </div>
      <!-- Codex dual-policy controls (2026-06-08): sandboxMode + approvalPolicy -->
      <template v-if="vendor === 'codex'">
        <label v-if="showMode" class="mode sandbox-mode">
          <BaseDropdown
            :model-value="codexPolicy?.sandboxMode ?? 'workspace-write'"
            :options="sandboxModeOptions"
            :aria-label="t('session.titleBar.sandboxMode.ariaLabel')"
            @update:model-value="
              emit('set-codex-policy', { ...codexPolicy, sandboxMode: $event } as CodexPolicy)
            "
          />
        </label>
        <label v-if="showMode" class="mode approval-policy">
          <BaseDropdown
            :model-value="codexPolicy?.approvalPolicy ?? 'on-request'"
            :options="approvalPolicyOptions"
            :aria-label="t('session.titleBar.approvalPolicy.ariaLabel')"
            @update:model-value="
              emit('set-codex-policy', { ...codexPolicy, approvalPolicy: $event } as CodexPolicy)
            "
          />
        </label>
      </template>
      <!-- Non-codex vendor: single mode dropdown -->
      <label v-else-if="showMode" class="mode">
        <BaseDropdown
          :model-value="mode"
          :options="modeOptions"
          :aria-label="t('session.titleBar.mode.ariaLabel')"
          @update:model-value="emit('set-mode', $event)"
        />
      </label>
    </div>
  </div>
</template>
