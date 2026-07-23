<script setup lang="ts">
/*
 * SettingsPanel.vue — 系统设置页：配置按 Agent / Runtime / Security / General 四个 Tab 分组。
 *
 * 每个 Tab 维护独立草稿与脏状态,并提供独立保存按钮:保存时只用当前 Tab 白名单字段覆盖
 * 「最新已提交快照」构造完整 SystemSettings 发送,不携带其他 Tab 草稿(见 TAB_FIELDS)。
 * 面板打开期间的设置回推按字段归属合并,只有首次打开整体播种;即时持久化字段
 * (uiLang、账号列表/管理员)总是同步,脏 Tab 的其余字段草稿受保护。保存后面板保持打开。
 * 切换存在未保存修改的 Tab 时二次确认,确认后仅切换、不保存也不丢弃草稿。
 */
import { computed, ref, toRaw, watch } from 'vue'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'
import { resolveDefaultAgentId } from '@ccc/shared'
import type {
  AgentConfig,
  AuthConfig,
  SessionBindingStats,
  SandboxHostStatus,
  SystemSettings,
  UiLang,
  VendorHostStatus,
  VendorId,
} from '@ccc/shared/protocol'
import { useTypedI18n, isLocaleEnabled, type Locale } from '@/i18n'
import { VENDOR_COLOR, VENDOR_LABEL } from '@/lib/vendor'
import { listGroupAgents } from '@/lib/group-agents'
import { useAuth } from '@/composables/useAuth'
import { deepCopy, useTabbedDraftSave } from '@/composables/useTabbedDraftSave'
import ConfirmDialog from '@/components/ConfirmDialog/ConfirmDialog.vue'
import TabNav from '@/components/TabNav/TabNav.vue'
import EmojiPicker from './EmojiPicker.vue'

const { t } = useTypedI18n()

// Whether this connection is the unique admin (ADR-0023 authz). Non-admins get a
// read-only panel: every Save + the account-management controls are disabled and a
// notice explains why. The server enforces the same gate regardless — this is UX only.
const { isAdmin } = useAuth()

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
    sandboxStatus?: SandboxHostStatus | null
    bindingStats?: SessionBindingStats | null
  }>(),
  {
    hostStatus: () => [],
    sandboxStatus: null,
    bindingStats: null,
  },
)

// ---- Tab grouping (2026-07-11-001) ----------------------------------------
// The four settings tabs and, per tab, the exact SystemSettings fields it owns.
// This map is the single save whitelist: saving a tab overlays ONLY these fields
// (transformed) onto the latest committed snapshot, so a tab's Save never carries
// another tab's unsaved draft. Host diagnostics (Runtime) render read-only from
// `hostStatus`, not from settings, so they are not listed here.
type SettingsTab = 'agent' | 'runtime' | 'security' | 'general'
const TABS: SettingsTab[] = ['agent', 'runtime', 'security', 'general']
const TAB_FIELDS: Record<SettingsTab, (keyof SystemSettings)[]> = {
  agent: [
    'agents',
    'defaultAgentId',
    'toolAgentId',
    'intentAgentId',
    'specAgentId',
    'automationAgentId',
    'sandboxDefaultAgentId',
    'sandboxToolAgentId',
    'sandboxIntentAgentId',
    'sandboxSpecAgentId',
    'sandboxAutomationAgentId',
  ],
  runtime: ['vendorCliVersions', 'proxy'],
  security: ['auth'],
  general: ['uiLang', 'voiceLang', 'timezone', 'baseUrl', 'showToolSessions', 'showSessionsPage'],
}
function tabLabel(tab: SettingsTab): string {
  return t(`settings.tabs.${tab}.label` as 'settings.tabs.agent.label')
}

// Host-CLI diagnostics rows, in canonical vendor order, each with its brand
// colour/label (ADR-0012).
const VENDOR_ORDER: VendorId[] = ['claude', 'codex']
const diagnostics = computed(() => {
  const byVendor = new Map(props.hostStatus.map((h) => [h.vendor, h]))
  return VENDOR_ORDER.map((v) => byVendor.get(v)).filter(
    (h): h is VendorHostStatus => h !== undefined,
  )
})
// Vendor CLI multi-version panel rows: each vendor's installed versions +
// runtime/download status, in canonical vendor order. Used to render the
// effective-version single-select and read-only sync status.
const vendorCliRows = computed(() => {
  const byVendor = new Map(props.hostStatus.map((h) => [h.vendor, h]))
  return VENDOR_ORDER.map((v) => byVendor.get(v)).filter(
    (h): h is VendorHostStatus => h !== undefined,
  )
})
// The draft's effective-version choice per vendor ('' ⇒ auto latest).
function activeVersionChoice(vendor: VendorId): string {
  return draft.value.vendorCliVersions?.[vendor] ?? ''
}
// Selecting an installed version only mutates the draft's vendorCliVersions; it
// is persisted on the Runtime tab's Save. Empty = auto (latest), and removes the
// vendor key so the server auto-follows the latest compatible.
function setActiveVersion(vendor: VendorId, version: string): void {
  if (!isAdmin.value) return
  const next = { ...(draft.value.vendorCliVersions ?? {}) }
  if (version) next[vendor] = version
  else delete next[vendor]
  draft.value.vendorCliVersions = next
}
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
  // Upsert a basic account's password (ADR-0023). The plaintext is sent to the
  // server which hashes it; the panel never computes or persists a hash. A new
  // username adds an account (no currentPassword); an existing one changes it
  // (currentPassword required).
  'set-password': [payload: { username: string; password: string; currentPassword?: string }]
  // Remove a basic account.
  'remove-account': [payload: { username: string }]
  // Designate which basic account is the single admin.
  'set-admin-account': [payload: { username: string }]
}>()

// A default, empty SystemSettings — the shape both `draft` and `committed` start
// from before the panel is ever seeded (keeps the dirty computeds crash-free).
function emptySettings(): SystemSettings {
  return {
    agents: [],
    defaultAgentId: SYSTEM_AGENT_ID,
    // '' ⇒ background tool sessions follow the default agent.
    toolAgentId: '',
    // '' ⇒ intent-communication sessions follow the default agent.
    intentAgentId: '',
    // '' ⇒ spec-authoring sessions follow the default agent.
    specAgentId: '',
    // '' ⇒ the new-automation form pre-fills with the default agent.
    automationAgentId: '',
    // Sandbox-mode role profile. '' ⇒ follow the sandbox default.
    sandboxDefaultAgentId: '',
    sandboxToolAgentId: '',
    sandboxIntentAgentId: '',
    sandboxSpecAgentId: '',
    sandboxAutomationAgentId: '',
    voiceLang: 'zh-CN',
    uiLang: 'en',
    timezone: BROWSER_TZ,
    baseUrl: '',
    showToolSessions: false,
    showSessionsPage: false,
    proxy: { enabled: false, httpProxy: '', httpsProxy: '' },
    vendorCliVersions: {},
  }
}

