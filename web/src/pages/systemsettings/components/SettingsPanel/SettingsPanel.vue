<script setup lang="ts">
/*
 * SettingsPanel.vue — 系统设置页：agent 列表（含默认 agent）与共识投票开关。
 *
 * 编辑用本地草稿，打开时从 App 注入的服务端设置深拷贝而来，保存时整体上抛。
 */
import { computed, ref, toRaw, watch } from 'vue'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'
import type {
  AgentConfig,
  SessionBindingStats,
  SystemSettings,
  UiLang,
  VendorHostStatus,
  VendorId,
} from '@ccc/shared/protocol'
import { useTypedI18n, isLocaleEnabled, type Locale } from '@/i18n'
import { VENDOR_COLOR, VENDOR_LABEL } from '@/lib/vendor'
import EmojiPicker from './EmojiPicker.vue'

const { t } = useTypedI18n()

// 浏览器本地时区，作为 timezone 草稿的默认值与 timezone 列表不可用时的兜底项。
const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone

// 浏览器语音输入的可选识别语言（BCP-47）。与 UI 语言（UI_LANGS）彻底解耦。
const VOICE_LANGS = computed<{ value: string; label: string }[]>(() => [
  { value: 'zh-CN', label: t('settings.voiceLang.zhCN.label') },
  { value: 'en-US', label: t('settings.voiceLang.enUS.label') },
  { value: 'zh-TW', label: t('settings.voiceLang.zhTW.label') },
  { value: 'zh-HK', label: t('settings.voiceLang.zhHK.label') },
])

// UI 显示语言。下放开关 = `web/src/i18n/index.ts` 的 `ENABLED_LOCALES`,由各 locale
// 的 `__humanReviewed__` 派生(en/zh 无条件基线;其余语种须人在 JSON 翻 `__humanReviewed__:
// true` 后才进集合,模型不写此字段)。此处全表声明,渲染时再按 `isLocaleEnabled` 过滤,
// 避免模型/人类各自维护一份注释掉的 ja/ko,容易漂移。
//
// 标签是「语言原生名」——BCP-47 惯例,语言名 = 语言本身的标识符。把 "日本語"
// 翻成 "Japanese" 等于把下拉项变成翻译,违背语言切换的语义。豁免于
// web/CLAUDE.md 的 no-raw-text 规则,作用域仅限此 UI_LANG_LABELS 注册表。
const UI_LANG_LABELS: Record<Locale, string> = {
  en: 'English',
  zh: '简体中文',
  ja: '日本語',
  ko: '한국어',
  ru: 'Русский',
}
const UI_LANGS = computed<{ value: UiLang; label: string }[]>(() =>
  (['en', 'zh', 'ja', 'ko', 'ru'] as const)
    .filter((l): l is Locale => isLocaleEnabled(l))
    .map((l) => ({ value: l, label: UI_LANG_LABELS[l] })),
)

const props = withDefaults(
  defineProps<{
    open: boolean
    settings: SystemSettings | null
    hostStatus?: VendorHostStatus[]
    bindingStats?: SessionBindingStats | null
  }>(),
  {
    hostStatus: () => [],
    bindingStats: null,
  },
)

// Host-CLI diagnostics rows, in canonical vendor order, each with its brand
// colour/label (ADR-0012).
const VENDOR_ORDER: VendorId[] = ['claude', 'codex', 'opencode']
const diagnostics = computed(() => {
  const byVendor = new Map(props.hostStatus.map((h) => [h.vendor, h]))
  return VENDOR_ORDER.map((v) => byVendor.get(v)).filter(
    (h): h is VendorHostStatus => h !== undefined,
  )
})
function vendorColor(v: VendorId): string {
  return VENDOR_COLOR[v]
}
function vendorLabel(v: VendorId): string {
  return VENDOR_LABEL[v]
}

const emit = defineEmits<{
  close: []
  save: [settings: SystemSettings]
  // Live, no-reload UI-language switch (fires on select change, before Save).
  'set-ui-lang': [lang: UiLang]
}>()

// A local, editable copy of the server settings; committed on Save.
const draft = ref<SystemSettings>({
  agents: [],
  defaultAgentId: SYSTEM_AGENT_ID,
  voiceLang: 'zh-CN',
  uiLang: 'en',
  timezone: BROWSER_TZ,
  showToolSessions: false,
})

