<script setup lang="ts">
/*
 * SettingsPanel.vue — 系统设置页：配置按 Agent / Runtime / Security / General 四个 Tab 分组。
 *
 * 每个 Tab 维护独立草稿与脏状态,并提供独立保存按钮:保存时只用当前 Tab 白名单字段覆盖
 * 「最新已提交快照」构造完整 SystemSettings 发送,不携带其他 Tab 草稿(见 TAB_FIELDS)。
 * 面板打开期间的设置回推按字段归属合并,只有首次打开整体播种;即时持久化字段
 * (账号列表/管理员)总是同步,脏 Tab 的其余字段草稿受保护。保存后面板保持打开。
 * 切换存在未保存修改的 Tab 时二次确认,确认后仅切换、不保存也不丢弃草稿。
 */
import { computed, nextTick, ref, toRaw, watch } from 'vue'
import {
  GROUP_AGENT_PREFIX,
  SYSTEM_AGENT_ID,
  VENDOR_IDS,
  deriveConfigMode,
  hasProviderConfig,
} from '@ccc/shared/protocol'
import { resolveDefaultAgentId } from '@ccc/shared'
import type {
  AgentConfig,
  AuthConfig,
  SessionBindingStats,
  SandboxHostStatus,
  SystemSettings,
  ModelProvider,
  ProviderMigrationPlan,
  VendorHostStatus,
  VendorId,
  UserWorkspaceAccessAccount,
  VendorRuntimeStatus,
  WorkspaceInfo,
  WorkspaceScopeMode,
} from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'
import { VENDOR_COLOR, VENDOR_LABEL, vendorRowTint } from '@/lib/vendor'
import {
  vendorCliDegradationKey,
  vendorRuntimeOriginKey,
  vendorUnavailableReasonKey,
} from '@/lib/vendor-runtime'
import { listGroupAgents } from '@/lib/group-agents'
import { useAuth } from '@/composables/useAuth'
import { deepCopy, useTabbedDraftSave } from '@/composables/useTabbedDraftSave'
import type { SystemSettingsTarget } from '@/lib/action-descriptor'
import ConfirmDialog from '@/components/ConfirmDialog/ConfirmDialog.vue'
import TabNav from '@/components/TabNav/TabNav.vue'
import EmojiPicker from './EmojiPicker.vue'
import UserAccess from '../UserAccess/UserAccess.vue'
import ModelProviders from '../ModelProviders/ModelProviders.vue'
import type { ProviderProbeState } from '@/lib/model-provider'

const { t } = useTypedI18n()

// Whether this connection is the unique admin (ADR-0023 authz). Non-admins get a
// read-only panel: every Save + the account-management controls are disabled and a
// notice explains why. The server enforces the same gate regardless — this is UX only.
const { isAdmin } = useAuth()

// 浏览器本地时区，作为 timezone 草稿的默认值与 timezone 列表不可用时的兜底项。
const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone

// 会话清理的默认保留天数，与服务端 DEFAULT_SESSION_RETENTION_DAYS 保持一致。
const DEFAULT_SESSION_RETENTION_DAYS = 30

// 浏览器语音输入的可选识别语言（BCP-47）。与 UI 语言（UI_LANGS）彻底解耦。
const VOICE_LANGS = computed<{ value: string; label: string }[]>(() => [
  { value: 'zh-CN', label: t('settings.voiceLang.zhCN.label') },
  { value: 'en-US', label: t('settings.voiceLang.enUS.label') },
  { value: 'zh-TW', label: t('settings.voiceLang.zhTW.label') },
  { value: 'zh-HK', label: t('settings.voiceLang.zhHK.label') },
])

const props = withDefaults(
  defineProps<{
    open: boolean
    settings: SystemSettings | null
    hostStatus?: VendorHostStatus[]
    /** 每个 vendor 的运行时可用性(App 层由 settings 回包统一派生)。 */
    vendorAvailability?: Partial<Record<VendorId, VendorRuntimeStatus>>
    sandboxStatus?: SandboxHostStatus | null
    bindingStats?: SessionBindingStats | null
    /** 已注册工作区,供账号/共享等需要选择工作区的区块引用。 */
    workspaces?: WorkspaceInfo[]
    /** 一次性定位目标:落到某个 Tab 并在其中定位一行配置。消费后由父组件清空。 */
    target?: SystemSettingsTarget | null
    /** 账号 × 工作区名册;`null` = 尚未取到(或非管理员,服务端拒答)。 */
    userAccessAccounts?: UserWorkspaceAccessAccount[] | null
    /** 「用户与访问」勾选项的工作区来源 —— 由该名册回包携带,而非侧栏可见列表。 */
    userAccessWorkspaces?: WorkspaceInfo[]
    /** 内联配置 → provider 的迁移报告;`null` = 尚未取到。 */
    providerMigrationPlan?: ProviderMigrationPlan | null
    /** provider 连接探测结果,键为 `${providerId}:${vendor}`。 */
    providerProbes?: Record<string, ProviderProbeState>
  }>(),
  {
    hostStatus: () => [],
    vendorAvailability: () => ({}),
    sandboxStatus: null,
    bindingStats: null,
    workspaces: () => [],
    target: null,
    userAccessAccounts: null,
    userAccessWorkspaces: () => [],
    providerMigrationPlan: null,
    providerProbes: () => ({}),
  },
)

// ---- Tab grouping (2026-07-11-001) ----------------------------------------
// The four settings tabs and, per tab, the exact SystemSettings fields it owns.
// This map is the single save whitelist: saving a tab overlays ONLY these fields
// (transformed) onto the latest committed snapshot, so a tab's Save never carries
// another tab's unsaved draft. Host diagnostics (Runtime) render read-only from
// `hostStatus`, not from settings, so they are not listed here.
//
// `access` is field-less: it edits authorization state (which account reaches
// which workspace), which lives in its own store and is saved per account by its
// own message. Listing it with no fields is what keeps it out of every
// whole-object settings save — in both directions.
type SettingsTab = 'agent' | 'provider' | 'runtime' | 'security' | 'general' | 'access'
const TABS: SettingsTab[] = ['agent', 'provider', 'runtime', 'security', 'general', 'access']
const TAB_FIELDS: Record<SettingsTab, (keyof SystemSettings)[]> = {
  access: [],
  // provider 与 agent 分属两个页签,却互相引用:agent 上的 providerId 指向这里的记录。
  // 各自只保存自己的字段,所以「在 agent 页签选一个还没保存的 provider」需要先保存 provider
  // 页签 —— 表单的新建入口因此是跳到本页签,而不是就地造一条草稿记录。
  provider: ['modelProviders'],
  agent: [
    'agents',
    'defaultAgentId',
    'toolAgentId',
    'intentAgentId',
    'specAgentId',
    'specReviewAgentId',
    'automationAgentId',
  ],
  runtime: ['vendorCliVersions', 'proxy', 'sessionCleanup'],
  security: ['auth'],
  general: ['voiceLang', 'timezone', 'baseUrl', 'showToolSessions', 'showSessionsPage'],
}
function tabLabel(tab: SettingsTab): string {
  return t(`settings.tabs.${tab}.label` as 'settings.tabs.agent.label')
}

// The access tab is offered only to the administrator. This is presentation, not
// the gate: the server refuses both access messages from anyone else regardless.
// Hiding it here just avoids showing a tab whose every request would be refused.
const visibleTabs = computed<SettingsTab[]>(() =>
  TABS.filter((tab) => tab !== 'access' || isAdmin.value),
)

// Canonical vendor display order — the shared list, so a newly registered vendor
// appears in every picker/panel here instead of being silently omitted.
const VENDOR_ORDER: readonly VendorId[] = VENDOR_IDS

/** Active vendor sub-tab under the Agent settings tab (no "All" overview).
 *  Declared early so the one-shot locate watcher can switch it before querying rows. */
const activeAgentVendor = ref<VendorId>(VENDOR_ORDER[0])

/** 一行运行时诊断:中立可用性 + (仅宿主 CLI 才有的)探测详情。 */
interface DiagnosticsRow {
  vendor: VendorId
  status: VendorRuntimeStatus
  /** 该 vendor 的宿主 CLI 探测结果;探测不到时缺席。 */
  host?: VendorHostStatus
}