// The shared Tab-grouped draft/save state machine: `draft` is the editable copy the
// tab controls bind to, `committed` the authoritative last-committed server snapshot
// that save payloads are built from (so pass-through fields survive) and dirty is
// measured against. Only the system-settings specifics enter here as options — the
// per-tab payload transforms (buildTabPayload), the admin gate and the
// immediate-persist sync for a protected dirty tab.
const {
  draft,
  committed,
  activeTab,
  pendingTabSwitch,
  tabDirtyMap,
  seedAll,
  reconcile,
  requestTab,
  confirmTabSwitch,
  cancelTabSwitch,
  saveTab,
} = useTabbedDraftSave<SettingsTab, SystemSettings>({
  tabs: TABS,
  tabFields: TAB_FIELDS,
  initialTab: 'agent',
  initial: emptySettings,
  buildPayload: buildTabPayload,
  // Non-admins cannot mutate system config (ADR-0023 authz). Every Save button is
  // disabled, but guard the handler too so no path emits a doomed save.
  canSave: () => isAdmin.value,
  syncProtectedTab: syncImmediateFields,
  onSave: (payload) => emit('save', payload),
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

/**
 * The draft always carries `proxy` (initialized in the seed + the empty default),
 * but TypeScript cannot prove it through the optional `SystemSettings.proxy?`
 * type. This ref mirrors `draft.value.proxy` for template bindings; a watcher
 * keeps `draft.value.proxy` in sync with edits here so Runtime dirty detection
 * sees live proxy changes, and the Runtime Save reads it back.
 */
const proxyCfg = ref<{ enabled: boolean; httpProxy: string; httpsProxy: string }>({
  enabled: false,
  httpProxy: '',
  httpsProxy: '',
})
// Mirror live proxy-form edits back into the draft so Runtime dirty detection and
// the Runtime Save payload both see them (the template binds proxyCfg, not draft).
watch(
  proxyCfg,
  (p) => {
    draft.value.proxy = { ...p }
  },
  { deep: true },
)
// Seed proxyCfg from the current draft.proxy (used after a full seed / a resync).
function syncProxyRef(): void {
  const p = draft.value.proxy
  proxyCfg.value = p
    ? {
        enabled: p.enabled ?? false,
        httpProxy: p.httpProxy ?? '',
        httpsProxy: p.httpsProxy ?? '',
      }
    : { enabled: false, httpProxy: '', httpsProxy: '' }
}

// Build the normalized full-settings seed from a raw server payload. Starts from a
// deep copy of EVERY server field so pass-through fields this panel does not edit
// — `projectConfigs` / `degradationChain` / `socketAutoResume` — survive a Save
// instead of being silently dropped (2026-06-08-003), then fills defaults for the
// editable fields so `draft` and `committed` share one canonical shape (which keeps
// dirty comparison free of spurious missing-key diffs).
function buildSeed(settings: SystemSettings): SystemSettings {
  const full = deepCopy(settings)
  return {
    ...full,
    // Deep-copy each agent incl. its vendor `config` so draft edits don't mutate
    // the rendered server state; structuredClone preserves the discriminated-union
    // type. `toRaw` first — `settings` arrives as a Vue reactive proxy and
    // structuredClone throws `DataCloneError` on a proxy.
    agents: settings.agents.map((a) => structuredClone(toRaw(a))),
    defaultAgentId: settings.defaultAgentId,
    // '' ⇒ background tool sessions follow the default agent (AC-R21).
    toolAgentId: settings.toolAgentId ?? '',
    // '' ⇒ intent-communication sessions follow the default agent (AC-R23).
    intentAgentId: settings.intentAgentId ?? '',
    // '' ⇒ spec-authoring sessions follow the default agent (AC-R24).
    specAgentId: settings.specAgentId ?? '',
    // '' ⇒ the new-automation form pre-fills with the default agent (AC-R25).
    automationAgentId: settings.automationAgentId ?? '',
    // Sandbox-mode role profile. '' ⇒ follow the sandbox default.
    sandboxDefaultAgentId: settings.sandboxDefaultAgentId ?? '',
    sandboxToolAgentId: settings.sandboxToolAgentId ?? '',
    sandboxIntentAgentId: settings.sandboxIntentAgentId ?? '',
    sandboxSpecAgentId: settings.sandboxSpecAgentId ?? '',
    sandboxAutomationAgentId: settings.sandboxAutomationAgentId ?? '',
    voiceLang: settings.voiceLang ?? 'zh-CN',
    uiLang: settings.uiLang ?? 'en',
    timezone: settings.timezone ?? BROWSER_TZ,
    baseUrl: settings.baseUrl ?? '',
    showToolSessions: settings.showToolSessions ?? false,
    showSessionsPage: settings.showSessionsPage === true,
    proxy: settings.proxy ?? { enabled: false, httpProxy: '', httpsProxy: '' },
    // Effective vendor CLI version selection per vendor (empty object ⇒ auto latest
    // for both). Carried explicitly so the radios bind to the draft.
    vendorCliVersions: { ...(settings.vendorCliVersions ?? {}) },
  }
}

// Sync only the immediate-persist sub-fields of a (dirty, protected) tab from
// `seed`: the UI language (General) and the basic-account list + admin designation
// (Security). These are persisted by dedicated paths that do not wait for a tab's
// Save, so they must reflect the server even while the rest of the tab stays dirty.
function syncImmediateFields(tab: SettingsTab, target: SystemSettings, src: SystemSettings): void {
  if (tab === 'general') {
    target.uiLang = src.uiLang
  } else if (tab === 'security') {
    if (target.auth?.provider.kind === 'basic' && src.auth?.provider.kind === 'basic') {
      target.auth.provider.accounts = src.auth.provider.accounts.map((a) => ({ ...a }))
      target.auth.provider.adminUsername = src.auth.provider.adminUsername
    }
  }
}

// Re-seed on open, then reconcile field-by-field on every later server pushback.
// The shared layer owns the merge rules; the panel only supplies the canonical seed
// and re-mirrors `proxyCfg`, whose form binding lives outside the draft.
watch(
  () => [props.open, props.settings] as const,
  ([open, settings], prev) => {
    if (!open || !settings) return
    const seed = buildSeed(settings)
    const prevOpen = prev?.[0] ?? false
    // First open (or reopen): whole-draft seed. Otherwise a pushback while open,
    // merged by field ownership so unsaved drafts survive.
    if (!prevOpen) seedAll(seed)
    else reconcile(seed)
    syncProxyRef()
  },
  { immediate: true },
)

// The agent-type (vendor) options and the per-agent config-source options
// (2026-06-06-007). Vendor decides which client launches; configMode decides
// whether the provider triple (baseUrl/apiKey/model) is applied or the vendor
// CLI's own system config is used.
const VENDORS: VendorId[] = ['claude', 'codex']
const CONFIG_MODES = ['system', 'custom'] as const

// Vendor display names are product identifiers (do-not-translate, see
// specs/style/i18n-terms.md) rendered as bound data — same exemption pattern as
// UI_LANG_LABELS — so they don't go through `t`.
const VENDOR_LABELS: Record<VendorId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
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
    // Group membership (ADR-0029) is a shared shell field — preserved across a
    // vendor switch so a filled group name is not dropped when the config rebuilds.
    group?: string
  },
): AgentConfig {
  switch (vendor) {
    case 'claude':
      return { ...base, vendor, config: { baseUrl: '', apiKey: '', model: '' } }
    case 'codex':
      // Codex's sandbox/approval gate is derived from `defaultMode` at launch
      // (2026-06-06-008), so its config is the neutral provider triple plus
      // `wireApi` — the upstream protocol the driver routes on (2026-06-12-006).
      // Default `chat` (most third parties are Chat-Completions-only ⇒ relay).
      return { ...base, vendor, config: { baseUrl: '', apiKey: '', model: '', wireApi: 'chat' } }
  }
}

function addAgent() {
  // Locally-unique id so the default-agent radio can target it before save; the
  // server keeps it as-is (only id-less agents get a fresh uuid on normalize).
  const id = `new-${Date.now()}-${draft.value.agents.length}`
  draft.value.agents.push(
    makeAgent('claude', {
      id,
      configMode: 'custom',
      displayName: '',
      icon: '',
      enabled: true,
      group: '',
    }),
  )
}

/** Switch an agent's vendor, rebuilding its `config` to the new vendor's shell
 *  while keeping the shared shell fields (id/configMode/name/icon/enabled/group). */
function setVendor(a: AgentConfig, vendor: VendorId) {
  const idx = draft.value.agents.indexOf(a)
  if (idx < 0 || a.vendor === vendor) return
  draft.value.agents[idx] = makeAgent(vendor, {
    id: a.id,
    configMode: a.configMode,
    displayName: a.displayName,
    icon: a.icon ?? '',
    enabled: a.enabled !== false,
    group: a.group ?? '',
  })
}

