<script setup lang="ts">
// The tool permission grid: one vendor's tools, split read vs write, ticked into
// a `toolAllowlist`.
//
// Shared by the automation form and the chat-robot form. Both configure an
// UNATTENDED run, so both need the same question answered the same way — which
// tools may this run use? — and a second hand-written copy of a read/write grid
// is how the two surfaces would quietly start disagreeing about which tools
// write.
//
// What this component owns is deliberately narrow: rendering the list, grouping
// it, the select-all / clear-all operations, the network switch, and the
// loading/error/empty states. What it does NOT own is every piece of meaning
// that differs between its callers — the default selection, what an empty list
// means (an automation reads it as "unrestricted", a robot as "read-only"), and
// the payload it ends up in. Those stay with the caller, because folding them in
// here is exactly the merge that would give one surface the other's semantics.
//
// `network-access` is not a tool. It is a capability marker stored alongside the
// real names in the same allowlist, so it is kept out of the read/write groups
// and out of select-all / clear-all: ticking every tool must never silently open
// the sandbox's network boundary, and clearing every tool must never close it
// behind the operator's back.
import { computed } from 'vue'
import { useTypedI18n } from '@/i18n'
import { NETWORK_ACCESS_TOOL } from '@ccc/shared/protocol'
import type { ToolManifestEntry } from '@ccc/shared/protocol'

const { t } = useTypedI18n()

const props = defineProps<{
  /** The vendor's manifest. Empty renders the "no tools" state, never a text box. */
  tools: ToolManifestEntry[]
  /** The current allowlist — real tool names plus, possibly, `network-access`. */
  modelValue: string[]
  loading?: boolean
  /** A load failure, already localized by the caller. */
  error?: string | null
  /** Whether this vendor has a network control panel at all (codex only). */
  showNetworkAccess?: boolean
  /**
   * Whether the switch is inert in the caller's current configuration (a
   * `read-only` sandbox is network-denied unconditionally). Disabled, explained,
   * and — critically — the stored value is left untouched rather than cleared,
   * so switching back to a writable sandbox restores the operator's choice.
   */
  networkAccessBlocked?: boolean
}>()

const emit = defineEmits<{ (e: 'update:modelValue', value: string[]): void }>()

const readTools = computed<ToolManifestEntry[]>(() => props.tools.filter((tool) => !tool.isWrite))
const writeTools = computed<ToolManifestEntry[]>(() => props.tools.filter((tool) => tool.isWrite))

function checked(name: string): boolean {
  return props.modelValue.includes(name)
}

function toggle(name: string): void {
  const next = props.modelValue.includes(name)
    ? props.modelValue.filter((item) => item !== name)
    : [...props.modelValue, name]
  emit('update:modelValue', next)
}

const networkEnabled = computed(() => props.modelValue.includes(NETWORK_ACCESS_TOOL))

function toggleNetworkAccess(): void {
  if (props.networkAccessBlocked) return
  toggle(NETWORK_ACCESS_TOOL)
}

/** Select every REAL tool; the network marker keeps whatever state it had. */
function selectAll(): void {
  const names = props.tools.map((tool) => tool.name)
  if (networkEnabled.value) names.push(NETWORK_ACCESS_TOOL)
  emit('update:modelValue', names)
}

/** Clear every real tool; again, the network marker is left alone. */
function clearAll(): void {
  emit('update:modelValue', networkEnabled.value ? [NETWORK_ACCESS_TOOL] : [])
}
</script>