// 系统时区可选项：全量 IANA 列表（Intl.supportedValuesOf 受支持时），否则退化为
// 只含浏览器时区的单项。服务端会再校验并在非法时回退到服务器本地时区。
const TIMEZONES = computed<string[]>(() => {
  const sv = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf
  let zones: string[]
  try {
    zones = typeof sv === 'function' ? sv('timeZone') : []
  } catch {
    zones = []
  }
  if (!zones.length) zones = [BROWSER_TZ]
  // 确保当前草稿值始终在列表里(例如服务端传来的历史值不在枚举中)。
  const current = draft.value.timezone
  if (current && !zones.includes(current)) zones = [current, ...zones]
  return zones
})

// Re-seed the draft whenever the panel opens or fresh server settings arrive.
// Deep-copy so edits to the draft don't mutate the rendered server state.
watch(
  () => [props.open, props.settings] as const,
  ([open, settings]) => {
    if (!open || !settings) return
    // Start from a deep copy of EVERY server field so the pass-through fields this
    // panel does not edit — `projectConfigs` / `degradationChain` / `socketAutoResume`
    // — survive a Save instead of being silently dropped (2026-06-08-003: the
    // "project config vanishes after restart" bug; second-line defense behind the
    // server-side merge). JSON round-trip is used here on purpose: it tolerates Vue
    // reactive proxies, whereas `structuredClone` throws `DataCloneError` on them.
    const full = JSON.parse(JSON.stringify(settings)) as SystemSettings
    draft.value = {
      ...full,
      // Deep-copy each agent incl. its vendor `config` so draft edits don't
      // mutate the rendered server state. `structuredClone` preserves the
      // discriminated-union type (a manual `{ ...a, config: { ...a.config } }`
      // spread widens `vendor`/`config` and breaks the arm correlation).
      // `toRaw` first: `settings` arrives as a Vue reactive proxy, and
      // `structuredClone` throws `DataCloneError` on a proxy — which would abort
      // this watcher and leave `draft.agents` empty (no agents rendered at all).
      agents: settings.agents.map((a) => structuredClone(toRaw(a))),
      defaultAgentId: settings.defaultAgentId,
      voiceLang: settings.voiceLang ?? 'zh-CN',
      uiLang: settings.uiLang ?? 'en',
      timezone: settings.timezone ?? BROWSER_TZ,
      showToolSessions: settings.showToolSessions ?? false,
    }
  },
  { immediate: true },
)

// The agent-type (vendor) options and the per-agent config-source options
// (2026-06-06-007). Vendor decides which client launches; configMode decides
// whether the provider triple (baseUrl/apiKey/model) is applied or the vendor
// CLI's own system config is used.
const VENDORS: VendorId[] = ['claude', 'codex', 'opencode']
const CONFIG_MODES = ['system', 'custom'] as const

// Vendor display names are product identifiers (do-not-translate, see
// specs/style/i18n-terms.md) rendered as bound data — same exemption pattern as
// UI_LANG_LABELS — so they don't go through `t`.
const VENDOR_LABELS: Record<VendorId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
}

// configMode is a c3 concept, so it IS localized.
function configModeLabel(m: 'system' | 'custom'): string {
  return m === 'system'
    ? t('settings.agents.configMode.system.label')
    : t('settings.agents.configMode.custom.label')
}

/** A fresh, vendor-correct {@link AgentConfig} preserving the shared shell fields.
 *  Switching vendor MUST rebuild `config` (discriminated union — a half-changed
 *  tag would be dropped by the server's zod validation, AC-R12). */
function makeAgent(
  vendor: VendorId,
  base: {
    id: string
    configMode: 'system' | 'custom'
    displayName: string
    icon: string
    enabled: boolean
  },
): AgentConfig {
  switch (vendor) {
    case 'claude':
      return { ...base, vendor, config: { baseUrl: '', apiKey: '', model: '' } }
    case 'opencode':
      return { ...base, vendor, config: { baseUrl: '', apiKey: '', model: '' } }
    case 'codex':
      // Codex's sandbox/approval gate is derived from `defaultMode` at launch
      // (2026-06-06-008), so its config is the neutral provider triple only.
      return { ...base, vendor, config: { baseUrl: '', apiKey: '', model: '' } }
  }
}

function addAgent() {
  // Locally-unique id so the default-agent radio can target it before save; the
  // server keeps it as-is (only id-less agents get a fresh uuid on normalize).
  const id = `new-${Date.now()}-${draft.value.agents.length}`
  draft.value.agents.push(
    makeAgent('claude', { id, configMode: 'custom', displayName: '', icon: '', enabled: true }),
  )
}

/** Switch an agent's vendor, rebuilding its `config` to the new vendor's shell
 *  while keeping the shared shell fields (id/configMode/name/icon/enabled). */