// An agent counts as enabled unless explicitly disabled (back-compat with
// configs/drafts that predate the field).
function isEnabled(a: AgentConfig): boolean {
  return a.enabled !== false
}

// The default-agent dropdown only offers enabled agents, in the current array
// order (= the visual order_seq order before Save stamps it).
const defaultPickerAgents = computed<AgentConfig[]>(() => draft.value.agents.filter(isEnabled))

// The sandbox-role dropdowns offer every enabled agent, of either auth mode: a
// `system`-mode (subscription) agent authenticates inside the arapuca sandbox
// through the host keychain the wrapper opens for it (the server's
// `normalizeSandboxRoleId` enforces the same rule).
const sandboxPickerAgents = computed<AgentConfig[]>(() => draft.value.agents.filter(isEnabled))

// Reset a sandbox role id to '' ("follow the sandbox default") when it no longer
// points at an enabled agent — keeps the draft consistent after an agent is
// disabled or removed (mirrors the server reset-on-store).
function pruneSandboxRoles(): void {
  const valid = new Set(sandboxPickerAgents.value.map((a) => a.id))
  const keep = (id: string): string => (id && valid.has(id) ? id : '')
  draft.value.sandboxDefaultAgentId = keep(draft.value.sandboxDefaultAgentId)
  draft.value.sandboxToolAgentId = keep(draft.value.sandboxToolAgentId)
  draft.value.sandboxIntentAgentId = keep(draft.value.sandboxIntentAgentId)
  draft.value.sandboxSpecAgentId = keep(draft.value.sandboxSpecAgentId)
  draft.value.sandboxAutomationAgentId = keep(draft.value.sandboxAutomationAgentId)
}

// Virtual group agents (`_c3_<group>`, ADR-0029) offered alongside real agents in
// every agent picker; selecting one binds the session/role to the group (relay
// failover across its members). Derived client-side from the draft's `group` fields.
const pickerGroupAgents = computed(() => listGroupAgents(draft.value.agents))

// Toggle an agent's enabled flag. If this disables (or the inverse — never)
// the current default, fall through to the next enabled agent and persist that
// rewrite (mirrors the server `normalize`, AC-R2/AC-R10). Recompute against the
// live array order so the choice tracks order_seq. The tool agent follows the
// same fall-through, but ONLY when it's explicitly set: an empty toolAgentId
// ("follow the default") stays empty. The intent agent (AC-R23), spec agent
// (AC-R24) and automation agent (AC-R25) follow the same rule as the tool agent.
function onToggleEnabled(a: AgentConfig, checked: boolean): void {
  a.enabled = checked
  draft.value.defaultAgentId = resolveDefaultAgentId(draft.value.agents, draft.value.defaultAgentId)
  if (draft.value.toolAgentId) {
    draft.value.toolAgentId = resolveDefaultAgentId(draft.value.agents, draft.value.toolAgentId)
  }
  if (draft.value.intentAgentId) {
    draft.value.intentAgentId = resolveDefaultAgentId(draft.value.agents, draft.value.intentAgentId)
  }
  if (draft.value.specAgentId) {
    draft.value.specAgentId = resolveDefaultAgentId(draft.value.agents, draft.value.specAgentId)
  }
  if (draft.value.automationAgentId) {
    draft.value.automationAgentId = resolveDefaultAgentId(
      draft.value.agents,
      draft.value.automationAgentId,
    )
  }
  // Sandbox roles must stay on enabled agents — drop any a disable just invalidated.
  pruneSandboxRoles()
}

// Provider connection fields (baseUrl/apiKey) are only meaningful in `custom`
// mode; `system` mode defers to the vendor CLI's own config. `model` is now a
// standalone override visible in BOTH modes (2026-07-02-001) — it does NOT go
// through this gate.
function showProviderFields(a: AgentConfig): boolean {
  return a.configMode === 'custom'
}

// The `wireApi` selector is codex-only and custom-only (2026-06-12-006): it
// declares the provider's upstream protocol the driver routes on. A `system`-mode
// codex (or any other vendor) has no such field.
const WIRE_APIS = ['chat', 'responses'] as const
function showWireApi(a: AgentConfig): boolean {
  return a.vendor === 'codex' && a.configMode === 'custom'
}
function wireApiLabel(w: 'responses' | 'chat'): string {
  return w === 'responses'
    ? t('settings.agents.wireApi.responses.label')
    : t('settings.agents.wireApi.chat.label')
}
// Narrow the union for template read/write — `wireApi` lives only on the codex arm.
function wireApiOf(a: AgentConfig): 'responses' | 'chat' {
  return a.vendor === 'codex' ? a.config.wireApi : 'chat'
}
function setWireApi(a: AgentConfig, w: 'responses' | 'chat'): void {
  if (a.vendor === 'codex') a.config.wireApi = w
}