// Runtime diagnostics rows — one per vendor. Availability and the reason come
// from the neutral signal; the probe-only columns (resolved path, install hint)
// render only where a host probe actually exists.
const diagnostics = computed<DiagnosticsRow[]>(() => {
  const byVendor = new Map(props.hostStatus.map((h) => [h.vendor, h]))
  return VENDOR_ORDER.map((vendor) => {
    const host = byVendor.get(vendor)
    const status: VendorRuntimeStatus = props.vendorAvailability[vendor] ?? {
      vendor,
      available: host?.present ?? false,
      runtime: 'host-cli',
      ...(host ? { runtimeId: host.binary } : {}),
      ...(host?.present ? {} : { reason: 'host-cli-missing' }),
    }
    return { vendor, status, ...(host ? { host } : {}) }
  })
})
function diagnosticsReason(row: DiagnosticsRow): string {
  const key = vendorUnavailableReasonKey(row.status)
  return key ? t(key) : ''
}
/** Provenance of a resolved runtime — installed, shipped sidecar, or an override. */
function diagnosticsOrigin(row: DiagnosticsRow): string {
  const key = vendorRuntimeOriginKey(row.status)
  return key ? t(key) : ''
}
// Vendor CLI multi-version panel rows: each vendor's installed versions +
// runtime/download status, in canonical vendor order. Only vendors c3 launches as
// a host CLI have a `hostStatus` entry, so an SDK-backed vendor drops out here
// without being named — it has no binary to install, pin or sync.
const vendorCliRows = computed(() => {
  const byVendor = new Map(props.hostStatus.map((h) => [h.vendor, h]))
  return VENDOR_ORDER.map((v) => byVendor.get(v)).filter(
    (h): h is VendorHostStatus => h !== undefined,
  )
})
// 固定版本用不了、但 c3 成功回退到另一个版本时的提示。服务端只给原因码与两个版本号,
// 措辞在这里本地化 —— 提示里的固定版本绝不能叫「当前生效」,那是上面那个字段的含义
// (实际运行的版本),同一个词指两件事正是这条提示要修掉的歧义。
function vendorCliDegradationNotice(h: VendorHostStatus): string {
  const key = vendorCliDegradationKey(h.degradation)
  if (!key || !h.degradation) return ''
  return t(key, {
    pinnedVersion: h.degradation.pinnedVersion,
    resolvedVersion: h.degradation.resolvedVersion,
  })
}
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
  // Upsert a basic account's password (ADR-0023). The plaintext is sent to the
  // server which hashes it; the panel never computes or persists a hash. A new
  // username adds an account (no currentPassword); an existing one changes it
  // (currentPassword required).
  'set-password': [payload: { username: string; password: string; currentPassword?: string }]
  // Remove a basic account.
  'remove-account': [payload: { username: string }]
  // Designate which basic account is the single admin.
  'set-admin-account': [payload: { username: string }]
  // Probe the runnable vendors and persist a system-mode agent for each that has
  // none. Deliberately NOT part of `save`: it bypasses the tab draft entirely and
  // lands server-side at once, so the cold-start user gets a usable agent from one
  // click instead of a click plus a Save they have no reason to trust yet.
  'auto-configure-agents': []
  // The one-shot `target` was acted on (located, or resolved to its fallback);
  // the owner clears it so reopening the panel does not jump again.
  'target-consumed': []
  // Re-read the account × workspace roster.
  'reload-user-access': []
  // Replace ONE account's workspace policy. Never part of `save`: authorization
  // state and system configuration are saved by different messages on purpose.
  'save-user-access': [payload: { subject: string; mode: WorkspaceScopeMode; workspaces: string[] }]
  // 迁移与探测都不是「保存一份配置」:前者要服务端对整个注册表算,后者要服务端替我们拨号。
  // 它们各自即时生效,不进草稿、也不参与任何 Save。
  'provider-migrate': [
    payload: {
      action: 'plan' | 'apply' | 'revert' | 'clear'
      providerIds?: string[]
      agentIds?: string[]
    },
  ]
  'provider-probe': [payload: { providerId: string; vendor: VendorId }]
}>()

// A default, empty SystemSettings — the shape both `draft` and `committed` start
// from before the panel is ever seeded (keeps the dirty computeds crash-free).
function emptySettings(): SystemSettings {
  return {
    agents: [],
    modelProviders: [],
    defaultAgentId: SYSTEM_AGENT_ID,
    // '' ⇒ background tool sessions follow the default agent.
    toolAgentId: '',
    // '' ⇒ intent-communication sessions follow the default agent.
    intentAgentId: '',
    // '' ⇒ spec-authoring sessions follow the default agent.
    specAgentId: '',
    // '' ⇒ spec-review sessions follow the default agent.
    specReviewAgentId: '',
    // '' ⇒ the new-automation form pre-fills with the default agent.
    automationAgentId: '',
    voiceLang: 'zh-CN',
    timezone: BROWSER_TZ,
    baseUrl: '',
    showToolSessions: false,
    showSessionsPage: false,
    proxy: { enabled: false, httpProxy: '', httpsProxy: '' },
    sessionCleanup: { enabled: false, retentionDays: DEFAULT_SESSION_RETENTION_DAYS },
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

/**
 * Session-store cleanup (system-wide). Same pattern as `proxyCfg`: the block is
 * optional on `SystemSettings`, so the form binds a concrete mirror ref and a
 * watcher writes it back into the draft for dirty detection and the Save payload.
 * Both fields are always present here — "off" and the default window are what an
 * unconfigured server means.
 */
const cleanupCfg = ref<{ enabled: boolean; retentionDays: number }>({
  enabled: false,
  retentionDays: DEFAULT_SESSION_RETENTION_DAYS,
})
watch(
  cleanupCfg,
  (c) => {
    draft.value.sessionCleanup = { ...c }
  },
  { deep: true },
)
// Seed cleanupCfg from the current draft (used after a full seed / a resync).
function syncCleanupRef(): void {
  const c = draft.value.sessionCleanup
  cleanupCfg.value = {
    enabled: c?.enabled === true,
    retentionDays: c?.retentionDays ?? DEFAULT_SESSION_RETENTION_DAYS,
  }
}

/**
 * The retention window bound to the number input. Mirrors the server normalize
 * (floor, minimum 1) so the field never holds a value the server would reject.
 */
const retentionDays = computed<number>({
  get: () => cleanupCfg.value.retentionDays,
  set: (val: number) => {
    const days = Number.isFinite(val) && val > 0 ? Math.max(1, Math.floor(val)) : 1
    cleanupCfg.value = { ...cleanupCfg.value, retentionDays: days }
  },
})

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
    // '' ⇒ spec-review sessions follow the default agent.
    specReviewAgentId: settings.specReviewAgentId ?? '',
    // '' ⇒ the new-automation form pre-fills with the default agent (AC-R25).
    automationAgentId: settings.automationAgentId ?? '',
    voiceLang: settings.voiceLang ?? 'zh-CN',
    timezone: settings.timezone ?? BROWSER_TZ,
    baseUrl: settings.baseUrl ?? '',
    showToolSessions: settings.showToolSessions ?? false,
    showSessionsPage: settings.showSessionsPage === true,
    proxy: settings.proxy ?? { enabled: false, httpProxy: '', httpsProxy: '' },
    // Cleanup is opt-in: an absent block seeds as off with the default window, so
    // draft and committed share one shape and the tab isn't spuriously dirty.
    sessionCleanup: {
      enabled: settings.sessionCleanup?.enabled === true,
      retentionDays: settings.sessionCleanup?.retentionDays ?? DEFAULT_SESSION_RETENTION_DAYS,
    },
    // Effective vendor CLI version selection per vendor (empty object ⇒ auto latest
    // for both). Carried explicitly so the radios bind to the draft.
    vendorCliVersions: { ...(settings.vendorCliVersions ?? {}) },
  }
}

// Sync only the immediate-persist sub-fields of a (dirty, protected) tab from
// `seed`: the basic-account list + admin designation (Security). These are persisted
// by dedicated paths that do not wait for a tab's Save, so they must reflect the
// server even while the rest of the tab stays dirty.
function syncImmediateFields(tab: SettingsTab, target: SystemSettings, src: SystemSettings): void {
  if (tab === 'security') {
    if (target.auth?.provider.kind === 'basic' && src.auth?.provider.kind === 'basic') {
      target.auth.provider.accounts = src.auth.provider.accounts.map((a) => ({ ...a }))
      target.auth.provider.adminUsername = src.auth.provider.adminUsername
    }
  }
}