function setVendor(a: AgentConfig, vendor: VendorId) {
  const idx = draft.value.agents.indexOf(a)
  if (idx < 0 || a.vendor === vendor) return
  draft.value.agents[idx] = makeAgent(vendor, {
    id: a.id,
    configMode: a.configMode,
    displayName: a.displayName,
    icon: a.icon ?? '',
    enabled: a.enabled !== false,
  })
}

// An agent counts as enabled unless explicitly disabled (back-compat with
// configs/drafts that predate the field).
function isEnabled(a: AgentConfig): boolean {
  return a.enabled !== false
}

// Provider fields (baseUrl/apiKey/model) are only meaningful in `custom` mode;
// `system` mode defers to the vendor CLI's own config (2026-06-06-007).
function showProviderFields(a: AgentConfig): boolean {
  return a.configMode === 'custom'
}

function removeAgent(id: string) {
  draft.value.agents = draft.value.agents.filter((a) => a.id !== id)
  // Invariant: never leave the registry empty, and keep one valid default. If the
  // removed agent was the default, move it to the first remaining agent; if none
  // remain, synthesize a claude+system default (mirrors the server fallback).
  if (draft.value.agents.length === 0) {
    draft.value.agents.push(
      makeAgent('claude', {
        id: SYSTEM_AGENT_ID,
        configMode: 'system',
        displayName: 'System',
        icon: '',
        enabled: true,
      }),
    )
  }
  if (!draft.value.agents.some((a) => a.id === draft.value.defaultAgentId)) {
    draft.value.defaultAgentId = draft.value.agents[0].id
  }
}

/** Deep-copy an agent, append "-copy" to its displayName, and insert the copy
 *  right after the original in the draft list so the two appear side by side. */
function copyAgent(a: AgentConfig) {
  const cloned = structuredClone(toRaw(a))
  const idx = draft.value.agents.indexOf(a)
  // Locally-unique id so the radio can target it before save; the server
  // keeps it as-is (only id-less agents get a fresh uuid on normalize).
  cloned.id = `copy-${Date.now()}-${idx}`
  cloned.displayName = a.displayName ? `${a.displayName}-copy` : ''
  // Insert the copy right after the original.
  draft.value.agents.splice(idx + 1, 0, cloned)
}

// Live-switch the UI language on select change (App applies + persists + pushes
// to server); the draft is also updated so a later Save carries the same value.
function onUiLangChange(e: Event) {
  const lang = (e.target as HTMLSelectElement).value as UiLang
  draft.value.uiLang = lang
  emit('set-ui-lang', lang)
}
</script>