function removeAgent(id: string) {
  draft.value.agents = draft.value.agents.filter((a) => a.id !== id)
  // Invariant: never leave the registry empty, and keep one valid default. If the
  // removed agent was the default, fall through to the next enabled agent (AC-R2);
  // if none remain, synthesize a claude+system default (mirrors the server fallback).
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
  draft.value.defaultAgentId = resolveDefaultAgentId(draft.value.agents, draft.value.defaultAgentId)
  // A removed agent may have been a sandbox role — drop any now-dangling reference.
  pruneSandboxRoles()
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

// ---- Drag-to-reorder the agent list (native HTML5 DnD, no library) ----------
// The grip handle is the draggable element (so the row's text inputs stay
// selectable as usual); the whole row is the drop target. On drop we splice the
// dragged agent into the dropped row's slot. `order_seq` is (re)stamped from the
// final array order at Save time (see `saveTab`), so a reorder survives the round
// trip to the server, which then regularizes it into a dense 0..n sequence.
const dragIndex = ref<number | null>(null)
const dragOverIndex = ref<number | null>(null)

function onAgentDragStart(index: number, e: DragEvent): void {
  dragIndex.value = index
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}
function onAgentDragOver(index: number): void {
  dragOverIndex.value = dragIndex.value === null || dragIndex.value === index ? null : index
}
function onAgentDrop(index: number): void {
  const from = dragIndex.value
  dragIndex.value = null
  dragOverIndex.value = null
  if (from === null || from === index) return
  const list = draft.value.agents
  const [moved] = list.splice(from, 1)
  list.splice(index, 0, moved)
}
function onAgentDragEnd(): void {
  dragIndex.value = null
  dragOverIndex.value = null
}

// Build a full SystemSettings for a single tab's Save: `payload` arrives as a deep
// copy of the latest committed snapshot (so pass-through fields survive), and this
// overlays ONLY the current tab's whitelist fields from the draft, applying that
// tab's transforms to the payload copy alone (never writing back into the drafts).
// Emitting the full object keeps the `save_settings` protocol unchanged; the tab
// boundary is enforced purely by which fields we overlay.
function buildTabPayload(
  tab: SettingsTab,
  payload: SystemSettings,
  src: SystemSettings,
): SystemSettings {
  switch (tab) {
    case 'agent': {
      // Stamp the user-controlled order onto every agent from its array position so
      // a drag-reorder (or add / copy / remove) persists; the server regularizes it.
      const agents = src.agents.map((a, i) => ({
        ...structuredClone(toRaw(a)),
        order_seq: i,
      }))
      payload.agents = agents
      payload.defaultAgentId = src.defaultAgentId
      payload.toolAgentId = src.toolAgentId
      payload.intentAgentId = src.intentAgentId
      payload.specAgentId = src.specAgentId
      payload.automationAgentId = src.automationAgentId
      payload.sandboxDefaultAgentId = src.sandboxDefaultAgentId
      payload.sandboxToolAgentId = src.sandboxToolAgentId
      payload.sandboxIntentAgentId = src.sandboxIntentAgentId
      payload.sandboxSpecAgentId = src.sandboxSpecAgentId
      payload.sandboxAutomationAgentId = src.sandboxAutomationAgentId
      break
    }
    case 'runtime': {
      payload.vendorCliVersions = { ...(src.vendorCliVersions ?? {}) }
      payload.proxy = { ...proxyCfg.value }
      break
    }
    case 'security': {
      const auth = src.auth ? deepCopy(src.auth) : undefined
      // Derive the auth master switch from the chosen provider: `none` ⇒ off,
      // `basic` ⇒ on only once an admin is configured. The server's `normalizeAuth`
      // re-pins `none ⇒ false` as defence-in-depth.
      if (auth) auth.enabled = authActive.value
      payload.auth = auth
      break
    }
    case 'general': {
      payload.uiLang = src.uiLang
      payload.voiceLang = src.voiceLang
      payload.timezone = src.timezone
      payload.baseUrl = src.baseUrl
      payload.showToolSessions = src.showToolSessions
      payload.showSessionsPage = src.showSessionsPage
      break
    }
  }
  return payload
}

// Live-switch the UI language on select change (App applies + persists + pushes
// to server). Update the draft so a later General Save carries the same value, and
// optimistically advance the committed baseline too — the language is persisted
// immediately, so it must not linger as an unsaved General diff.
function onUiLangChange(e: Event) {
  const lang = (e.target as HTMLSelectElement).value as UiLang
  draft.value.uiLang = lang
  committed.value.uiLang = lang
  emit('set-ui-lang', lang)
}

// ---- Authentication (ADR-0023) ------------------------------------------
// The provider dropdown is the single auth on/off control (the old standalone
// "enable" checkbox is gone): `none` ⇒ no auth (sign-in disabled, the C-SEC-5
// localhost default); `basic` ⇒ require sign-in (effective only once an admin is
// configured).
const AUTH_PROVIDERS: { value: string; disabled: boolean }[] = [
  { value: 'none', disabled: false },
  { value: 'basic', disabled: false },
]
// Signing key is a reference (an env name), never the key itself (ADR-0023).
// 30-day TTL mirrors the server default (auth-schema.ts DEFAULT_SESSION_TTL_SECONDS).
const SECONDS_PER_DAY = 24 * 60 * 60
const DEFAULT_AUTH_SESSION = { ttlSeconds: 30 * SECONDS_PER_DAY, signingKeyRef: 'C3_AUTH_KEY' }

// The basic account set + the single admin username (empty arrays/'' when not
// basic or unconfigured). Accounts are owned by the server (dedicated messages);
// the panel reflects the loaded draft and acts via emits.
const basicAccounts = computed(() =>
  draft.value.auth?.provider.kind === 'basic' ? draft.value.auth.provider.accounts : [],
)
const basicAdminUsername = computed(() =>
  draft.value.auth?.provider.kind === 'basic' ? draft.value.auth.provider.adminUsername : '',
)
// "Admin configured" = at least one account AND a valid admin reference; gates
// enabling auth + network exposure (acceptance #5). Mirrors the server's
// `deriveBasicEnabled`.
const adminConfigured = computed(
  () =>
    basicAccounts.value.length > 0 &&
    !!basicAdminUsername.value &&
    basicAccounts.value.some((a) => a.username === basicAdminUsername.value),
)

// Write-only inputs for adding an account (username + initial password). The hash
// is NEVER echoed here; these clear after the emit. Editing happens in a modal —
// `showAddModal` drives its visibility.
const showAddModal = ref(false)
const addUsername = ref('')
const addPassword = ref('')
// Per-account password change: which account is being edited (also drives the
// change-password modal) + its proof inputs.
const pwTarget = ref<string | null>(null)
const pwCurrent = ref('')
const pwNew = ref('')
// Which account a pending Remove confirmation targets (drives the confirm modal).
const removeTarget = ref<string | null>(null)
// Auth is effectively ON only under `basic` with a configured admin. `none` ⇒
// always off. This is
// the single derivation of `enabled` — the dropdown chooses intent, this gates
// it, and `saveTab('security')` writes it into the payload (server `normalizeAuth`
// re-pins `none ⇒ enabled:false` as a second guard).
const authActive = computed(() => authProviderKind.value === 'basic' && adminConfigured.value)
const exposureOn = computed(() => {
  const addr = draft.value.auth?.exposure?.bindAddress
  return !!addr && addr !== '127.0.0.1' && addr !== 'localhost'
})

/** Lazily materialize an auth block on first interaction. Defaults to the
 *  no-auth `none` provider — the C-SEC-5 localhost default — so an untouched
 *  panel never implies a half-configured `basic`. */
function ensureAuth(): AuthConfig {
  if (!draft.value.auth) {
    draft.value.auth = {
      enabled: false,
      provider: { kind: 'none' },
      session: { ...DEFAULT_AUTH_SESSION },
    }
  }
  return draft.value.auth
}
function setExposure(v: boolean) {
  ensureAuth().exposure = { bindAddress: v ? '0.0.0.0' : '127.0.0.1' }
}
// Session TTL is edited in whole days (friendly unit); stored as seconds. Reads
// fall back to the 30-day default; writes floor to ≥1 day so an empty/zero input
// can never mint a zero-second (instantly-expired) session.
const authTtlDays = computed(() =>
  Math.max(
    1,
    Math.round(
      (draft.value.auth?.session.ttlSeconds ?? DEFAULT_AUTH_SESSION.ttlSeconds) / SECONDS_PER_DAY,
    ),
  ),
)
function setAuthTtlDays(v: number) {
  const days = Math.max(1, Math.floor(v) || 1)
  ensureAuth().session.ttlSeconds = days * SECONDS_PER_DAY
}

// ---- Provider kind switch -------------------------------------------------
// Switching kind materializes a fresh default block of that kind (provider is a
// single arm — the previous kind's draft is replaced; saved config round-trips
// back on reopen). An absent block reads as `none` (no auth, the default). The
// dropdown is the only auth on/off control: `enabled` is derived (see
// `authActive`) and written at save, so switching only sets the provider shape.
const authProviderKind = computed(() => draft.value.auth?.provider.kind ?? 'none')
const isNone = computed(() => authProviderKind.value === 'none')
function setAuthProviderKind(v: string) {
  const a = ensureAuth()
  if (v === a.provider.kind) return
  if (v === 'none') {
    a.provider = { kind: 'none' }
    a.enabled = false
  } else if (v === 'basic') {
    a.provider = { kind: 'basic', accounts: [], adminUsername: '' }
    // Becomes effective once an admin is configured (authActive + saveTab).
    a.enabled = false
  }
}

// ---- basic account management (emits → dedicated server messages) --------
// A new account's username must not collide with an existing one (AC2.1). Caught
// here so "add" never falls through to the change-password path (which would
// confusingly demand the current password for a username the user means to add).
const addUsernameTaken = computed(() => {
  const u = addUsername.value.trim()
  return !!u && basicAccounts.value.some((a) => a.username === u)
})
/** Open the add-account modal with a clean (write-only) form. */
function startAddAccount() {
  if (!isAdmin.value) return
  addUsername.value = ''
  addPassword.value = ''
  showAddModal.value = true
}
/** Close the add-account modal, discarding any typed (unsent) inputs. */
function cancelAddAccount() {
  showAddModal.value = false
  addUsername.value = ''
  addPassword.value = ''
}
/** Add a new account: ship username + initial password (server hashes + adds;
 *  the first account also becomes the admin). No current-password proof. */
function submitAddAccount() {
  if (!isAdmin.value) return
  const username = addUsername.value.trim()
  if (!username || addUsernameTaken.value || addPassword.value.length < 4) return
  emit('set-password', { username, password: addPassword.value })
  addUsername.value = ''
  addPassword.value = ''
  showAddModal.value = false
}
/** Open the change-password modal for an existing account. */
function startChangePassword(username: string) {
  if (!isAdmin.value) return
  pwTarget.value = username
  pwCurrent.value = ''
  pwNew.value = ''
}
/** Close the change-password modal, discarding the typed proof/new password. */
function cancelChangePassword() {
  pwTarget.value = null
  pwCurrent.value = ''
  pwNew.value = ''
}
/** Ship a password change for `pwTarget` (proves the current password). */
function submitChangePassword() {
  if (!isAdmin.value || !pwTarget.value || pwNew.value.length < 4) return
  emit('set-password', {
    username: pwTarget.value,
    password: pwNew.value,
    currentPassword: pwCurrent.value,
  })
  pwTarget.value = null
  pwCurrent.value = ''
  pwNew.value = ''
}
/** Open the Remove confirmation modal for an account. */
function startRemoveAccount(username: string) {
  if (!isAdmin.value) return
  removeTarget.value = username
}
/** Dismiss the Remove confirmation without deleting. */
function cancelRemoveAccount() {
  removeTarget.value = null
}
/** Confirm + ship the account removal for `removeTarget`. */
function confirmRemoveAccount() {
  if (!isAdmin.value || !removeTarget.value) return
  emit('remove-account', { username: removeTarget.value })
  removeTarget.value = null
}
function selectAdmin(username: string) {
  if (!isAdmin.value) return
  emit('set-admin-account', { username })
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
    <p v-if="!isAdmin" class="settings-readonly-notice" data-testid="settings-readonly-notice">
      {{ t('settings.readOnlyNotice.text') }}
    </p>

    <!-- Tab navigation (shared with the workspace-setting page). Requesting a switch
         away from a dirty tab opens the confirm dialog (see requestTab). -->
    <TabNav
      :tabs="TABS"
      :active-tab="activeTab"
      :dirty-map="tabDirtyMap"
      :tab-label="tabLabel"
      prefix="settings"
      :dirty-title="t('settings.tabs.unsaved.label')"
      @select="requestTab"
    />

    <div class="settings-body">
      <!-- ============ Agent tab ============ -->
      <div
        v-show="activeTab === 'agent'"
        class="settings-tab-panel"
        role="tabpanel"
        data-testid="settings-tab-agent"
      >
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
            <div
              v-for="(a, i) in draft.agents"
              :key="a.id"
              class="agent-row"
              :class="{ 'drag-over': dragOverIndex === i }"
              data-testid="agent-card"
              @dragover.prevent="onAgentDragOver(i)"
              @drop.prevent="onAgentDrop(i)"
            >
              <span
                class="col-drag"
                draggable="true"
                :title="t('settings.agents.reorder.tooltip')"
                data-testid="agent-drag"
                @dragstart="onAgentDragStart(i, $event)"
                @dragend="onAgentDragEnd"
                >⠿</span
              >
              <label class="col-on">
                <input
                  class="agent-enabled-switch"
                  type="checkbox"
                  role="switch"
                  :checked="isEnabled(a)"
                  :aria-checked="isEnabled(a)"
                  :title="t('settings.agents.toggle.tooltip')"
                  data-testid="agent-enabled-switch"
                  @change="onToggleEnabled(a, ($event.target as HTMLInputElement).checked)"
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
                @change="pruneSandboxRoles"
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
                v-model="a.config.model"
                class="agent-field agent-model"
                :title="t('settings.agents.col.model.label')"
                :placeholder="t('settings.agents.model.placeholder')"
              />
              <select
                v-if="showWireApi(a)"
                class="agent-field agent-wireapi"
                :value="wireApiOf(a)"
                :title="t('settings.agents.wireApi.tooltip')"
                data-testid="agent-wireapi"
                @change="
                  setWireApi(a, ($event.target as HTMLSelectElement).value as 'responses' | 'chat')
                "
              >
                <option v-for="w in WIRE_APIS" :key="w" :value="w">{{ wireApiLabel(w) }}</option>
              </select>
              <input
                v-model="a.group"
                class="agent-field agent-group"
                :title="t('settings.agents.group.tooltip')"
                :placeholder="t('settings.agents.group.placeholder')"
                data-testid="agent-group"
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
          <div class="agent-default-picker">
            <label class="agent-default-label" for="default-agent-select">
              {{ t('settings.agents.defaultPicker.label') }}
            </label>
            <select
              id="default-agent-select"
              v-model="draft.defaultAgentId"
              class="agent-field"
              data-testid="default-agent-select"
              :title="t('settings.agents.default.tooltip')"
              :disabled="defaultPickerAgents.length === 0"
            >
              <option v-for="a in defaultPickerAgents" :key="a.id" :value="a.id">
                {{ a.displayName || a.id }}
              </option>
              <optgroup
                v-if="pickerGroupAgents.length > 0"
                :label="t('settings.agents.groupPicker.label')"
              >
                <option v-for="g in pickerGroupAgents" :key="g.id" :value="g.id">
                  {{ g.id }}
                </option>
              </optgroup>
              <option v-if="defaultPickerAgents.length === 0" value="" disabled>
                {{ t('settings.agents.defaultPicker.empty') }}
              </option>
            </select>
          </div>
          <div class="agent-default-picker">
            <label class="agent-default-label" for="tool-agent-select">
              {{ t('settings.agents.toolPicker.label') }}
            </label>
            <select
              id="tool-agent-select"
              v-model="draft.toolAgentId"
              class="agent-field"
              data-testid="tool-agent-select"
              :title="t('settings.agents.tool.tooltip')"
            >
              <option value="">{{ t('settings.agents.toolPicker.followDefault') }}</option>
              <option v-for="a in defaultPickerAgents" :key="a.id" :value="a.id">
                {{ a.displayName || a.id }}
              </option>
              <optgroup
                v-if="pickerGroupAgents.length > 0"
                :label="t('settings.agents.groupPicker.label')"
              >
                <option v-for="g in pickerGroupAgents" :key="g.id" :value="g.id">
                  {{ g.id }}
                </option>
              </optgroup>
            </select>
          </div>
          <div class="agent-default-picker">
            <label class="agent-default-label" for="intent-agent-select">
              {{ t('settings.agents.intentPicker.label') }}
            </label>
            <select
              id="intent-agent-select"
              v-model="draft.intentAgentId"
              class="agent-field"
              data-testid="intent-agent-select"
              :title="t('settings.agents.intent.tooltip')"
            >
              <option value="">{{ t('settings.agents.intentPicker.followDefault') }}</option>
              <option v-for="a in defaultPickerAgents" :key="a.id" :value="a.id">
                {{ a.displayName || a.id }}
              </option>
              <optgroup
                v-if="pickerGroupAgents.length > 0"
                :label="t('settings.agents.groupPicker.label')"
              >
                <option v-for="g in pickerGroupAgents" :key="g.id" :value="g.id">
                  {{ g.id }}
                </option>
              </optgroup>
            </select>
          </div>
          <div class="agent-default-picker">
            <label class="agent-default-label" for="spec-agent-select">
              {{ t('settings.agents.specPicker.label') }}
            </label>
            <select
              id="spec-agent-select"
              v-model="draft.specAgentId"
              class="agent-field"
              data-testid="spec-agent-select"
              :title="t('settings.agents.spec.tooltip')"
            >
              <option value="">{{ t('settings.agents.specPicker.followDefault') }}</option>
              <option v-for="a in defaultPickerAgents" :key="a.id" :value="a.id">
                {{ a.displayName || a.id }}
              </option>
              <optgroup
                v-if="pickerGroupAgents.length > 0"
                :label="t('settings.agents.groupPicker.label')"
              >
                <option v-for="g in pickerGroupAgents" :key="g.id" :value="g.id">
                  {{ g.id }}
                </option>
              </optgroup>
            </select>
          </div>
          <div class="agent-default-picker">
            <label class="agent-default-label" for="automation-agent-select">
              {{ t('settings.agents.automationPicker.label') }}
            </label>
            <select
              id="automation-agent-select"
              v-model="draft.automationAgentId"
              class="agent-field"
              data-testid="automation-agent-select"
              :title="t('settings.agents.automation.tooltip')"
            >
              <option value="">{{ t('settings.agents.automationPicker.followDefault') }}</option>
              <option v-for="a in defaultPickerAgents" :key="a.id" :value="a.id">
                {{ a.displayName || a.id }}
              </option>
              <optgroup
                v-if="pickerGroupAgents.length > 0"
                :label="t('settings.agents.groupPicker.label')"
              >
                <option v-for="g in pickerGroupAgents" :key="g.id" :value="g.id">
                  {{ g.id }}
                </option>
              </optgroup>
            </select>
          </div>
          <!-- Sandbox-mode role profile: which agent a sandboxed run of each kind
               uses. Both auth modes are valid (a subscription agent reaches the host
               keychain via the wrapper). Empty ⇒ follow the sandbox default ⇒ the
               first enabled agent. -->
          <p class="settings-subhead" data-testid="sandbox-roles-head">
            {{ t('settings.agents.sandboxRoles.head') }}
          </p>
          <p class="settings-hint">{{ t('settings.agents.sandboxRoles.hint') }}</p>
          <div class="agent-default-picker">
            <label class="agent-default-label" for="sandbox-default-agent-select">
              {{ t('settings.agents.sandboxDefaultPicker.label') }}
            </label>
            <select
              id="sandbox-default-agent-select"
              v-model="draft.sandboxDefaultAgentId"
              class="agent-field"
              data-testid="sandbox-default-agent-select"
              :title="t('settings.agents.sandboxDefault.tooltip')"
            >
              <option value="">{{ t('settings.agents.sandboxDefaultPicker.auto') }}</option>
              <option v-for="a in sandboxPickerAgents" :key="a.id" :value="a.id">
                {{ a.displayName || a.id }}
              </option>
              <option v-if="sandboxPickerAgents.length === 0" value="" disabled>
                {{ t('settings.agents.sandboxRoles.empty') }}
              </option>
            </select>
          </div>
          <div class="agent-default-picker">
            <label class="agent-default-label" for="sandbox-tool-agent-select">
              {{ t('settings.agents.sandboxToolPicker.label') }}
            </label>
            <select
              id="sandbox-tool-agent-select"
              v-model="draft.sandboxToolAgentId"
              class="agent-field"
              data-testid="sandbox-tool-agent-select"
              :title="t('settings.agents.sandboxTool.tooltip')"
            >
              <option value="">{{ t('settings.agents.sandboxRoles.followSandboxDefault') }}</option>
              <option v-for="a in sandboxPickerAgents" :key="a.id" :value="a.id">
                {{ a.displayName || a.id }}
              </option>
            </select>
          </div>
          <div class="agent-default-picker">
            <label class="agent-default-label" for="sandbox-intent-agent-select">
              {{ t('settings.agents.sandboxIntentPicker.label') }}
            </label>
            <select
              id="sandbox-intent-agent-select"
              v-model="draft.sandboxIntentAgentId"
              class="agent-field"
              data-testid="sandbox-intent-agent-select"
              :title="t('settings.agents.sandboxIntent.tooltip')"
            >
              <option value="">{{ t('settings.agents.sandboxRoles.followSandboxDefault') }}</option>
              <option v-for="a in sandboxPickerAgents" :key="a.id" :value="a.id">
                {{ a.displayName || a.id }}
              </option>
            </select>
          </div>
          <div class="agent-default-picker">
            <label class="agent-default-label" for="sandbox-spec-agent-select">
              {{ t('settings.agents.sandboxSpecPicker.label') }}
            </label>
            <select
              id="sandbox-spec-agent-select"
              v-model="draft.sandboxSpecAgentId"
              class="agent-field"
              data-testid="sandbox-spec-agent-select"
              :title="t('settings.agents.sandboxSpec.tooltip')"
            >
              <option value="">{{ t('settings.agents.sandboxRoles.followSandboxDefault') }}</option>
              <option v-for="a in sandboxPickerAgents" :key="a.id" :value="a.id">
                {{ a.displayName || a.id }}
              </option>
            </select>
          </div>
          <div class="agent-default-picker">
            <label class="agent-default-label" for="sandbox-automation-agent-select">
              {{ t('settings.agents.sandboxAutomationPicker.label') }}
            </label>
            <select
              id="sandbox-automation-agent-select"
              v-model="draft.sandboxAutomationAgentId"
              class="agent-field"
              data-testid="sandbox-automation-agent-select"
              :title="t('settings.agents.sandboxAutomation.tooltip')"
            >
              <option value="">{{ t('settings.agents.sandboxRoles.followSandboxDefault') }}</option>
              <option v-for="a in sandboxPickerAgents" :key="a.id" :value="a.id">
                {{ a.displayName || a.id }}
              </option>
            </select>
          </div>
          <p v-if="bindingStats" class="settings-hint" data-testid="settings-default-note">
            {{
              t('settings.agents.defaultNote', {
                pending: bindingStats.pending,
                bound: bindingStats.bound,
              })
            }}
          </p>
        </section>
      </div>

      <!-- ============ Runtime tab ============ -->
      <div
        v-show="activeTab === 'runtime'"
        class="settings-tab-panel"
        role="tabpanel"
        data-testid="settings-tab-runtime"
      >
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
              <code v-if="h.present && h.path" class="diagnostics-path" :title="h.path">{{
                h.path
              }}</code>
            </li>
            <li v-if="sandboxStatus" class="diagnostics-row" data-testid="sandbox-diagnostics">
              <span class="vendor-dot sandbox-dot"></span>
              <span class="diagnostics-vendor">{{ t('settings.diagnostics.sandbox') }}</span>
              <code class="diagnostics-binary">{{ sandboxStatus.binary }}</code>
              <span
                class="diagnostics-status"
                :class="sandboxStatus.present ? 'present' : 'missing'"
              >
                {{
                  sandboxStatus.present
                    ? t('settings.diagnostics.present')
                    : t('settings.diagnostics.missing')
                }}
              </span>
              <code
                v-if="sandboxStatus.present && sandboxStatus.path"
                class="diagnostics-path"
                :title="sandboxStatus.path"
                >{{ sandboxStatus.path }}</code
              >
            </li>
          </ul>
        </section>

        <!-- Vendor CLI multi-version selection (effective version ≠ download target) -->
        <section class="settings-section" data-testid="settings-vendor-cli">
          <p class="settings-section-title">{{ t('settings.vendorCli.title.label') }}</p>
          <p class="settings-hint">{{ t('settings.vendorCli.hint') }}</p>
          <div
            v-for="h in vendorCliRows"
            :key="h.vendor"
            class="vendor-cli-row"
            data-testid="vendor-cli-row"
          >
            <div class="vendor-cli-head">
              <span
                class="vendor-dot"
                :style="{ backgroundColor: vendorColor(h.vendor) }"
                :title="vendorLabel(h.vendor)"
              ></span>
              <span class="diagnostics-vendor">{{ vendorLabel(h.vendor) }}</span>
            </div>
            <div class="vendor-cli-status">
              <span class="vendor-cli-field">
                <span class="vendor-cli-label">{{ t('settings.vendorCli.active.label') }}</span>
                <code :data-testid="`vendor-cli-active-${h.vendor}`">{{
                  h.activeVersion ?? t('settings.vendorCli.none')
                }}</code>
              </span>
              <span class="vendor-cli-field">
                <span class="vendor-cli-label">{{
                  t('settings.vendorCli.downloadTarget.label')
                }}</span>
                <code :data-testid="`vendor-cli-target-${h.vendor}`">{{
                  h.downloadTargetVersion ?? t('settings.vendorCli.none')
                }}</code>
              </span>
              <span v-if="h.lastRemoteCheckAt" class="vendor-cli-field">
                <span class="vendor-cli-label">{{ t('settings.vendorCli.lastCheck.label') }}</span>
                <code>{{ h.lastRemoteCheckAt }}</code>
              </span>
            </div>
            <p
              v-if="h.lastError"
              class="settings-hint vendor-cli-error"
              :data-testid="`vendor-cli-error-${h.vendor}`"
            >
              {{ h.lastError }}
            </p>
            <div class="vendor-cli-versions">
              <label class="vendor-cli-option">
                <input
                  type="radio"
                  :name="`vendor-cli-${h.vendor}`"
                  value=""
                  :checked="activeVersionChoice(h.vendor) === ''"
                  :disabled="!isAdmin"
                  :data-testid="`vendor-cli-auto-${h.vendor}`"
                  @change="setActiveVersion(h.vendor, '')"
                />
                <span>{{ t('settings.vendorCli.auto.label') }}</span>
              </label>
              <label
                v-for="v in h.installedVersions ?? []"
                :key="v.version"
                class="vendor-cli-option"
              >
                <input
                  type="radio"
                  :name="`vendor-cli-${h.vendor}`"
                  :value="v.version"
                  :checked="activeVersionChoice(h.vendor) === v.version"
                  :disabled="!isAdmin"
                  :data-testid="`vendor-cli-version-${h.vendor}`"
                  @change="setActiveVersion(h.vendor, v.version)"
                />
                <code>{{ v.version }}</code>
              </label>
              <p
                v-if="!h.installedVersions || h.installedVersions.length === 0"
                class="settings-hint"
                :data-testid="`vendor-cli-empty-${h.vendor}`"
              >
                {{ t('settings.vendorCli.empty') }}
              </p>
            </div>
          </div>
        </section>

        <!-- Session subprocess proxy (2026-07-01-003) -->
        <section class="settings-section" data-testid="settings-proxy">
          <p class="settings-section-title">{{ t('settings.proxy.title.label') }}</p>
          <label class="consensus-toggle">
            <input
              v-model="proxyCfg.enabled"
              type="checkbox"
              role="switch"
              data-testid="settings-proxy-enabled"
            />
            {{ t('settings.proxy.toggle.label') }}
          </label>
          <p class="settings-hint">{{ t('settings.proxy.hint') }}</p>
          <label class="auth-field">
            <span class="auth-label">{{ t('settings.proxy.httpProxy.label') }}</span>
            <input
              v-model="proxyCfg.httpProxy"
              class="agent-field"
              type="url"
              :disabled="!proxyCfg.enabled"
              :placeholder="proxyCfg.enabled ? 'http://proxy.local:3128' : ''"
              data-testid="settings-proxy-http"
            />
          </label>
          <label class="auth-field">
            <span class="auth-label">{{ t('settings.proxy.httpsProxy.label') }}</span>
            <input
              v-model="proxyCfg.httpsProxy"
              class="agent-field"
              type="url"
              :disabled="!proxyCfg.enabled"
              :placeholder="proxyCfg.enabled ? 'http://proxy.local:3128' : ''"
              data-testid="settings-proxy-https"
            />
          </label>
        </section>
      </div>

      <!-- ============ Security tab ============ -->
      <div
        v-show="activeTab === 'security'"
        class="settings-tab-panel"
        role="tabpanel"
        data-testid="settings-tab-security"
      >
        <!-- Authentication (ADR-0023) -->
        <section class="settings-section" data-testid="settings-auth">
          <p class="settings-section-title">{{ t('settings.auth.title.label') }}</p>
          <p class="settings-hint">{{ t('settings.auth.hint') }}</p>

          <label class="auth-field">
            <span class="auth-label">{{ t('settings.auth.provider.label') }}</span>
            <select
              class="mode-select"
              data-testid="settings-auth-provider"
              :value="authProviderKind"
              @change="setAuthProviderKind(($event.target as HTMLSelectElement).value)"
            >
              <option
                v-for="p in AUTH_PROVIDERS"
                :key="p.value"
                :value="p.value"
                :disabled="p.disabled"
              >
                {{ t(`settings.auth.provider.${p.value}` as 'settings.auth.provider.basic') }}
              </option>
            </select>
          </label>

          <p v-if="isNone" class="settings-hint" data-testid="settings-auth-none-hint">
            {{ t('settings.auth.none.hint') }}
          </p>
          <p
            v-else-if="!adminConfigured"
            class="settings-hint"
            data-testid="settings-auth-need-admin"
          >
            {{ t('settings.auth.enable.needAdmin') }}
          </p>
          <p v-else class="settings-hint" data-testid="settings-auth-active">
            {{ t('settings.auth.enable.active') }}
          </p>

          <div
            v-if="authProviderKind === 'basic'"
            class="auth-accounts"
            data-testid="settings-auth-accounts"
          >
            <p class="settings-hint">{{ t('settings.auth.account.hint') }}</p>
            <!-- Existing accounts: admin radio + name on one line, change-password +
                 remove actions trailing on the same row. Password edit / removal both
                 happen in modals (below) so the row stays a single compact line. -->
            <div
              v-for="acc in basicAccounts"
              :key="acc.username"
              class="auth-account-row"
              data-testid="settings-auth-account-row"
            >
              <label class="auth-admin-pick">
                <input
                  type="radio"
                  name="auth-admin"
                  :checked="acc.username === basicAdminUsername"
                  :disabled="!isAdmin"
                  data-testid="settings-auth-admin-radio"
                  @change="selectAdmin(acc.username)"
                />
                <span class="auth-account-name">{{ acc.username }}</span>
                <span v-if="acc.username === basicAdminUsername" class="auth-admin-badge">{{
                  t('settings.auth.admin.badge')
                }}</span>
              </label>
              <div class="auth-account-actions">
                <button
                  class="icon-btn"
                  :disabled="!isAdmin"
                  data-testid="settings-auth-account-change"
                  @click="startChangePassword(acc.username)"
                >
                  {{ t('settings.auth.password.change.label') }}
                </button>
                <button
                  class="icon-btn"
                  :disabled="!isAdmin"
                  data-testid="settings-auth-account-remove"
                  @click="startRemoveAccount(acc.username)"
                >
                  {{ t('settings.auth.account.remove.label') }}
                </button>
              </div>
            </div>

            <!-- Add a new account — opens a modal. -->
            <div class="auth-account-add-bar">
              <button
                class="agent-add"
                :disabled="!isAdmin"
                data-testid="settings-auth-add-account-open"
                @click="startAddAccount"
              >
                {{ t('settings.auth.account.add.label') }}
              </button>
            </div>
          </div>

          <label class="consensus-toggle">
            <input
              type="checkbox"
              :checked="exposureOn"
              :disabled="!adminConfigured"
              data-testid="settings-auth-exposure"
              @change="setExposure(($event.target as HTMLInputElement).checked)"
            />
            {{ t('settings.auth.exposure.label') }}
          </label>
          <p class="settings-hint">
            {{
              adminConfigured
                ? t('settings.auth.exposure.hint')
                : t('settings.auth.exposure.needAdmin')
            }}
          </p>

          <label class="auth-field">
            <span class="auth-label">{{ t('settings.auth.ttl.label') }}</span>
            <input
              class="agent-field"
              type="number"
              min="1"
              step="1"
              :value="authTtlDays"
              data-testid="settings-auth-ttl"
              @input="setAuthTtlDays(Number(($event.target as HTMLInputElement).value))"
            />
          </label>
          <p class="settings-hint">{{ t('settings.auth.ttl.hint') }}</p>
        </section>
      </div>

      <!-- ============ General tab ============ -->
      <div
        v-show="activeTab === 'general'"
        class="settings-tab-panel"
        role="tabpanel"
        data-testid="settings-tab-general"
      >
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
          <p class="settings-section-title">{{ t('settings.baseUrl.title.label') }}</p>
          <p class="settings-hint">{{ t('settings.baseUrl.hint') }}</p>
          <input
            v-model="draft.baseUrl"
            class="agent-field"
            :disabled="!isAdmin"
            :placeholder="t('settings.baseUrl.placeholder')"
            data-testid="settings-base-url"
          />
        </section>

        <section class="settings-section">
          <p class="settings-section-title">{{ t('settings.display.title.label') }}</p>
          <label class="consensus-toggle">
            <input
              v-model="draft.showToolSessions"
              type="checkbox"
              role="switch"
              :disabled="!isAdmin"
            />
            {{ t('settings.display.showToolSessions.label') }}
          </label>
          <label class="consensus-toggle">
            <input
              v-model="draft.showSessionsPage"
              type="checkbox"
              role="switch"
              :disabled="!isAdmin"
              data-testid="settings-show-sessions-page"
            />
            {{ t('settings.display.showSessionsPage.label') }}
          </label>
          <p class="settings-hint">{{ t('settings.display.showSessionsPage.hint') }}</p>
        </section>
      </div>
    </div>

    <div class="settings-foot">
      <!-- Per-tab Save lives beside Close; only the active tab's Save is shown. -->
      <div v-show="activeTab === 'agent'" class="settings-tab-actions">
        <span
          v-if="tabDirtyMap.agent"
          class="settings-unsaved"
          data-testid="settings-unsaved-agent"
          >{{ t('settings.tabs.unsaved.label') }}</span
        >
        <button data-testid="settings-save-agent" :disabled="!isAdmin" @click="saveTab('agent')">
          {{ t('common.action.save.label') }}
        </button>
      </div>
      <div v-show="activeTab === 'runtime'" class="settings-tab-actions">
        <span
          v-if="tabDirtyMap.runtime"
          class="settings-unsaved"
          data-testid="settings-unsaved-runtime"
          >{{ t('settings.tabs.unsaved.label') }}</span
        >
        <button
          data-testid="settings-save-runtime"
          :disabled="!isAdmin"
          @click="saveTab('runtime')"
        >
          {{ t('common.action.save.label') }}
        </button>
      </div>
      <div v-show="activeTab === 'security'" class="settings-tab-actions">
        <span
          v-if="tabDirtyMap.security"
          class="settings-unsaved"
          data-testid="settings-unsaved-security"
          >{{ t('settings.tabs.unsaved.label') }}</span
        >
        <button
          data-testid="settings-save-security"
          :disabled="!isAdmin"
          @click="saveTab('security')"
        >
          {{ t('common.action.save.label') }}
        </button>
      </div>
      <div v-show="activeTab === 'general'" class="settings-tab-actions">
        <span
          v-if="tabDirtyMap.general"
          class="settings-unsaved"
          data-testid="settings-unsaved-general"
          >{{ t('settings.tabs.unsaved.label') }}</span
        >
        <button
          data-testid="settings-save-general"
          :disabled="!isAdmin"
          @click="saveTab('general')"
        >
          {{ t('common.action.save.label') }}
        </button>
      </div>
      <button class="ghost" data-testid="settings-close" @click="emit('close')">
        {{ t('common.action.close.label') }}
      </button>
    </div>

    <!-- Confirm leaving a tab with unsaved changes (the draft is kept, not lost). -->
    <ConfirmDialog
      :open="pendingTabSwitch !== null"
      :title="t('settings.tabs.switch.confirm.title')"
      :message="t('settings.tabs.switch.confirm.body')"
      :confirm-label="t('settings.tabs.switch.confirm.confirm')"
      :cancel-label="t('settings.tabs.switch.confirm.stay')"
      @confirm="confirmTabSwitch"
      @cancel="cancelTabSwitch"
    />

    <!-- Add-account modal. -->
    <div
      v-if="showAddModal"
      class="settings-modal-overlay"
      data-testid="settings-auth-add-modal"
      @click.self="cancelAddAccount"
    >
      <div class="settings-modal" role="dialog" aria-modal="true">
        <div class="settings-modal-head">
          <h3>{{ t('settings.auth.account.add.label') }}</h3>
          <button
            class="icon-btn"
            :title="t('common.action.close.tooltip')"
            @click="cancelAddAccount"
          >
            ✕
          </button>
        </div>
        <label class="auth-field">
          <span class="auth-label">{{ t('settings.auth.username.label') }}</span>
          <input
            v-model="addUsername"
            class="agent-field"
            autocomplete="username"
            :placeholder="t('settings.auth.username.placeholder')"
            data-testid="settings-auth-add-username"
          />
        </label>
        <label class="auth-field">
          <span class="auth-label">{{ t('settings.auth.password.new.label') }}</span>
          <input
            v-model="addPassword"
            class="agent-field"
            type="password"
            autocomplete="new-password"
            :placeholder="t('settings.auth.password.new.placeholder')"
            data-testid="settings-auth-add-password"
          />
        </label>
        <p v-if="addUsernameTaken" class="settings-hint" data-testid="settings-auth-add-duplicate">
          {{ t('settings.auth.account.duplicate') }}
        </p>
        <div class="settings-modal-foot">
          <button class="ghost" @click="cancelAddAccount">
            {{ t('common.action.cancel.label') }}
          </button>
          <button
            class="agent-add"
            :disabled="
              !isAdmin || !addUsername.trim() || addUsernameTaken || addPassword.length < 4
            "
            data-testid="settings-auth-add-account"
            @click="submitAddAccount"
          >
            {{ t('settings.auth.account.add.label') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Change-password modal (driven by pwTarget). -->
    <div
      v-if="pwTarget"
      class="settings-modal-overlay"
      data-testid="settings-auth-change-password"
      @click.self="cancelChangePassword"
    >
      <div class="settings-modal" role="dialog" aria-modal="true">
        <div class="settings-modal-head">
          <h3>{{ t('settings.auth.password.change.label') }}</h3>
          <button
            class="icon-btn"
            :title="t('common.action.close.tooltip')"
            @click="cancelChangePassword"
          >
            ✕
          </button>
        </div>
        <p class="settings-hint auth-modal-target">{{ pwTarget }}</p>
        <label class="auth-field">
          <span class="auth-label">{{ t('settings.auth.password.current.label') }}</span>
          <input
            v-model="pwCurrent"
            class="agent-field"
            type="password"
            autocomplete="current-password"
            :placeholder="t('settings.auth.password.current.placeholder')"
            data-testid="settings-auth-current-password"
          />
        </label>
        <label class="auth-field">
          <span class="auth-label">{{ t('settings.auth.password.new.label') }}</span>
          <input
            v-model="pwNew"
            class="agent-field"
            type="password"
            autocomplete="new-password"
            :placeholder="t('settings.auth.password.new.placeholder')"
            data-testid="settings-auth-new-password"
          />
        </label>
        <div class="settings-modal-foot">
          <button class="ghost" @click="cancelChangePassword">
            {{ t('common.action.cancel.label') }}
          </button>
          <button
            class="agent-add"
            :disabled="pwNew.length < 4"
            data-testid="settings-auth-set-password"
            @click="submitChangePassword"
          >
            {{ t('settings.auth.password.change.label') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Remove-account confirmation modal (driven by removeTarget). -->
    <div
      v-if="removeTarget"
      class="settings-modal-overlay"
      data-testid="settings-auth-remove-confirm"
      @click.self="cancelRemoveAccount"
    >
      <div class="settings-modal" role="dialog" aria-modal="true">
        <div class="settings-modal-head">
          <h3>{{ t('settings.auth.account.remove.confirm.title') }}</h3>
          <button
            class="icon-btn"
            :title="t('common.action.close.tooltip')"
            @click="cancelRemoveAccount"
          >
            ✕
          </button>
        </div>
        <p class="settings-hint">
          {{ t('settings.auth.account.remove.confirm.body', { username: removeTarget }) }}
        </p>
        <div class="settings-modal-foot">
          <button
            class="ghost"
            data-testid="settings-auth-remove-cancel"
            @click="cancelRemoveAccount"
          >
            {{ t('common.action.cancel.label') }}
          </button>
          <button
            class="agent-remove"
            data-testid="settings-auth-remove-confirm-btn"
            @click="confirmRemoveAccount"
          >
            {{ t('settings.auth.account.remove.label') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