<template>
  <!-- Checklist -->
  <div class="sf-field sf-field--stacked sf-field--tools sf-item">
    <div class="sf-tools-labelrow">
      <span class="sf-label">{{ t('tools.grid.label') }}</span>
      <!-- Select/clear stay on the label row for quick access. -->
      <div v-if="tools.length" class="sf-tools-actions">
        <button
          type="button"
          class="sf-tools-btn"
          data-testid="tools-select-all"
          @click="selectAll"
        >
          {{ t('tools.grid.selectAll.label') }}
        </button>
        <button type="button" class="sf-tools-btn" data-testid="tools-clear-all" @click="clearAll">
          {{ t('tools.grid.clearAll.label') }}
        </button>
      </div>
    </div>

    <span v-if="loading" class="sf-hint">{{ t('tools.grid.loading') }}</span>

    <span v-else-if="error" class="sf-warn">{{ error }}</span>

    <!-- The list grows with its content; the host form owns the only vertical
     scroll area in its dialog. -->
    <div v-else-if="tools.length" class="sf-tools-scroll">
      <div class="sf-tools-group">
        <span class="sf-tools-subtitle">{{ t('tools.grid.readOnly.label') }}</span>
        <div class="sf-tools-grid">
          <label v-for="tool in readTools" :key="tool.name" class="sf-tool-item">
            <input
              type="checkbox"
              :data-testid="`tool-${tool.name}`"
              :checked="checked(tool.name)"
              @change="toggle(tool.name)"
            />
            <span class="sf-tool-name">{{ tool.name }}</span>
          </label>
        </div>
      </div>

      <div class="sf-tools-group">
        <span class="sf-tools-subtitle">{{ t('tools.grid.write.label') }}</span>
        <div class="sf-tools-grid">
          <label v-for="tool in writeTools" :key="tool.name" class="sf-tool-item">
            <input
              type="checkbox"
              :data-testid="`tool-${tool.name}`"
              :checked="checked(tool.name)"
              @change="toggle(tool.name)"
            />
            <span class="sf-tool-name">{{ tool.name }}</span>
          </label>
        </div>
      </div>
    </div>

    <span v-else class="sf-hint">{{ t('tools.grid.empty') }}</span>
  </div>

  <!-- Network access: a capability switch, kept out of the checklist. Vendors
   with no sandbox network knob do not render it at all (a stray stored value is
   ignored server-side). -->
  <div
    v-if="showNetworkAccess"
    class="sf-field sf-field--stacked sf-field--network sf-item"
    data-testid="network-access"
  >
    <label class="sf-tool-item" :class="{ 'is-disabled': networkAccessBlocked }">
      <input
        type="checkbox"
        data-testid="network-access-checkbox"
        :checked="networkEnabled"
        :disabled="networkAccessBlocked"
        @change="toggleNetworkAccess"
      />
      <span class="sf-tool-name">{{ t('tools.grid.networkAccess.label') }}</span>
    </label>
    <span class="sf-hint">{{ t('tools.grid.networkAccess.hint') }}</span>
    <span
      v-if="networkAccessBlocked"
      class="sf-hint sf-hint--warn"
      data-testid="network-access-readonly-hint"
    >
      {{ t('tools.grid.networkAccess.readOnlyHint') }}
    </span>
  </div>
</template>

<style scoped>
.sf-field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.sf-label {
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
.sf-hint {
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
.sf-hint--warn,
.sf-warn {
  color: var(--c-warning, var(--c-text));
}
.sf-tools-labelrow {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
.sf-tools-actions {
  display: flex;
  gap: var(--sp-2);
  margin-left: auto;
}
/* Keep the tool list inside the host form's single scroll area. */
.sf-tools-scroll {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.sf-tools-btn {
  background: var(--c-card);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  padding: 3px 10px;
  cursor: pointer;
}
.sf-tools-btn:hover {
  color: var(--c-text);
  background: var(--c-hover);
}
.sf-tools-group {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.sf-tools-subtitle {
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
/* auto-fit(非 auto-fill)折叠空轨道:工具少时铺满整行不留右侧空白,工具多时
   自然多列换行,高度只随实际行数增长。 */
.sf-tools-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: var(--sp-1);
}
.sf-tool-item {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-caption);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: var(--radius-sm);
}
.sf-tool-item:hover {
  background: var(--c-hover);
}
.sf-tool-item.is-disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.sf-tool-item.is-disabled:hover {
  background: transparent;
}
.sf-tool-item input[type='checkbox'] {
  margin: 0;
}
.sf-tool-name {
  font-family: var(--ff-mono, monospace);
  font-size: var(--fs-caption);
  color: var(--c-text);
}

@media (max-width: 767px) {
  .sf-tools-labelrow,
  .sf-tools-actions {
    align-items: stretch;
  }
  .sf-tools-actions {
    width: 100%;
    margin-left: 0;
  }
  .sf-tools-btn {
    flex: 1;
  }
  .sf-tools-grid {
    grid-template-columns: 1fr;
  }
}
</style>