// 自动配置是绕过页签草稿的即时落库动作。它下一次 settings 回推若确实
// 新增了 agent,受保护(脏)的 agent 页草稿必须让位给服务端权威值——否则用户随后在
// agent 页保存,会用旧草稿覆盖并删掉刚自动创建的智能体。仅当注册表实际增长时才
// 重置;0 结果的回推(无可用 vendor)不动用户草稿。
const pendingAgentReseed = ref(false)
function onAutoConfigureAgents(): void {
  pendingAgentReseed.value = true
  emit('auto-configure-agents')
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
    if (!prevOpen) {
      seedAll(seed)
      pendingAgentReseed.value = false
    } else {
      // The auto-configure echo: only when the registry actually grew does the
      // agent tab yield its draft (see `pendingAgentReseed` above).
      const grew = pendingAgentReseed.value && seed.agents.length > committed.value.agents.length
      reconcile(seed, grew ? new Set<SettingsTab>(['agent']) : undefined)
      pendingAgentReseed.value = false
    }
    syncProxyRef()
    syncCleanupRef()
  },
  { immediate: true },
)

// ---- One-shot locate (a derived next-step deep link) ----------------------
// A blocked-state banner elsewhere in the app asks the panel to land on a tab and
// point at one row. The jump NAVIGATES ONLY: it never toggles an agent, edits a
// credential, or saves. It also never bypasses the dirty-tab guard — `requestTab`
// still opens the confirm dialog, and the row is located once the user confirms.

// The target still waiting to be pointed at (held across the tab-switch confirm
// and across the settings pushback that first fills `draft.agents`).
const pendingLocate = ref<SystemSettingsTarget | null>(null)
// The row that just got located — drives a brief highlight so the eye lands on it.
const locatedAgentId = ref<string | null>(null)
// True when the target's agent row no longer exists (deleted after it failed). The
// panel still opens on its vendor's configuration; this is a non-blocking notice,
// never a modal or a dead end.
const locateMissing = ref(false)
let highlightTimer: ReturnType<typeof setTimeout> | undefined
const agentListEl = ref<HTMLElement | null>(null)

function highlight(agentId: string | null): void {
  locatedAgentId.value = agentId
  clearTimeout(highlightTimer)
  if (agentId === null) return
  highlightTimer = setTimeout(() => {
    locatedAgentId.value = null
  }, 2000)
}

// Point at the pending target's row. Falls back to the first row of the same
// vendor when the exact agent is gone, so the user still lands on the right
// configuration context instead of the top of a long list.
function locateNow(): void {
  const target = pendingLocate.value
  if (!target) return
  const rows = Array.from(agentListEl.value?.querySelectorAll<HTMLElement>('[data-agent-id]') ?? [])
  const exact = rows.find((el) => el.dataset.agentId === target.agentId)
  const fallback = exact ?? rows.find((el) => el.dataset.agentVendor === target.vendor)
  pendingLocate.value = null
  locateMissing.value = !exact
  emit('target-consumed')
  if (!fallback) return
  fallback.scrollIntoView({ block: 'center' })
  fallback.querySelector<HTMLElement>('input, select, button')?.focus()
  highlight(exact ? target.agentId : null)
}

// The access roster is fetched when its tab is actually shown, not when the panel
// opens: it is administrator-only, so asking for it up front would have every
// ordinary account's panel open with a refusal it did not ask for.
watch(
  () => [props.open, activeTab.value, isAdmin.value] as const,
  ([open, tab, admin]) => {
    if (open && tab === 'access' && admin) emit('reload-user-access')
  },
  { immediate: true },
)

// Arm the locate when a target arrives, then request the Agent tab. `requestTab`
// is the dirty guard: a clean tab switches immediately, a dirty one opens the
// confirm and the locate waits for the user's answer.
watch(
  () => props.target,
  (target) => {
    if (!target || !props.open) return
    pendingLocate.value = target
    locateMissing.value = false
    requestTab(target.tab)
  },
  { immediate: true },
)

// Fire (or re-fire) the locate once the Agent tab is actually showing AND the
// rows exist — the settings pushback that fills `draft.agents` often lands after
// the target does. Switch the vendor sub-tab first so the row is in the DOM.
watch(
  () => [activeTab.value, draft.value.agents.length, pendingLocate.value] as const,
  ([tab, agentCount, target]) => {
    if (!target || tab !== target.tab || agentCount === 0) return
    activeAgentVendor.value = target.vendor
    void nextTick(locateNow)
  },
)

// Abandoning the tab switch abandons the jump: leaving it armed would make the
// panel lurch to the Agent tab the next time the user switches tabs themselves.
function onCancelTabSwitch(): void {
  cancelTabSwitch()
  if (!pendingLocate.value) return
  pendingLocate.value = null
  emit('target-consumed')
}

// Closing the panel drops any leftover highlight/notice so a later open is clean.
watch(
  () => props.open,
  (open) => {
    if (open) return
    pendingLocate.value = null
    locateMissing.value = false
    highlight(null)
  },
)

// Agent 类型(vendor)选项。vendor 决定启动哪个客户端;连接来源则由 providerId 决定
// —— 见下方的 provider 三态。
const VENDORS: readonly VendorId[] = VENDOR_ORDER

/**
 * Whether a vendor can be chosen for a new/edited agent. Gated purely on the
 * neutral runtime signal — a vendor whose runtime is missing (no CLI on this
 * host, or an SDK this build cannot resolve) would produce an agent that can
 * never start, so it is offered disabled with the reason next to it rather than
 * silently accepted. An agent already configured for such a vendor stays visible
 * and editable; it just cannot be newly selected.
 */
function vendorAvailable(v: VendorId): boolean {
  return props.vendorAvailability[v]?.available ?? false
}
/** 为什么某个 vendor 不能选(已本地化);可用时为空串。 */
function vendorUnavailableReason(v: VendorId): string {
  const key = vendorUnavailableReasonKey(props.vendorAvailability[v])
  return key ? t(key) : ''
}
/** 下拉里被禁用选项的后缀说明 —— 原因就写在选项上,不用用户去别处找。 */
function vendorOptionLabel(v: VendorId): string {
  const reason = vendorUnavailableReason(v)
  return reason ? `${VENDOR_LABELS[v]} — ${reason}` : VENDOR_LABELS[v]
}
/** 草稿里所有当前不可用的 vendor 的原因说明,列在 agent 表格下方。 */
const unavailableVendorNotes = computed(() =>
  VENDORS.filter((v) => !vendorAvailable(v))
    .map((v) => ({ vendor: v, label: VENDOR_LABELS[v], reason: vendorUnavailableReason(v) }))
    .filter((n) => n.reason !== ''),
)

// Vendor display names are product identifiers (do-not-translate, see
// specs/style/i18n-terms.md) rendered as bound data — same exemption pattern as
// UI_LANG_LABELS — so they don't go through `t`.
const VENDOR_LABELS: Record<VendorId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
}

// configMode is a c3 concept, so it IS localized.
function configModeLabel(m: 'system' | 'custom'): string {
  return m === 'system'
    ? t('settings.agents.configMode.system.label')
    : t('settings.agents.configMode.custom.label')
}

// ---- Provider 引用(agent 连接来源的三态)----
//
// 一个 agent 的连接来自三处之一,下拉里就是这三态:
//   1. 具名 provider —— 选中它的 id;
//   2. vendor CLI 自带登录 —— 空值;
//   3. 旧的内联三元组 —— 还没迁移的历史配置,只读地显示为一个独占选项。
// configMode 不再由用户直接选:它由前两态派生(deriveConfigMode),第三态是迁移前的过渡。
// 让用户改的是「连接从哪来」,而不是一个抽象的模式名。

/** 旧内联残留的下拉取值。以 `_` 开头,不可能与真实 provider id 冲突。 */
const INLINE_OPTION = '_c3_inline'
/** 「去新建一个 provider」的下拉取值。同样不会与真实 id 冲突。 */
const NEW_PROVIDER_OPTION = '_c3_new'

const providers = computed<ModelProvider[]>(() => draft.value.modelProviders ?? [])

/** 该 vendor 真正接得上的 provider —— 只列声明了这条 vendor 连接的。 */
function providersFor(vendor: VendorId): ModelProvider[] {
  return providers.value.filter((p) => !!p.connections[vendor]?.baseUrl)
}

/** 仍在用旧内联三元组的 agent:没选 provider,但自己带着 baseUrl。 */
function isLegacyInline(a: AgentConfig): boolean {
  return hasProviderConfig(a) && !a.providerId && a.configMode === 'custom' && !!a.config.baseUrl
}