<template>
  <div v-if="open" class="settings-page">
    <div class="settings-head">
      <h2>{{ t('settings.title.label') }}</h2>
      <button class="icon-btn" :title="t('common.action.close.tooltip')" @click="emit('close')">
        ✕
      </button>
    </div>
    <div class="settings-body">
      <section class="settings-section">
        <p class="settings-section-title">{{ t('settings.agents.title.label') }}</p>
        <i18n-t keypath="settings.agents.hint.text" tag="p" class="settings-hint">
          <template #claude
            ><code>{{ t('settings.agents.hint.claude') }}</code></template
          >
          <template #on
            ><strong>{{ t('settings.agents.hint.on') }}</strong></template
          >
        </i18n-t>
        <div class="agent-list">
          <div v-for="a in draft.agents" :key="a.id" class="agent-row" data-testid="agent-card">
            <label class="col-on">
              <input
                type="checkbox"
                :checked="isEnabled(a)"
                :title="t('settings.agents.toggle.tooltip')"
                @change="a.enabled = ($event.target as HTMLInputElement).checked"
              />
            </label>
            <label class="col-default">
              <input
                type="radio"
                name="default-agent"
                :value="a.id"
                :checked="draft.defaultAgentId === a.id"
                :disabled="!isEnabled(a)"
                :title="t('settings.agents.default.tooltip')"
                @change="draft.defaultAgentId = a.id"
              />
            </label>
            <div class="icon-cell">
              <EmojiPicker v-model="a.icon" />
            </div>
            <input
              v-model="a.displayName"
              class="agent-field agent-name"
              :placeholder="t('settings.agents.name.placeholder')"
            />
            <select
              class="agent-field agent-vendor"
              :value="a.vendor"
              :title="t('settings.agents.vendor.tooltip')"
              data-testid="agent-vendor"
              @change="setVendor(a, ($event.target as HTMLSelectElement).value as VendorId)"
            >
              <option v-for="v in VENDORS" :key="v" :value="v">{{ VENDOR_LABELS[v] }}</option>
            </select>
            <select
              v-model="a.configMode"
              class="agent-field agent-configmode"
              :title="t('settings.agents.configMode.tooltip')"
              data-testid="agent-configmode"
            >
              <option v-for="m in CONFIG_MODES" :key="m" :value="m">
                {{ configModeLabel(m) }}
              </option>
            </select>
            <input
              v-if="showProviderFields(a)"
              v-model="a.config.baseUrl"
              class="agent-field agent-url"
              :title="t('settings.agents.col.baseUrl.label')"
              :placeholder="t('settings.agents.baseUrl.placeholder')"
            />
            <input
              v-if="showProviderFields(a)"
              v-model="a.config.apiKey"
              class="agent-field agent-key"
              type="password"
              autocomplete="off"
              :title="t('settings.agents.col.apiKey.label')"
              :placeholder="t('settings.agents.apiKey.placeholder')"
            />
            <input
              v-if="showProviderFields(a)"
              v-model="a.config.model"
              class="agent-field agent-model"
              :title="t('settings.agents.col.model.label')"
              :placeholder="t('settings.agents.model.placeholder')"
            />
            <span class="col-actions">
              <button
                class="icon-btn"
                :title="t('settings.agents.copy.tooltip')"
                @click="copyAgent(a)"
              >
                📋
              </button>
              <button
                class="icon-btn"
                :title="t('settings.agents.remove.tooltip')"
                @click="removeAgent(a.id)"
              >
                🗑
              </button>
            </span>
          </div>
        </div>
        <button class="agent-add" data-testid="settings-add-agent" @click="addAgent">
          {{ t('settings.agents.add.label') }}
        </button>
        <p v-if="bindingStats" class="settings-hint" data-testid="settings-default-note">
          {{
            t('settings.agents.defaultNote', {
              pending: bindingStats.pending,
              bound: bindingStats.bound,
            })
          }}
        </p>
      </section>

      <section class="settings-section" data-testid="settings-diagnostics">
        <p class="settings-section-title">{{ t('settings.diagnostics.title.label') }}</p>
        <p class="settings-hint">{{ t('settings.diagnostics.hint') }}</p>
        <ul class="diagnostics-list">
          <li v-for="h in diagnostics" :key="h.vendor" class="diagnostics-row">
            <span
              class="vendor-dot"
              :style="{ backgroundColor: vendorColor(h.vendor) }"
              :title="vendorLabel(h.vendor)"
            ></span>
            <span class="diagnostics-vendor">{{ vendorLabel(h.vendor) }}</span>
            <code class="diagnostics-binary">{{ h.binary }}</code>
            <span
              class="diagnostics-status"
              :class="h.present ? 'present' : 'missing'"
              :title="h.present ? '' : h.installHint"
            >
              {{
                h.present ? t('settings.diagnostics.present') : t('settings.diagnostics.missing')
              }}
            </span>
          </li>
        </ul>
      </section>

      <section class="settings-section">
        <p class="settings-section-title">{{ t('settings.displayLang.title.label') }}</p>
        <p class="settings-hint">{{ t('settings.displayLang.hint') }}</p>
        <select
          v-model="draft.uiLang"
          class="lang-select mode-select"
          data-testid="settings-ui-lang"
          @change="onUiLangChange"
        >
          <option v-for="l in UI_LANGS" :key="l.value" :value="l.value">{{ l.label }}</option>
        </select>
      </section>

      <section class="settings-section">
        <p class="settings-section-title">{{ t('settings.voiceLang.title.label') }}</p>
        <p class="settings-hint">{{ t('settings.voiceLang.hint') }}</p>
        <select v-model="draft.voiceLang" class="mode-select">
          <option v-for="l in VOICE_LANGS" :key="l.value" :value="l.value">{{ l.label }}</option>
        </select>
      </section>

      <section class="settings-section">
        <p class="settings-section-title">{{ t('settings.timezone.title.label') }}</p>
        <p class="settings-hint">{{ t('settings.timezone.hint') }}</p>
        <select v-model="draft.timezone" class="mode-select" data-testid="settings-timezone">
          <option v-for="tz in TIMEZONES" :key="tz" :value="tz">{{ tz }}</option>
        </select>
      </section>

      <section class="settings-section">
        <p class="settings-section-title">{{ t('settings.display.title.label') }}</p>
        <label class="consensus-toggle">
          <input v-model="draft.showToolSessions" type="checkbox" />
          {{ t('settings.display.showToolSessions.label') }}
        </label>
      </section>
    </div>
    <div class="settings-foot">
      <button class="ghost" @click="emit('close')">{{ t('common.action.cancel.label') }}</button>
      <button data-testid="settings-save" @click="emit('save', draft)">
        {{ t('common.action.save.label') }}
      </button>
    </div>
  </div>
</template>