/** 引用了一个已不存在的 provider。服务端 fail-soft 回落,这里只做可见提示。 */
function isDanglingProvider(a: AgentConfig): boolean {
  return !!a.providerId && !providers.value.some((p) => p.id === a.providerId)
}

function providerSelectValue(a: AgentConfig): string {
  if (a.providerId) return a.providerId
  return isLegacyInline(a) ? INLINE_OPTION : ''
}

/**
 * 改连接来源。选 provider ⇒ 记下 id 并把 configMode 置为 custom;选「CLI 自带登录」⇒
 * 清掉 id 并置为 system —— 存的 configMode 此时的唯一作用,是让旧的内联字段不再被使用
 * (它们仍留在草稿里,直到用户在 provider 页签明确清理)。
 */
function setAgentProvider(a: AgentConfig, value: string): void {
  // 内联残留是状态的展示,不是可选项:选它没有任何新含义。
  if (value === INLINE_OPTION) return
  // 「新建 provider」不在这里就地造一条草稿记录:provider 与 agent 分属两个页签、各存各的
  // 字段,就地新建会让用户在 agent 页签 Save 之后发现新 provider 没被保存。改为把他送到
  // provider 页签(走既有的脏页签确认),回来时下拉里就有那条记录了。
  if (value === NEW_PROVIDER_OPTION) {
    requestTab('provider')
    return
  }
  if (!value) {
    delete a.providerId
    a.configMode = 'system'
    return
  }
  a.providerId = value
  a.configMode = 'custom'
}

/** 只读的派生模式标签 —— 与服务端 normalize 用的是同一条规则。 */
function derivedModeLabel(a: AgentConfig): string {
  return configModeLabel(deriveConfigMode(a))
}

/**
 * model 输入框的候选:选了 provider 就是它的目录,否则是所有能服务该 vendor 的 provider 的
 * 目录合起来 —— 后者就是「先想好用哪个模型,再反查谁提供它」的入口。
 */
function modelSuggestions(a: AgentConfig): { value: string; label: string }[] {
  const pool = a.providerId
    ? providers.value.filter((p) => p.id === a.providerId)
    : providersFor(a.vendor)
  const out: { value: string; label: string }[] = []
  for (const p of pool) {
    for (const m of p.models ?? []) {
      if (m.id) out.push({ value: m.id, label: `${m.id} — ${p.displayName}` })
    }
  }
  return out
}

/**
 * model-first 反查:在还没选 provider 的 agent 上填了一个只有某一个 provider 提供的模型,
 * 就把那个 provider 一并选上。有歧义(多个 provider 都提供)时什么也不做 —— 替用户在两个
 * 上游之间做选择,比让他多点一下要糟。
 */
function onModelPicked(a: AgentConfig): void {
  if (a.providerId || !hasProviderConfig(a)) return
  const model = a.config.model.trim()
  if (!model) return
  const owners = providersFor(a.vendor).filter((p) => (p.models ?? []).some((m) => m.id === model))
  if (owners.length === 1) setAgentProvider(a, owners[0].id)
}

/**
 * Whether the STORED registry still has nothing a user chose — empty, or holding
 * only the synthesized fallback (`id === SYSTEM_AGENT_ID`, the record the server
 * conjures so a session is never locked out). This is what gates the one-click
 * bootstrap CTA.
 *
 * Judged against the server snapshot, NOT the draft, on purpose: the action
 * bypasses the draft and writes server-side immediately, so the question it
 * answers is "is anything actually configured?". Reading the draft would hide the
 * CTA the moment someone added an unsaved blank row — leaving the registry as
 * empty as it was, with the one affordance that would have fixed it now gone.
 */
const agentsUnconfigured = computed<boolean>(() => {
  const agents = props.settings?.agents ?? []
  return !agents.some((a) => a.id !== SYSTEM_AGENT_ID)
})

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
    case 'cursor':
      // Cursor's SDK takes a key and a model but cannot be pointed at another
      // provider (c3 has no relay speaking its protocol), so it is always `system`
      // and carries no base URL.
      return { ...base, vendor, configMode: 'system', config: { apiKey: '', model: '' } }
  }
}

/** Monotonic counter behind {@link mintAgentId} — see there. */
let agentIdSeq = 0

/** Mint an agent id from the current millisecond plus a monotonic counter.
 *  The timestamp base makes an id read as its creation time; the counter keeps
 *  two ids minted inside the same millisecond apart. Purely numeric on purpose:
 *  an id flows into the UI, logs, session bindings and branch names, so it must
 *  not carry placeholder words like `new`/`copy`. */
function mintAgentId(): string {
  return `${Date.now()}-${agentIdSeq++}`
}

function addAgent() {
  // Locally-unique id so the default-agent radio can target it before save; the
  // server keeps it as-is (only id-less agents get a freshly minted one on normalize).
  // New agents land on the active vendor sub-tab (vendor matches the tab).
  const id = mintAgentId()
  const vendor = activeAgentVendor.value
  draft.value.agents.push(
    makeAgent(vendor, {
      id,
      configMode: vendor === 'cursor' ? 'system' : 'custom',
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
  // The option is rendered disabled, so this only fires for a value the browser
  // should never have submitted — refuse it anyway rather than build an agent
  // whose vendor has no runtime to launch.
  if (!vendorAvailable(vendor)) return
  // A group holds one vendor (ADR-0029). Retyping a member that is no longer alone
  // in its group would split the container into two invisible pools, so it falls
  // back to `default` instead — the change the user asked for still lands. Same when
  // the new vendor already has a group of that name: the row would silently join a
  // pool the user never dragged it into.
  const group = groupOf(a)
  const leavesGroup =
    group !== DEFAULT_GROUP &&
    draft.value.agents.some(
      (x) => x !== a && groupOf(x) === group && (x.vendor === a.vendor || x.vendor === vendor),
    )
  if (leavesGroup) notifyGroup(t('settings.agents.group.notice.vendorChanged', { group }))
  draft.value.agents[idx] = makeAgent(vendor, {
    id: a.id,
    configMode: a.configMode,
    displayName: a.displayName,
    icon: a.icon ?? '',
    enabled: a.enabled !== false,
    group: leavesGroup ? DEFAULT_GROUP : group,
  })
  // Follow the row onto its new vendor sub-tab so tint / edits stay on-screen.
  activeAgentVendor.value = vendor
}

// An agent counts as enabled unless explicitly disabled (back-compat with
// configs/drafts that predate the field).
function isEnabled(a: AgentConfig): boolean {
  return a.enabled !== false
}

// The default-agent dropdown only offers enabled agents, in the visual grouped
// order (= the order_seq order before Save stamps it).
const defaultPickerAgents = computed<AgentConfig[]>(() => flatAgents.value.filter(isEnabled))

// Virtual group agents (`_c3_<group>`, ADR-0029) offered alongside real agents in
// every agent picker; selecting one binds the session/role to the group (relay
// failover across its members). Derived client-side from the draft's `group` fields.
const pickerGroupAgents = computed(() => listGroupAgents(draft.value.agents))

// Toggle an agent's enabled flag. If this disables (or the inverse — never)
// the current default, fall through to the next enabled agent and persist that
// rewrite (mirrors the server `normalize`, AC-R2/AC-R10). Recompute against the
// visual grouped order so the choice tracks order_seq. The tool agent follows the
// same fall-through, but ONLY when it's explicitly set: an empty toolAgentId
// ("follow the default") stays empty. The intent agent (AC-R23), spec agent
// (AC-R24) and automation agent (AC-R25) follow the same rule as the tool agent.
function onToggleEnabled(a: AgentConfig, checked: boolean): void {
  a.enabled = checked
  const order = flatAgents.value
  draft.value.defaultAgentId = resolveDefaultAgentId(order, draft.value.defaultAgentId)
  if (draft.value.toolAgentId) {
    draft.value.toolAgentId = resolveDefaultAgentId(order, draft.value.toolAgentId)
  }
  if (draft.value.intentAgentId) {
    draft.value.intentAgentId = resolveDefaultAgentId(order, draft.value.intentAgentId)
  }
  if (draft.value.specAgentId) {
    draft.value.specAgentId = resolveDefaultAgentId(order, draft.value.specAgentId)
  }
  if (draft.value.specReviewAgentId) {
    draft.value.specReviewAgentId = resolveDefaultAgentId(order, draft.value.specReviewAgentId)
  }
  if (draft.value.automationAgentId) {
    draft.value.automationAgentId = resolveDefaultAgentId(order, draft.value.automationAgentId)
  }
}

// 内联的 baseUrl/apiKey 只在「还没迁移」时出现,而且是只读的:它们是历史残留,改它们只会
// 让两套配置继续并存。要换上游就选 provider,要清掉残留就去 provider 页签的清理入口。
// `model` 不受此门控 —— 它在任何一态下都是独立的覆盖项。
function showBaseUrl(a: AgentConfig): boolean {
  return isLegacyInline(a)
}

// cursor 的 key 走自己的路:它的 CLI 认 key 或 `cursor-agent login` 任一种,所以这一栏
// 必须可达且可编辑(留空即用登录态)。其它 vendor 只在内联残留时只读地显示 key。
function showApiKey(a: AgentConfig): boolean {
  return a.vendor === 'cursor' || isLegacyInline(a)
}

// Cursor is the one vendor whose key is optional: left empty, the run uses the
// CLI's own login. Saying so in the field is what stops it reading as required.
function apiKeyPlaceholder(a: AgentConfig): string {
  return a.vendor === 'cursor'
    ? t('settings.agents.apiKey.placeholderOptional')
    : t('settings.agents.apiKey.placeholder')
}

// Narrow the union for template read/write — `baseUrl` lives only on the
// redirectable vendors' arms.
function baseUrlOf(a: AgentConfig): string {
  return hasProviderConfig(a) ? a.config.baseUrl : ''
}

// wireApi 只属于 codex,而且只在内联残留里还看得见:选了 provider 之后,协议是那条连接的
// 属性,在 provider 页签上编辑。
const WIRE_APIS = ['chat', 'responses'] as const
function showWireApi(a: AgentConfig): boolean {
  return a.vendor === 'codex' && isLegacyInline(a)
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
  draft.value.defaultAgentId = resolveDefaultAgentId(flatAgents.value, draft.value.defaultAgentId)
}

/** Deep-copy an agent, append "-copy" to its displayName, and insert the copy
 *  right after the original in the draft list so the two appear side by side. */
function copyAgent(a: AgentConfig) {
  const cloned = structuredClone(toRaw(a))
  const idx = draft.value.agents.indexOf(a)
  // Locally-unique id so the radio can target it before save; the server
  // keeps it as-is (only id-less agents get a freshly minted one on normalize).
  cloned.id = mintAgentId()
  cloned.displayName = a.displayName ? `${a.displayName}-copy` : ''
  // Insert the copy right after the original.
  draft.value.agents.splice(idx + 1, 0, cloned)
}

// ---- Agent groups as containers (ADR-0029) ---------------------------------
// The agent list renders as GROUP CONTAINERS instead of one flat list: an agent's
// `group` is edited by MOVING its row, never by typing a name into it. The
// `default` container holds every agent whose `group` is empty — those stay
// standalone agents, so `default` is NOT a failover pool and is never enumerated
// as a virtual group agent (`listGroupAgents` skips an empty group). Every other
// container is one real `(vendor, group)` pool whose members are tried top to
// bottom, so the visible order IS the failover order.
//
// Vendor sub-tabs (no "All") scope which containers/members are shown; the draft's
// flat `agents` array stays the single source of truth for Save/`order_seq`. A
// container is a view over it (members in array order, containers ordered by their
// first member's array index). Nothing is reordered on seed, so merely opening the
// panel on a server list whose groups are interleaved never looks like an unsaved
// edit — Save is what stamps the visual order into `order_seq`.
const DEFAULT_GROUP = ''

/** One rendered container: the default bucket, or one real failover group. */
interface AgentGroupView {
  /** Container identity — `(vendor, name)` for a real group, a fixed key for the
   *  default bucket. A bare name is NOT unique: two vendors may reuse one group
   *  name and each is its own pool. */
  key: string
  /** The persisted `group` value — `''` for the default bucket. */
  name: string
  /** The vendor the group is locked to — null only for the default bucket, which
   *  spans vendors (its members are filtered per sub-tab at render time). */
  vendor: VendorId | null
  members: AgentConfig[]
  isDefault: boolean
}

/** The default bucket's container key — no real group can collide with it, since a
 *  named group's key always carries a vendor. */
const DEFAULT_GROUP_KEY = '__default__'

/** The container key for a real `(vendor, group)` pool. `:` separates the two
 *  unambiguously: vendor ids are a closed set that never contains one, so no two
 *  distinct pairs can collapse onto the same key. */
function groupKey(vendor: VendorId, name: string): string {
  return `${vendor}:${name}`
}

/** The container an agent belongs to: the default bucket when ungrouped, else its
 *  own `(vendor, group)` — NOT every container sharing the group name. */
function containerKeyOf(a: AgentConfig): string {
  const name = groupOf(a)
  return name === DEFAULT_GROUP ? DEFAULT_GROUP_KEY : groupKey(a.vendor, name)
}

/** Whether `a` is a member of `group` — vendor-aware, so a same-named group under
 *  another vendor is a different container. */
function inGroup(a: AgentConfig, group: AgentGroupView): boolean {
  return containerKeyOf(a) === group.key
}

/** Empty named groups live only in the draft; each is bound to the vendor tab
 *  where it was created so it does not leak across sub-tabs. */
interface PendingGroup {
  name: string
  vendor: VendorId
}

// Groups created here that have no member yet. A group exists on the wire only
// through its members' `group` field, so an empty one lives in the draft alone and
// is dropped (with a notice) at Save.
const pendingGroups = ref<PendingGroup[]>([])

const agentVendorDirtyMap = computed(
  () => Object.fromEntries(VENDOR_ORDER.map((v) => [v, false])) as Record<VendorId, boolean>,
)
function agentVendorTabLabel(v: VendorId): string {
  return VENDOR_LABELS[v]
}
function selectAgentVendor(v: VendorId): void {
  activeAgentVendor.value = v
}

/** An agent's container name — a blank/absent `group` is the default bucket. */
function groupOf(a: AgentConfig): string {
  return a.group?.trim() ?? DEFAULT_GROUP
}

/**
 * The containers across every vendor, ordered by their first member's position in
 * the draft array — including `default`, which is NOT pinned first: the built-in
 * System agent may itself join a group, and the server pins that agent to
 * `order_seq` 0, so the container holding it must render first or the list would
 * jump on the next save. A memberless container (the default bucket when everything
 * is grouped, or a freshly created group) sorts to the tail.
 *
 * Display uses {@link vendorGroupsView}; this full view drives Save/`order_seq`.
 */
const groupsView = computed<AgentGroupView[]>(() => {
  // Keyed by `(vendor, group)`, never by the bare name: two vendors may reuse one
  // group name and each is its own failover pool, so merging them into a single
  // container would hide one vendor's members and let an edit rewrite the other side.
  const containers = new Map<string, AgentGroupView>([
    [
      DEFAULT_GROUP_KEY,
      { key: DEFAULT_GROUP_KEY, name: DEFAULT_GROUP, vendor: null, members: [], isDefault: true },
    ],
  ])
  for (const a of draft.value.agents) {
    const key = containerKeyOf(a)
    const box = containers.get(key)
    if (box) box.members.push(a)
    else
      containers.set(key, {
        key,
        name: groupOf(a),
        vendor: a.vendor,
        members: [a],
        isDefault: false,
      })
  }
  for (const p of pendingGroups.value) {
    const key = groupKey(p.vendor, p.name)
    if (!containers.has(key))
      containers.set(key, { key, name: p.name, vendor: p.vendor, members: [], isDefault: false })
  }
  const order = new Map([...containers.keys()].map((key, i) => [key, i]))
  return [...containers.values()].sort((a, b) => {
    const ia = a.members.length ? draft.value.agents.indexOf(a.members[0]) : Infinity
    const ib = b.members.length ? draft.value.agents.indexOf(b.members[0]) : Infinity
    if (ia !== ib) return ia - ib
    // Both memberless — keep them in creation order rather than swapping around.
    return (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0)
  })
})

/**
 * Containers/members for the active vendor sub-tab only: named groups locked to
 * that vendor (including empty pending ones), plus the default bucket filtered to
 * that vendor's ungrouped agents. Cross-vendor rows are not rendered here, so a
 * drag cannot park an agent under another vendor's tab.
 */
const vendorGroupsView = computed<AgentGroupView[]>(() => {
  const vendor = activeAgentVendor.value
  return groupsView.value
    .map((g) => (g.isDefault ? { ...g, members: g.members.filter((a) => a.vendor === vendor) } : g))
    .filter((g) => g.isDefault || g.vendor === vendor)
})

/**
 * The draft's agents in VISUAL (grouped) order across every vendor. Every
 * order-sensitive consumer reads this rather than `draft.agents`: the
 * default-agent fall-through rule and the `order_seq` stamped at Save must both
 * follow the full registry, not only the active sub-tab.
 */
const flatAgents = computed<AgentConfig[]>(() => groupsView.value.flatMap((g) => g.members))

// A transient, non-blocking reason why a group edit was refused (same role as
// `locateMissing`: it explains, it never blocks). Cleared on a timer.
const groupNotice = ref<string | null>(null)
let groupNoticeTimer: ReturnType<typeof setTimeout> | undefined
function notifyGroup(message: string): void {
  groupNotice.value = message
  clearTimeout(groupNoticeTimer)
  groupNoticeTimer = setTimeout(() => {
    groupNotice.value = null
  }, 5000)
}

/**
 * Whether `a` may join `group`, surfacing the reason when it may not. A group's
 * identity is `(vendor, group)`, so a group holds ONE vendor — mixing them would
 * silently mint two separate pools behind one visible container. Config mode is
 * NOT gated: a `system` member is a legitimate first hop (the vendor CLI's own
 * login), the server just launches that hop directly instead of through the relay.
 */
function canJoinGroup(a: AgentConfig, group: AgentGroupView): boolean {
  if (group.isDefault || inGroup(a, group)) return true
  // Named groups (including empty pending ones bound to a vendor tab) hold ONE
  // vendor — refuse a cross-vendor drop so a mid-drag tab switch cannot rewrite
  // group membership onto the wrong side. A same-named group under another vendor
  // is a DIFFERENT container, so matching the name alone would let it through.
  if (group.vendor && group.vendor !== a.vendor) {
    notifyGroup(
      t('settings.agents.group.notice.vendorMismatch', { vendor: VENDOR_LABELS[group.vendor] }),
    )
    return false
  }
  return true
}

/**
 * Move an agent into a container, landing before `beforeId` (else at the tail).
 * The built-in System agent is pinned to the very front by the server's normalize,
 * so nothing may be placed above it — a drop targeting it lands just after instead.
 */
function moveAgentToGroup(agentId: string, targetKey: string, beforeId: string | null): void {
  const agents = draft.value.agents
  const from = agents.findIndex((a) => a.id === agentId)
  // Resolve by container key, not name: a same-named group under another vendor is
  // a different container and must not be picked up as the drop target.
  const target = groupsView.value.find((g) => g.key === targetKey)
  if (from < 0 || !target || beforeId === agentId) return
  const agent = agents[from]
  if (!canJoinGroup(agent, target)) return
  const previousKey = containerKeyOf(agent)
  const previousGroup = groupOf(agent)
  const previousVendor = agent.vendor

  agents.splice(from, 1)
  agent.group = target.name
  const anchor = beforeId ? agents.findIndex((a) => a.id === beforeId) : -1
  if (anchor >= 0)
    agents.splice(agents[anchor].id === SYSTEM_AGENT_ID ? anchor + 1 : anchor, 0, agent)
  else {
    // Tail of the target container: right after its current last member. A
    // memberless container has no anchor — the array position is then irrelevant,
    // `groupsView` places the container by itself.
    let last = -1
    agents.forEach((a, i) => {
      if (inGroup(a, target)) last = i
    })
    agents.splice(last + 1, 0, agent)
  }

  // Keep an emptied group visible instead of letting the container vanish under
  // the cursor, and drop the target from the pending list now that it has a member.
  if (previousGroup !== DEFAULT_GROUP && !agents.some((a) => containerKeyOf(a) === previousKey)) {
    if (!pendingGroups.value.some((p) => p.name === previousGroup && p.vendor === previousVendor)) {
      pendingGroups.value.push({ name: previousGroup, vendor: previousVendor })
    }
  }
  pendingGroups.value = pendingGroups.value.filter((p) => groupKey(p.vendor, p.name) !== target.key)
}

// The System agent is pinned to `order_seq` 0 by the server, so it stays the very
// first row of the very first container: it never moves down, and no sibling above
// it moves up past it.
function canMoveUp(group: AgentGroupView, index: number): boolean {
  if (index === 0 || group.members[index].id === SYSTEM_AGENT_ID) return false
  return group.members[index - 1].id !== SYSTEM_AGENT_ID
}
function canMoveDown(group: AgentGroupView, index: number): boolean {
  if (index >= group.members.length - 1) return false
  return group.members[index].id !== SYSTEM_AGENT_ID
}

/** Swap an agent with its neighbour INSIDE its container — the group's failover
 *  priority is exactly this order. */
function moveWithinGroup(group: AgentGroupView, index: number, delta: -1 | 1): void {
  const agent = group.members[index]
  const neighbour = group.members[index + delta]
  if (!agent || !neighbour) return
  const agents = draft.value.agents
  const i = agents.indexOf(agent)
  const j = agents.indexOf(neighbour)
  if (i < 0 || j < 0) return
  agents[i] = neighbour
  agents[j] = agent
}

/** Create an empty container the user can drag agents into on the active vendor tab.
 *  The auto-name only has to be free on THIS vendor — another vendor's group of the
 *  same name is a separate pool. */
function addGroup(): void {
  const vendor = activeAgentVendor.value
  const taken = new Set(groupsView.value.filter((g) => g.vendor === vendor).map((g) => g.name))
  const base = t('settings.agents.group.new.name')
  let n = 1
  while (taken.has(`${base}-${n}`)) n++
  pendingGroups.value.push({ name: `${base}-${n}`, vendor })
}

/** Rename a container, rewriting its OWN members' `group` (same vendor only — a
 *  same-named group under another vendor is untouched). Refuses a blank, a name
 *  already taken on this vendor, or the reserved `_c3_` prefix. */
function renameGroup(group: AgentGroupView, raw: string): boolean {
  const name = raw.trim()
  if (name === group.name) return true
  if (!name) {
    notifyGroup(t('settings.agents.group.notice.emptyName'))
    return false
  }
  if (name.startsWith(GROUP_AGENT_PREFIX)) {
    notifyGroup(t('settings.agents.group.notice.reservedName', { prefix: GROUP_AGENT_PREFIX }))
    return false
  }
  if (groupsView.value.some((g) => g.vendor === group.vendor && g.name === name)) {
    notifyGroup(t('settings.agents.group.notice.duplicateName', { name }))
    return false
  }
  for (const a of draft.value.agents) if (inGroup(a, group)) a.group = name
  pendingGroups.value = pendingGroups.value.map((p) =>
    groupKey(p.vendor, p.name) === group.key ? { ...p, name } : p,
  )
  return true
}

// Renaming is committed on blur/Enter; a refused name is rolled back in the input
// so what is displayed always matches what is stored.
function onRenameGroup(group: AgentGroupView, e: Event): void {
  const el = e.target as HTMLInputElement
  if (!renameGroup(group, el.value)) el.value = group.name
}

/** Dissolve a container: every member falls back to `default` (nothing is deleted). */
function removeGroup(group: AgentGroupView): void {
  if (group.isDefault) return
  for (const a of draft.value.agents) if (inGroup(a, group)) a.group = DEFAULT_GROUP
  pendingGroups.value = pendingGroups.value.filter((p) => groupKey(p.vendor, p.name) !== group.key)
}

// ---- Drag between containers (native HTML5 DnD, no library) -----------------
// The grip handle is the draggable element (so the row's text inputs stay
// selectable as usual); rows and container bodies are the drop targets. `order_seq`
// is (re)stamped from the final visual order at Save time (see `buildTabPayload`),
// so a move survives the round trip to the server, which then regularizes it into
// a dense 0..n sequence.
const dragAgentId = ref<string | null>(null)
// The highlighted drop target: `agent:<id>` for a row, `group:<key>` for a body
// (the container key, so same-named groups on two vendors never light up together).
const dragOverKey = ref<string | null>(null)

function onAgentDragStart(agent: AgentConfig, e: DragEvent): void {
  dragAgentId.value = agent.id
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}
function onDragOverRow(agent: AgentConfig): void {
  dragOverKey.value = dragAgentId.value === null ? null : `agent:${agent.id}`
}
function onDragOverGroup(group: AgentGroupView): void {
  dragOverKey.value = dragAgentId.value === null ? null : `group:${group.key}`
}
function onDropOnRow(group: AgentGroupView, agent: AgentConfig): void {
  const dragged = dragAgentId.value
  onAgentDragEnd()
  if (dragged) moveAgentToGroup(dragged, group.key, agent.id)
}
function onDropOnGroup(group: AgentGroupView): void {
  const dragged = dragAgentId.value
  onAgentDragEnd()
  if (dragged) moveAgentToGroup(dragged, group.key, null)
}
function onAgentDragEnd(): void {
  dragAgentId.value = null
  dragOverKey.value = null
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
      // Stamp the user-controlled order from the VISUAL (grouped) order, so a
      // group's member order is exactly the order the relay fails over through and
      // the containers stay laid out as shown; the server regularizes it into a
      // dense 0..n sequence. `group` is written back trimmed — a container name is
      // matched by exact string on the server.
      const order = flatAgents.value
      const agents = order.map((a, i) => ({
        ...structuredClone(toRaw(a)),
        group: groupOf(a),
        order_seq: i,
      }))
      payload.agents = agents
      // A memberless container exists only in this draft — say so rather than let
      // it disappear silently on the round trip.
      const empty = pendingGroups.value.filter(
        (p) => !agents.some((a) => a.group === p.name && a.vendor === p.vendor),
      )
      if (empty.length > 0) {
        notifyGroup(
          t('settings.agents.group.notice.emptyDiscarded', {
            name: empty.map((p) => p.name).join(', '),
          }),
        )
      }
      payload.defaultAgentId = src.defaultAgentId
      payload.toolAgentId = src.toolAgentId
      payload.intentAgentId = src.intentAgentId
      payload.specAgentId = src.specAgentId
      payload.specReviewAgentId = src.specReviewAgentId
      payload.automationAgentId = src.automationAgentId
      break
    }
    case 'runtime': {
      payload.vendorCliVersions = { ...(src.vendorCliVersions ?? {}) }
      payload.proxy = { ...proxyCfg.value }
      // The server drops an off switch and a default window, so a untouched
      // section round-trips to "not configured" rather than persisting noise.
      payload.sessionCleanup = { ...cleanupCfg.value }
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
      :tabs="visibleTabs"
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
          <p
            v-if="locateMissing"
            class="agent-locate-missing"
            role="status"
            data-testid="agent-locate-missing"
          >
            {{ t('settings.agents.locateMissing') }}
          </p>
          <p
            v-if="groupNotice"
            class="agent-group-notice"
            role="status"
            data-testid="agent-group-notice"
          >
            {{ groupNotice }}
          </p>
          <!-- Cold-start CTA: shown only while the stored registry holds nothing the
               user configured. Persists immediately (no tab draft, no Save). -->
          <div v-if="agentsUnconfigured" class="agent-autoconfig" data-testid="agent-autoconfig">
            <p class="agent-autoconfig-hint">{{ t('settings.agents.autoConfigure.hint') }}</p>
            <button
              class="agent-autoconfig-btn"
              data-testid="settings-auto-configure-agents"
              :disabled="!isAdmin"
              @click="onAutoConfigureAgents"
            >
              {{ t('settings.agents.autoConfigure.label') }}
            </button>
          </div>
          <!-- Per-vendor sub-tabs: no "All" overview; list below shows only this vendor. -->
          <TabNav
            :tabs="VENDOR_ORDER"
            :active-tab="activeAgentVendor"
            :dirty-map="agentVendorDirtyMap"
            :tab-label="agentVendorTabLabel"
            prefix="agent-vendor"
            :dirty-title="''"
            @select="selectAgentVendor"
          />
          <div ref="agentListEl" class="agent-list" data-testid="agent-list">
            <section
              v-for="g in vendorGroupsView"
              :key="g.key"
              class="agent-group-box"
              :class="{ 'drag-over': dragOverKey === `group:${g.key}`, 'is-default': g.isDefault }"
              data-testid="agent-group-box"
              :data-group-name="g.name"
              :data-group-vendor="g.vendor ?? ''"
              @dragover.prevent="onDragOverGroup(g)"
              @drop.prevent="onDropOnGroup(g)"
            >
              <header class="agent-group-head">
                <span class="agent-group-icon" aria-hidden="true">{{
                  g.isDefault ? '▫' : '▤'
                }}</span>
                <span v-if="g.isDefault" class="agent-group-name is-fixed">{{
                  t('settings.agents.group.default.label')
                }}</span>
                <input
                  v-else
                  class="agent-field agent-group-name"
                  :value="g.name"
                  :title="t('settings.agents.group.rename.tooltip')"
                  :aria-label="t('settings.agents.group.rename.tooltip')"
                  data-testid="agent-group-name"
                  @change="onRenameGroup(g, $event)"
                  @keyup.enter="($event.target as HTMLInputElement).blur()"
                />
                <span v-if="g.vendor" class="agent-group-vendor">
                  <i
                    class="agent-group-vendor-dot"
                    :style="{ backgroundColor: vendorColor(g.vendor) }"
                  />{{ VENDOR_LABELS[g.vendor] }}
                </span>
                <span class="agent-group-meta">{{
                  g.isDefault
                    ? t('settings.agents.group.default.hint')
                    : t('settings.agents.group.failover.hint', { n: g.members.length })
                }}</span>
                <button
                  v-if="!g.isDefault"
                  class="icon-btn"
                  :title="t('settings.agents.group.remove.tooltip')"
                  data-testid="agent-group-remove"
                  @click="removeGroup(g)"
                >
                  🗑
                </button>
              </header>
              <p v-if="g.members.length === 0" class="agent-group-empty">
                {{ t('settings.agents.group.empty.hint') }}
              </p>
              <div
                v-for="(a, i) in g.members"
                :key="a.id"
                class="agent-row"
                :class="{
                  'drag-over': dragOverKey === `agent:${a.id}`,
                  located: locatedAgentId === a.id,
                }"
                :style="{
                  '--agent-vendor-tint': vendorRowTint(a.vendor),
                  backgroundColor: 'var(--agent-vendor-tint)',
                }"
                data-testid="agent-card"
                :data-agent-id="a.id"
                :data-agent-vendor="a.vendor"
                @dragover.prevent.stop="onDragOverRow(a)"
                @drop.prevent.stop="onDropOnRow(g, a)"
              >
                <span
                  class="col-drag"
                  draggable="true"
                  :title="t('settings.agents.group.move.tooltip')"
                  data-testid="agent-drag"
                  @dragstart="onAgentDragStart(a, $event)"
                  @dragend="onAgentDragEnd"
                  >⠿</span
                >
                <span class="col-rank">
                  <button
                    class="icon-btn rank-btn"
                    :disabled="!canMoveUp(g, i)"
                    :title="t('settings.agents.group.moveUp.tooltip')"
                    data-testid="agent-move-up"
                    @click="moveWithinGroup(g, i, -1)"
                  >
                    ▲
                  </button>
                  <button
                    class="icon-btn rank-btn"
                    :disabled="!canMoveDown(g, i)"
                    :title="t('settings.agents.group.moveDown.tooltip')"
                    data-testid="agent-move-down"
                    @click="moveWithinGroup(g, i, 1)"
                  >
                    ▼
                  </button>
                </span>
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
                  <option
                    v-for="v in VENDORS"
                    :key="v"
                    :value="v"
                    :disabled="!vendorAvailable(v) && a.vendor !== v"
                    :title="vendorUnavailableReason(v)"
                  >
                    {{ vendorOptionLabel(v) }}
                  </option>
                </select>
                <select
                  v-if="hasProviderConfig(a)"
                  class="agent-field agent-provider"
                  :value="providerSelectValue(a)"
                  :title="t('settings.agents.provider.tooltip')"
                  data-testid="agent-provider"
                  @change="setAgentProvider(a, ($event.target as HTMLSelectElement).value)"
                >
                  <option value="">{{ t('settings.agents.provider.systemLogin.label') }}</option>
                  <option v-for="p in providersFor(a.vendor)" :key="p.id" :value="p.id">
                    {{ p.displayName }}
                  </option>
                  <!-- 悬挂引用仍要显示出来,否则下拉会自己跳到别的值,把问题掩盖掉。 -->
                  <option v-if="isDanglingProvider(a)" :value="a.providerId">
                    {{ t('settings.agents.provider.missing.label', { id: a.providerId ?? '' }) }}
                  </option>
                  <!-- 引用了存在、但没有这条 vendor 连接的 provider:可选,运行时会降级。 -->
                  <option
                    v-else-if="
                      a.providerId && !providersFor(a.vendor).some((p) => p.id === a.providerId)
                    "
                    :value="a.providerId"
                  >
                    {{
                      t('settings.agents.provider.noConnection.label', {
                        name: providers.find((p) => p.id === a.providerId)?.displayName ?? '',
                        vendor: a.vendor,
                      })
                    }}
                  </option>
                  <option v-if="isLegacyInline(a)" :value="INLINE_OPTION" disabled>
                    {{ t('settings.agents.provider.legacy.label') }}
                  </option>
                  <option :value="NEW_PROVIDER_OPTION">
                    {{ t('settings.agents.provider.create.label') }}
                  </option>
                </select>
                <span
                  class="agent-configmode-derived"
                  :title="t('settings.agents.configMode.derived.tooltip')"
                  data-testid="agent-configmode"
                  >{{ derivedModeLabel(a) }}</span
                >
                <input
                  v-if="showBaseUrl(a)"
                  :value="baseUrlOf(a)"
                  class="agent-field agent-url"
                  readonly
                  :title="t('settings.agents.provider.legacy.notice')"
                  :placeholder="t('settings.agents.baseUrl.placeholder')"
                />
                <input
                  v-if="showApiKey(a)"
                  v-model="a.config.apiKey"
                  class="agent-field agent-key"
                  type="password"
                  autocomplete="off"
                  :readonly="a.vendor !== 'cursor'"
                  :title="t('settings.agents.col.apiKey.label')"
                  :placeholder="apiKeyPlaceholder(a)"
                />
                <input
                  v-model="a.config.model"
                  class="agent-field agent-model"
                  :list="`agent-models-${a.id}`"
                  :title="t('settings.agents.col.model.label')"
                  :placeholder="t('settings.agents.model.placeholder')"
                  @change="onModelPicked(a)"
                />
                <datalist :id="`agent-models-${a.id}`">
                  <option v-for="m in modelSuggestions(a)" :key="m.value" :value="m.value">
                    {{ m.label }}
                  </option>
                </datalist>
                <select
                  v-if="showWireApi(a)"
                  class="agent-field agent-wireapi"
                  :value="wireApiOf(a)"
                  disabled
                  :title="t('settings.agents.provider.legacy.notice')"
                  data-testid="agent-wireapi"
                >
                  <option v-for="w in WIRE_APIS" :key="w" :value="w">{{ wireApiLabel(w) }}</option>
                </select>
                <span class="col-actions">
                  <button
                    class="icon-btn"
                    data-testid="agent-copy"
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
            </section>
          </div>
          <div class="agent-list-actions">
            <button class="agent-add" data-testid="settings-add-agent" @click="addAgent">
              {{ t('settings.agents.add.label') }}
            </button>
            <button class="agent-add" data-testid="settings-add-group" @click="addGroup">
              {{ t('settings.agents.group.add.label') }}
            </button>
          </div>
          <ul
            v-if="unavailableVendorNotes.length > 0"
            class="agent-vendor-notes"
            data-testid="agent-vendor-notes"
          >
            <li v-for="n in unavailableVendorNotes" :key="n.vendor">
              {{ n.label }} — {{ n.reason }}
            </li>
          </ul>
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
            <label class="agent-default-label" for="spec-review-agent-select">
              {{ t('settings.agents.specReviewPicker.label') }}
            </label>
            <select
              id="spec-review-agent-select"
              v-model="draft.specReviewAgentId"
              class="agent-field"
              data-testid="spec-review-agent-select"
              :title="t('settings.agents.specReview.tooltip')"
            >
              <option value="">{{ t('settings.agents.specReviewPicker.followDefault') }}</option>
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
            <li
              v-for="row in diagnostics"
              :key="row.vendor"
              class="diagnostics-row"
              data-testid="diagnostics-row"
              :data-vendor="row.vendor"
            >
              <span
                class="vendor-dot"
                :style="{ backgroundColor: vendorColor(row.vendor) }"
                :title="vendorLabel(row.vendor)"
              ></span>
              <span class="diagnostics-vendor">{{ vendorLabel(row.vendor) }}</span>
              <code class="diagnostics-binary">{{ row.status.runtimeId ?? '—' }}</code>
              <span
                class="diagnostics-status"
                :class="row.status.available ? 'present' : 'missing'"
                :title="row.status.available ? '' : (row.host?.installHint ?? '')"
              >
                {{
                  row.status.available
                    ? t('settings.diagnostics.present')
                    : t('settings.diagnostics.missing')
                }}
              </span>
              <!-- Where the runtime came from: the resolved binary path, or
                   failing that the origin plus location the runtime signal
                   reports. Same column, same question — "which one is this". -->
              <code
                v-if="row.status.available && row.host?.path"
                class="diagnostics-path"
                :title="row.host.path"
                >{{ row.host.path }}</code
              >
              <code
                v-else-if="row.status.available && row.status.location"
                class="diagnostics-path"
                data-testid="diagnostics-origin"
                :title="row.status.location"
                >{{ diagnosticsOrigin(row) }} · {{ row.status.location }}</code
              >
              <span v-else-if="!row.status.available" class="diagnostics-reason">{{
                diagnosticsReason(row)
              }}</span>
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
              v-if="h.degradation"
              class="settings-hint vendor-cli-error"
              :data-testid="`vendor-cli-degraded-${h.vendor}`"
            >
              {{ vendorCliDegradationNotice(h) }}
            </p>
            <!-- 降级诊断与 lastError 是两件互不排斥的事(例如固定版本回退成功、随后同步/
                 安装又失败),同时成立时两条都要显示,否则后发生的失败会被先记录的降级永久盖住。 -->
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

        <!-- Session-store cleanup: system-wide, vendor-neutral, opt-in. -->
        <section class="settings-section" data-testid="settings-session-cleanup">
          <p class="settings-section-title">{{ t('settings.sessionCleanup.title.label') }}</p>
          <label class="consensus-toggle">
            <input
              v-model="cleanupCfg.enabled"
              type="checkbox"
              role="switch"
              data-testid="settings-session-cleanup-enabled"
            />
            {{ t('settings.sessionCleanup.toggle.label') }}
          </label>
          <p class="settings-hint">{{ t('settings.sessionCleanup.hint') }}</p>
          <label class="auth-field">
            <span class="auth-label">{{ t('settings.sessionCleanup.retentionDays.label') }}</span>
            <input
              v-model.number="retentionDays"
              class="agent-field"
              type="number"
              min="1"
              step="1"
              :disabled="!cleanupCfg.enabled"
              data-testid="settings-session-cleanup-retention"
            />
          </label>
          <p class="settings-hint">{{ t('settings.sessionCleanup.retentionDays.hint') }}</p>
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
          <p class="settings-section-title">{{ t('settings.voiceLang.title.label') }}</p>
          <p class="settings-hint">{{ t('settings.voiceLang.hint') }}</p>
          <select v-model="draft.voiceLang" class="mode-select" data-testid="settings-voice-lang">
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

      <!-- ============ Users and access tab ============
           Field-less: it edits authorization state, saved per account by its own
           message, so there is no draft here and no Save button in the footer. -->
      <div
        v-show="activeTab === 'provider'"
        class="settings-tab-panel"
        role="tabpanel"
        data-testid="settings-tab-provider"
      >
        <ModelProviders
          :providers="draft.modelProviders ?? []"
          :agents="draft.agents"
          :plan="providerMigrationPlan"
          :probes="providerProbes"
          :is-admin="isAdmin"
          @change="(list) => (draft.modelProviders = list)"
          @probe="(p) => emit('provider-probe', p)"
          @migrate="(p) => emit('provider-migrate', p)"
        />
      </div>

      <div
        v-show="activeTab === 'access'"
        class="settings-tab-panel"
        role="tabpanel"
        data-testid="settings-tab-access"
      >
        <UserAccess
          :workspaces="userAccessWorkspaces"
          :accounts="userAccessAccounts"
          @reload="emit('reload-user-access')"
          @save="(p) => emit('save-user-access', p)"
        />
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
      <div v-show="activeTab === 'provider'" class="settings-tab-actions">
        <span
          v-if="tabDirtyMap.provider"
          class="settings-unsaved"
          data-testid="settings-unsaved-provider"
          >{{ t('settings.tabs.unsaved.label') }}</span
        >
        <button
          data-testid="settings-save-provider"
          :disabled="!isAdmin"
          @click="saveTab('provider')"
        >
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
      @cancel="onCancelTabSwitch"
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
