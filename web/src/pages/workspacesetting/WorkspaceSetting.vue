<script setup lang="ts">
/*
 * WorkspaceSetting.vue — 工作区配置页:配置按 默认模式 / Git 与沙箱 / 协作 / 技能仓库 四个 Tab 分组。
 *
 * 每个 Tab 维护独立草稿脏状态并提供独立保存按钮:保存时只用当前 Tab 白名单字段(经其转换)
 * 覆盖「最新已提交快照」构造完整 WorkspaceSetting 上抛,不携带其它 Tab 草稿(见 TAB_FIELDS)。
 * forge 等当前页面未提供控件的透传字段随快照原样保留。面板打开期间的 workspace_setting 回推
 * 按字段归属合并:首次打开整体播种,之后仅刚保存的 Tab 与干净 Tab 重播种,脏 Tab 保留用户草稿。
 * 保存后面板保持打开以接收回包并清理刚保存 Tab 的脏状态。切换存在未保存修改的 Tab 时二次确认,
 * 确认后仅切换、不保存也不丢弃草稿。技能安装/链接状态走独立事件,不重播种任何 Tab 草稿。
 */
import { computed, watch } from 'vue'
import type {
  CodexPolicy,
  WorkspaceSetting,
  WorkspaceSandboxConfig,
  SandboxExtraMount,
  SysExtraMount,
  AgentConfig,
  SkillRepoConfig,
  SkillLinkStatus,
  SessionKind,
  VendorId,
  VendorModeCatalog,
  ModeToken,
} from '@ccc/shared/protocol'
import { GIT_BRANCH_MODES, SESSION_KINDS } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'
import { useModeLabel } from '@/composables/useModeLabel'
import { applyTabFields, deepCopy, useTabbedDraftSave } from '@/composables/useTabbedDraftSave'
import ConfirmDialog from '@/components/ConfirmDialog/ConfirmDialog.vue'
import TabNav from '@/components/TabNav/TabNav.vue'

const { t } = useTypedI18n()
const modeLabel = useModeLabel()

// Render order for per-vendor sections in the form.
const VENDOR_ORDER: VendorId[] = ['claude', 'codex']

// Per-stage discussion round cap: floor enforced both here and server-side.
const MIN_ROUNDS_PER_STAGE = 8
const DEFAULT_ROUNDS_PER_STAGE = 12

// Discussion speech character limit: minimum enforced both here and server-side.
const MIN_SPEECH_CHARS = 300
const DEFAULT_SPEECH_CHARS = 300

const props = defineProps<{
  open: boolean
  workspaceSetting: WorkspaceSetting | null
  /** Server-probed default branch, used to pre-fill `defaultMainBranch`. */
  detectedMainBranch: string | null
  /**
   * The FIXED, centralized SDD spec root resolved server-side
   * (`~/.c3/specs/<project-path-segment>`). Read-only display — never editable.
   * Optional: absent until the `workspace_setting` reply lands.
   */
  resolvedSpecRoot?: string | null
  /**
   * The workspace-scoped built-in sandbox allow set (project directory ro, specs
   * root rw) from the server's `sysExtraMounts(workspace)`. Read-only display —
   * users cannot edit or remove these. Absent until the reply lands.
   */
  sysExtraMounts?: SysExtraMount[]
  currentWorkspace: string | null
  vendorModes: Record<VendorId, VendorModeCatalog> | null
  /** All configured agents — the consensus voter picker shows enabled ones. */
  agents?: AgentConfig[]
  /** Per-skill link status for the current workspace (reply to get_skill_link_status). */
  linkStatuses?: SkillLinkStatus[]
  /** Skill ids whose install is in flight — drives per-row busy/disabled state. */
  installingSkillIds?: string[]
}>()

const emit = defineEmits<{
  close: []
  save: [config: WorkspaceSetting]
  /** Ask the parent to (re)fetch link status for the current workspace. */
  queryLinkStatus: []
  /** Ask the parent to install/update the configured skill repo with this id. */
  installSkill: [skillId: string]
}>()

// ---- Tab grouping ----------------------------------------------------------
// The four workspace-setting tabs and, per tab, the exact WorkspaceSetting fields
// it owns. This map is the single save whitelist: saving a tab overlays ONLY these
// fields (transformed) onto the latest committed snapshot, so a tab's Save never
// carries another tab's unsaved draft. The `gitSandbox` tab's `sandbox` field is
// compared/saved by its enabled state alone, independent of the git branch mode
// (see gitSandboxCmp / saveTab).
type WsTab = 'defaultMode' | 'gitSandbox' | 'collab' | 'skillRepos'
const TABS: WsTab[] = ['defaultMode', 'gitSandbox', 'collab', 'skillRepos']
const TAB_FIELDS: Record<WsTab, (keyof WorkspaceSetting)[]> = {
  defaultMode: ['defaultMode', 'devSkill'],
  gitSandbox: ['gitBranchMode', 'defaultMainBranch', 'sandbox'],
  collab: ['maxRoundsPerStage', 'maxSpeechChars', 'consensus', 'sddEnabled'],
  skillRepos: ['skillRepos'],
}
function tabLabel(tab: WsTab): string {
  return t(`workspaceSetting.tabs.${tab}.label` as 'workspaceSetting.tabs.defaultMode.label')
}

/**
 * Build a fresh per-vendor default-mode map the form can edit.
 * Uses the server's catalog `defaultToken` per vendor, falling back to
 * hardcoded defaults when `vendorModes` is unavailable.
 */
function freshDefaultMode(
  vendorModes: Record<VendorId, VendorModeCatalog> | null,
): Record<VendorId, ModeToken | CodexPolicy> {
  const out: Partial<Record<VendorId, ModeToken>> = {}
  for (const v of VENDOR_ORDER) {
    out[v] = (vendorModes?.[v]?.defaultToken ??
      { claude: 'default', codex: 'auto' }[v]) as ModeToken
  }
  return out as Record<VendorId, ModeToken>
}

/** Section heading for a vendor using the configured i18n label. */
function vendorSectionLabel(v: VendorId): string {
  return t(`workspaceSetting.defaultMode.section.${v}.label` as const)
}

/**
 * Normalize the codex default-mode value to the dual-policy {@link CodexPolicy}
 * object form. Translates the legacy single-token strings and fills the default
 * when absent/unknown — mirrors the server's `gateToCodexPolicy` migration so
 * seed and save always carry the canonical object.
 */
function normalizeCodex(v: unknown): CodexPolicy {
  if (v && typeof v === 'object' && 'sandboxMode' in v) {
    const c = v as CodexPolicy
    return { sandboxMode: c.sandboxMode, approvalPolicy: c.approvalPolicy }
  }
  if (v === 'read-only') return { sandboxMode: 'read-only', approvalPolicy: 'on-request' }
  if (v === 'full-access') return { sandboxMode: 'workspace-write', approvalPolicy: 'never' }
  // auto or fallback
  return { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' }
}

/**
 * Read the per-vendor default-mode map from server config, embedding the codex
 * dual-policy as a {@link CodexPolicy} object so the draft slice compares/saves as
 * one field (no separate codex draft ref).
 */
function seedDefaultMode(
  src: Record<VendorId, ModeToken | CodexPolicy> | undefined,
  vendorModes: Record<VendorId, VendorModeCatalog> | null,
): Record<VendorId, ModeToken | CodexPolicy> {
  const base =
    src && typeof src === 'object'
      ? ({ ...freshDefaultMode(vendorModes), ...src } as Record<VendorId, ModeToken | CodexPolicy>)
      : freshDefaultMode(vendorModes)
  base.codex = normalizeCodex(src?.codex)
  return base
}

/** Default retention window (days) for persistent sandbox CODEX_HOME rollouts —
 * kept in sync with the server's DEFAULT_SANDBOX_RETENTION_DAYS. */
const DEFAULT_SANDBOX_RETENTION_DAYS = 30

/**
 * Build an editable sandbox draft from a raw sandbox value (arapuca). Always
 * returns a reactive object with an extraMounts array and a sessionKinds list so
 * the `sandboxDraft` v-model bindings propagate; absent fields fall back to the
 * defaults (disabled, no extra mounts, `['work']`).
 */
function seedSandbox(raw: WorkspaceSandboxConfig | undefined): WorkspaceSandboxConfig {
  return {
    enabled: raw?.enabled ?? false,
    extraMounts: raw?.extraMounts ? raw.extraMounts.map((m) => ({ ...m })) : [],
    sandboxSessionKinds: raw?.sandboxSessionKinds ? [...raw.sandboxSessionKinds] : ['work'],
    sessionRetentionDays: raw?.sessionRetentionDays ?? DEFAULT_SANDBOX_RETENTION_DAYS,
  }
}

/**
 * Build the committed baseline from a raw server config. Starts from a deep copy
 * of EVERY server field so pass-through fields this page has no control for (e.g.
 * `forge`) survive a per-tab Save, then fills defaults for the editable fields so
 * `draft` and `committed` share one canonical shape (keeps dirty comparison free
 * of spurious missing-key diffs). `sandbox` is kept RAW here (not synthesized) so
 * a non-gitSandbox Save passes the server's actual sandbox state through faithfully;
 * the editable synthesis happens when seeding the draft (see reseedTab / open seed).
 */
function buildSeed(
  config: WorkspaceSetting | null,
  detected: string | null,
  vm: Record<VendorId, VendorModeCatalog> | null,
): WorkspaceSetting {
  const full = deepCopy(config ?? {}) as WorkspaceSetting
  return {
    ...full,
    defaultMode: seedDefaultMode(config?.defaultMode, vm),
    devSkill: config?.devSkill ?? '',
    maxRoundsPerStage: config?.maxRoundsPerStage ?? DEFAULT_ROUNDS_PER_STAGE,
    maxSpeechChars: config?.maxSpeechChars ?? DEFAULT_SPEECH_CHARS,
    consensus: {
      enabled: config?.consensus?.enabled ?? false,
      majority: config?.consensus?.majority ?? false,
      mode: config?.consensus?.mode ?? 'all',
      agentIds: config?.consensus?.agentIds ? [...config.consensus.agentIds] : [],
    },
    skillRepos: config?.skillRepos ? config.skillRepos.map((r) => ({ ...r })) : [],
    gitBranchMode: config?.gitBranchMode ?? 'current-branch',
    // Pre-fill from the saved value, else the server-probed default branch.
    defaultMainBranch: config?.defaultMainBranch ?? detected ?? '',
    sddEnabled: config?.sddEnabled ?? false,
    // sandbox left RAW from `full` (may be undefined) — synthesized into the draft.
  }
}

// The shared Tab-grouped draft/save state machine: `draft` is the editable copy the
// tab controls bind to, `committed` the authoritative last-committed server snapshot
// that save payloads are built from (so pass-through fields like `forge` survive)
// and dirty is measured against. Only the workspace specifics enter here as options
// — the per-tab payload transforms, and gitSandbox's synthesized draft / effective
// comparison slice.
const {
  draft,
  activeTab,
  pendingTabSwitch,
  tabDirtyMap,
  seedAll,
  reconcile,
  requestTab,
  confirmTabSwitch,
  cancelTabSwitch,
  saveTab,
} = useTabbedDraftSave<WsTab, WorkspaceSetting>({
  tabs: TABS,
  tabFields: TAB_FIELDS,
  initialTab: 'defaultMode',
  initial: () => buildSeed(null, null, null),
  buildPayload: buildTabPayload,
  reseedTab: reseedTab,
  dirtySlice: (tab, v) =>
    tab === 'gitSandbox'
      ? gitSandboxCmp(v.gitBranchMode, v.defaultMainBranch, v.sandbox)
      : undefined,
  onSave: (payload) =>
    // No spec path: the SDD spec root is FIXED/centralized and never editable, so
    // the save payload carries no spec directory value (the server ignores any).
    emit('save', payload),
})

// (Re)seed a single tab's draft from the committed seed. gitSandbox is special:
// its `sandbox` draft is synthesized (deny-by-default policies + stale-name drop)
// rather than a raw deep copy, so the form checkboxes have reactive backing.
function reseedTab(tab: WsTab, target: WorkspaceSetting, seed: WorkspaceSetting): void {
  if (tab === 'gitSandbox') {
    target.gitBranchMode = seed.gitBranchMode
    target.defaultMainBranch = seed.defaultMainBranch
    target.sandbox = seedSandbox(seed.sandbox)
  } else {
    applyTabFields(target, seed, TAB_FIELDS[tab])
  }
}

// Re-seed on open, then reconcile field-by-field on every later server pushback
// (or when vendorModes / detected branch arrive async). The shared layer owns the
// merge rules; this page only supplies the canonical seed and its open-time effects.
watch(
  () => [props.open, props.workspaceSetting, props.detectedMainBranch, props.vendorModes] as const,
  (curr, prev) => {
    const open = curr[0]
    if (!open) return
    const seed = buildSeed(props.workspaceSetting, props.detectedMainBranch, props.vendorModes)
    const prevOpen = prev?.[0] ?? false
    if (!prevOpen) {
      // First open (or reopen): whole-draft seed from the server snapshot, with the
      // gitSandbox draft synthesized into its editable form.
      seedAll(seed)
      draft.value.sandbox = seedSandbox(seed.sandbox)
      // Ask the parent to (re)fetch each skill repo's link status for this workspace.
      // No auto-polling — only on open (and after an install completes, via the parent).
      emit('queryLinkStatus')
      return
    }
    // Pushback while open: merge by field ownership to protect unsaved drafts.
    reconcile(seed)
  },
  { immediate: true },
)

// The effective sandbox a Save would persist, used for BOTH dirty comparison and
// as the canonical form the draft and the raw committed value normalize to.
// Mirrors the save gate: `enabled` only (independent of git branch mode). Drops
// empty extraMounts and a trivial `['work']` sessionKinds so a synthesized draft
// equals a raw server value.
function effectiveSandbox(
  raw: WorkspaceSandboxConfig | undefined,
): WorkspaceSandboxConfig | undefined {
  if (!raw || !raw.enabled) return undefined
  const extraMounts = (raw.extraMounts ?? [])
    .map((m) => ({ path: (m.path ?? '').trim(), readonly: m.readonly !== false }))
    .filter((m) => m.path.length > 0)
  const kinds = raw.sandboxSessionKinds ?? ['work']
  const out: WorkspaceSandboxConfig = { enabled: true }
  if (extraMounts.length > 0) {
    out.extraMounts = extraMounts.map((m) => (m.readonly ? { path: m.path } : { ...m }))
  }
  const isDefaultKinds = kinds.length === 1 && kinds[0] === 'work'
  if (!isDefaultKinds && kinds.length > 0) out.sandboxSessionKinds = [...kinds]
  // Retention window: mirror the server normalize — floor + clamp up to 1, and
  // omit when it equals the default so a synthesized draft equals a raw value.
  const rawDays = raw.sessionRetentionDays
  if (typeof rawDays === 'number' && Number.isFinite(rawDays) && rawDays > 0) {
    const days = Math.max(1, Math.floor(rawDays))
    if (days !== DEFAULT_SANDBOX_RETENTION_DAYS) out.sessionRetentionDays = days
  }
  return out
}

// The gitSandbox tab's dirty comparison slice — the fields (transformed) a Save
// would carry, so dirty == "saving this tab would change the committed state".
function gitSandboxCmp(
  gitBranchMode: WorkspaceSetting['gitBranchMode'],
  defaultMainBranch: string | undefined,
  rawSandbox: WorkspaceSandboxConfig | undefined,
): unknown {
  return {
    gitBranchMode: gitBranchMode ?? 'current-branch',
    defaultMainBranch: (defaultMainBranch ?? '').trim(),
    sandbox: effectiveSandbox(rawSandbox),
  }
}

// Always-non-null defaultMode ref for the template (WorkspaceSetting.defaultMode is optional).
const draftDefaultMode = computed(
  () => draft.value.defaultMode ?? { claude: 'default', codex: 'auto' },
)

// Codex dual-policy — the live object embedded in draft.defaultMode.codex (seeded
// as a CodexPolicy object). v-model writes to its properties are reactive because
// the returned object IS the nested reactive draft value.
const draftCodexPolicy = computed<CodexPolicy>(() => {
  const c = (draft.value.defaultMode as Record<string, unknown> | undefined)?.codex
  return c && typeof c === 'object'
    ? (c as CodexPolicy)
    : { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' }
})

/**
 * Always-non-null sandbox ref for the template (WorkspaceSetting.sandbox is optional).
 * Exported as `sandboxDraft` so v-model bindings don't trigger "possibly undefined"
 * even when sandbox hasn't been explicitly set.
 */
const sandboxDraft = computed<WorkspaceSandboxConfig>({
  get: () => draft.value.sandbox ?? {},
  set: (val) => {
    draft.value.sandbox = val
  },
})

/** The sandbox draft's supplementary allowed dirs (never null for the template). */
const extraMounts = computed<SandboxExtraMount[]>(() => sandboxDraft.value.extraMounts ?? [])

/** A read-only built-in allowed-dir row for display (path null ⇒ per-run, shown by desc). */
interface EmbeddedRow {
  key: string
  name: string
  desc: string
  path: string | null
  readonly: boolean
}

/** Localized display name for a built-in mount key (literal keys keep `t` typed). */
function embeddedName(key: string): string {
  if (key === 'workspaceRoot') return t('workspaceSetting.sandbox.embedded.workspaceRoot.name')
  if (key === 'specs') return t('workspaceSetting.sandbox.embedded.specs.name')
  if (key === 'executionRoot') return t('workspaceSetting.sandbox.embedded.executionRoot.name')
  return t('workspaceSetting.sandbox.embedded.worktree.name')
}
/** Localized description for a built-in mount key. */
function embeddedDesc(key: string): string {
  if (key === 'workspaceRoot') return t('workspaceSetting.sandbox.embedded.workspaceRoot.desc')
  if (key === 'specs') return t('workspaceSetting.sandbox.embedded.specs.desc')
  if (key === 'executionRoot') return t('workspaceSetting.sandbox.embedded.executionRoot.desc')
  return t('workspaceSetting.sandbox.embedded.worktree.desc')
}

/**
 * Built-in (embedded) allowed dirs that are ALWAYS in the allow set. Listed
 * read-only so users understand the always-on allow set; they cannot be edited
 * or removed here.
 *
 * The per-run execution root reflects the git branch mode (never asserting the
 * source workspace is read-only in a mode where it is not):
 * - worktree: the source project directory (ro) plus the run's isolated worktree
 *   (rw, per-run — shown descriptively with no fixed path).
 * - current-branch: the source workspace IS the execution root (rw); the ro
 *   project-directory row is replaced by this single rw row.
 * The specs root (rw) comes from the server's single source `sysExtraMounts`.
 */
const embeddedMounts = computed<EmbeddedRow[]>(() => {
  const sys = props.sysExtraMounts ?? []
  const wsRoot = sys.find((m) => m.key === 'workspaceRoot')
  const specs = sys.find((m) => m.key === 'specs')
  const rows: EmbeddedRow[] = []
  if (draft.value.gitBranchMode === 'worktree') {
    // Source project directory (ro) + per-run isolated worktree (rw).
    if (wsRoot) {
      rows.push({
        key: 'workspaceRoot',
        name: embeddedName('workspaceRoot'),
        desc: embeddedDesc('workspaceRoot'),
        path: wsRoot.path,
        readonly: wsRoot.readonly,
      })
    }
    rows.push({
      key: 'worktree',
      name: embeddedName('worktree'),
      desc: embeddedDesc('worktree'),
      path: null,
      readonly: false,
    })
  } else {
    // Current-branch: the source workspace is the read-write execution root.
    rows.push({
      key: 'executionRoot',
      name: embeddedName('executionRoot'),
      desc: embeddedDesc('executionRoot'),
      path: wsRoot?.path ?? null,
      readonly: false,
    })
  }
  if (specs) {
    rows.push({
      key: 'specs',
      name: embeddedName('specs'),
      desc: embeddedDesc('specs'),
      path: specs.path,
      readonly: specs.readonly,
    })
  }
  return rows
})

/** Append a blank extra-mount row (host absolute path, read-only by default). */
function addExtraMount(): void {
  const next = [...extraMounts.value, { path: '', readonly: true }]
  sandboxDraft.value = { ...sandboxDraft.value, extraMounts: next }
}

/** Remove the extra-mount row at `idx`. */
function removeExtraMount(idx: number): void {
  const next = extraMounts.value.filter((_, i) => i !== idx)
  sandboxDraft.value = { ...sandboxDraft.value, extraMounts: next }
}

/** All session kinds, for the sandbox sessionKinds checkbox group. */
const sessionKindOptions = SESSION_KINDS

/** Whether `kind` is in the sandbox draft's sessionKinds set (default `['work']`). */
function isSessionKindSelected(kind: SessionKind): boolean {
  return (sandboxDraft.value.sandboxSessionKinds ?? ['work']).includes(kind)
}

/** Toggle a session kind in the sandbox draft's sessionKinds set. */
function toggleSessionKind(kind: SessionKind): void {
  const current = sandboxDraft.value.sandboxSessionKinds ?? ['work']
  const next = current.includes(kind) ? current.filter((k) => k !== kind) : [...current, kind]
  sandboxDraft.value = { ...sandboxDraft.value, sandboxSessionKinds: next }
}

/**
 * The persistent-CODEX_HOME rollout retention window (days). v-model for the
 * number input; defaults to the shared default and floors non-positive input up
 * to 1 so the field never persists a value the server would reject.
 */
const sandboxRetentionDays = computed<number>({
  get: () => sandboxDraft.value.sessionRetentionDays ?? DEFAULT_SANDBOX_RETENTION_DAYS,
  set: (val: number) => {
    const days = Number.isFinite(val) && val > 0 ? Math.max(1, Math.floor(val)) : 1
    sandboxDraft.value = { ...sandboxDraft.value, sessionRetentionDays: days }
  },
})

// ---- Consensus custom voter picker ----

/**
 * Agents selectable as custom consensus voters — every enabled agent. Consensus
 * voting is vendor-neutral (`selectConsensusVoters` intersects this allowlist with
 * the enabled non-self set, never by vendor), so a cross-vendor pick genuinely
 * participates: tool requests are made comparable by the server's risk normalizer.
 */
const consensusSelectableAgents = computed<AgentConfig[]>(() =>
  (props.agents ?? []).filter((a) => a.enabled !== false),
)

/** Whether the given agent id is in the consensus custom allowlist. */
function isConsensusAgentSelected(id: string): boolean {
  return (draft.value.consensus?.agentIds ?? []).includes(id)
}

/** Toggle an agent id in the consensus custom allowlist. */
function toggleConsensusAgent(id: string): void {
  if (!draft.value.consensus) return
  const current = draft.value.consensus.agentIds ?? []
  draft.value.consensus.agentIds = current.includes(id)
    ? current.filter((x) => x !== id)
    : [...current, id]
}

// ---- External skill repos (ADR-0016/0017) ----

/** GitHub: https://host/owner/repo[/tree/<ref>[/<subpath>]] */
const GITHUB_REPO_RE = /^(https?:\/\/[^/]+\/[^/]+\/[^/]+)(?:\/tree\/([^/]+)(?:\/(.+))?)?$/

/** Extract `{ ref?, subpath? }` from a GitHub URL pasted into the repo field. */
function parsePastedRepoUrl(url: string): { ref: string; subpath: string } {
  const m = GITHUB_REPO_RE.exec(url.trim())
  if (m && (m[2] || m[3])) {
    return {
      ref: m[2] ?? '',
      subpath: m[3] ?? '',
    }
  }
  return { ref: '', subpath: '' }
}

/** Whether a repo entry is missing a required `ref`. */
function missingRef(r: SkillRepoConfig): boolean {
  return !r.ref.trim()
}

/** Last non-empty path segment of a subpath (the skill's folder name). */
function folderName(subpath: string | undefined): string {
  return (subpath ?? '').split('/').filter(Boolean).pop() ?? ''
}

/** Default the skill name (`id`) to the subpath's folder name while it is still blank. */
function onSubpathInput(r: SkillRepoConfig): void {
  if (r.id.trim()) return
  const seg = folderName(r.subpath)
  if (seg) r.id = seg
}

let skillIdCounter = 0
function makeSkillId(): string {
  return `sr-${Date.now()}-${++skillIdCounter}`
}

function addSkillRepo() {
  draft.value.skillRepos = [
    ...(draft.value.skillRepos ?? []),
    {
      id: makeSkillId(),
      repo: '',
      ref: '',
      subpath: '',
    },
  ]
}

function removeSkillRepo(id: string) {
  draft.value.skillRepos = (draft.value.skillRepos ?? []).filter((r) => r.id !== id)
}

/** A row is "linked" only when both vendor skill dirs carry the `_c3_<id>` symlink. */
function rowLinked(r: SkillRepoConfig): boolean {
  const s = (props.linkStatuses ?? []).find((x) => x.id === r.id)
  return !!s && s.claudeSkills && s.agentsSkills
}

/** Whether this row's install round-trip is currently in flight. */
function rowInstalling(r: SkillRepoConfig): boolean {
  return (props.installingSkillIds ?? []).includes(r.id)
}

/** Install is allowed once repo + ref are filled and no install is already running. */
function canInstall(r: SkillRepoConfig): boolean {
  return !rowInstalling(r) && !missingRef(r) && !!r.repo.trim()
}

function onInstall(r: SkillRepoConfig): void {
  if (!canInstall(r)) return
  emit('installSkill', r.id)
}

// Build a full WorkspaceSetting for a single tab's Save: `payload` arrives as a deep
// copy of the latest committed snapshot (so pass-through fields like `forge` survive),
// and this overlays ONLY the current tab's whitelist fields from the draft, applying
// that tab's transforms to the payload copy alone (never writing back into the drafts).
// Emitting the full object keeps the `save_workspace_setting` protocol unchanged;
// the tab boundary is enforced purely by which fields we overlay.
function buildTabPayload(
  tab: WsTab,
  payload: WorkspaceSetting,
  src: WorkspaceSetting,
): WorkspaceSetting {
  switch (tab) {
    case 'defaultMode': {
      // The Codex dual-policy object is already embedded in the draft's defaultMode
      // (seeded via normalizeCodex), so a deep copy carries it as-is.
      payload.defaultMode = deepCopy(src.defaultMode)
      payload.devSkill = src.devSkill
      break
    }
    case 'gitSandbox': {
      payload.gitBranchMode = src.gitBranchMode
      // Trim the branch; empty ⇒ omit (server normalizes blank → undefined anyway).
      payload.defaultMainBranch = src.defaultMainBranch?.trim() || undefined
      // Sandbox is independent of the branch mode: emit the normalized effective
      // form when enabled, else drop the field (disabled). Switching branch modes
      // preserves the saved sandbox config.
      const eff = effectiveSandbox(sandboxDraft.value)
      if (eff) payload.sandbox = eff
      else delete payload.sandbox
      break
    }
    case 'collab': {
      payload.maxRoundsPerStage = src.maxRoundsPerStage
      payload.maxSpeechChars = src.maxSpeechChars
      payload.consensus = deepCopy(src.consensus)
      payload.sddEnabled = src.sddEnabled
      break
    }
    case 'skillRepos': {
      payload.skillRepos = deepCopy(src.skillRepos ?? [])
      break
    }
  }
  return payload
}

/** Paste handler: parse GitHub URL to auto-fill ref/subpath. */
function onRepoPaste(e: ClipboardEvent, id: string) {
  const pasted = e.clipboardData?.getData('text') ?? ''
  const parsed = parsePastedRepoUrl(pasted)
  if (!parsed.ref && !parsed.subpath) return
  e.preventDefault()
  const list = draft.value.skillRepos ?? []
  const idx = list.findIndex((r) => r.id === id)
  if (idx < 0) return
  const updated = { ...list[idx], repo: pasted }
  if (parsed.ref) updated.ref = parsed.ref
  if (parsed.subpath) {
    updated.subpath = parsed.subpath
    if (!updated.id.trim()) updated.id = folderName(parsed.subpath)
  }
  draft.value.skillRepos = [...list.slice(0, idx), updated, ...list.slice(idx + 1)]
}
</script>

<template>
  <div v-if="open" class="project-config-page">
    <div class="project-config-head">
      <h2>{{ t('workspaceSetting.title.label') }}</h2>
      <button class="icon-btn" :title="t('common.action.close.tooltip')" @click="emit('close')">
        ✕
      </button>
    </div>

    <!-- Tab navigation (shared with the system-settings page). Requesting a switch
         away from a dirty tab opens the confirm dialog (see requestTab). -->
    <TabNav
      :tabs="TABS"
      :active-tab="activeTab"
      :dirty-map="tabDirtyMap"
      :tab-label="tabLabel"
      prefix="project-config"
      :dirty-title="t('workspaceSetting.tabs.unsaved.label')"
      @select="requestTab"
    />

    <div class="project-config-body">
      <!-- ============ Default mode tab ============ -->
      <div
        v-show="activeTab === 'defaultMode'"
        class="project-config-tab-panel"
        role="tabpanel"
        data-testid="project-config-tab-defaultMode"
      >
        <section class="project-config-section">
          <p class="project-config-section-title">
            {{ t('workspaceSetting.defaultMode.title.label') }}
          </p>
          <p class="project-config-hint">{{ t('workspaceSetting.defaultMode.hint') }}</p>
          <div v-for="v in VENDOR_ORDER" :key="v" class="project-config-row">
            <span class="project-config-row-label">{{ vendorSectionLabel(v) }}</span>
            <template v-if="v === 'codex'">
              <label class="inline-field">
                <span class="inline-field-label">{{ t('codex.sandboxMode.label') }}</span>
                <select
                  v-model="draftCodexPolicy.sandboxMode"
                  class="mode-select"
                  data-testid="default-mode-codex-sandbox"
                >
                  <option value="workspace-write">
                    {{ t('codex.sandboxMode.workspaceWrite') }}
                  </option>
                  <option value="read-only">{{ t('codex.sandboxMode.readOnly') }}</option>
                </select>
              </label>
              <label class="inline-field">
                <span class="inline-field-label">{{ t('codex.approvalPolicy.label') }}</span>
                <select
                  v-model="draftCodexPolicy.approvalPolicy"
                  class="mode-select"
                  data-testid="default-mode-codex-approval"
                >
                  <option value="on-request">{{ t('codex.approvalPolicy.onRequest') }}</option>
                  <option value="on-failure">{{ t('codex.approvalPolicy.onFailure') }}</option>
                  <option value="never">{{ t('codex.approvalPolicy.never') }}</option>
                </select>
              </label>
            </template>
            <select
              v-else-if="props.vendorModes"
              v-model="draftDefaultMode[v]"
              class="mode-select"
              :data-testid="`default-mode-${v}`"
            >
              <option v-for="m in props.vendorModes[v].modes" :key="m.token" :value="m.token">
                {{ modeLabel(m.labelCode) }}
              </option>
            </select>
          </div>
        </section>

        <section class="project-config-section">
          <div class="project-config-row">
            <span class="project-config-row-label">{{
              t('workspaceSetting.devSkill.title.label')
            }}</span>
            <input
              v-model="draft.devSkill"
              class="project-config-field"
              :placeholder="t('workspaceSetting.devSkill.placeholder')"
            />
          </div>
          <p class="project-config-hint">{{ t('workspaceSetting.devSkill.hint') }}</p>
        </section>
      </div>

      <!-- ============ Git & Sandbox tab ============ -->
      <div
        v-show="activeTab === 'gitSandbox'"
        class="project-config-tab-panel"
        role="tabpanel"
        data-testid="project-config-tab-gitSandbox"
      >
        <section class="project-config-section">
          <p class="project-config-section-title">
            {{ t('workspaceSetting.gitBranchMode.title.label') }}
          </p>
          <p class="project-config-hint">{{ t('workspaceSetting.gitBranchMode.hint') }}</p>
          <div class="project-config-row">
            <span class="project-config-row-label">{{
              t('workspaceSetting.gitBranchMode.title.label')
            }}</span>
            <select v-model="draft.gitBranchMode" class="mode-select" data-testid="git-branch-mode">
              <option v-for="m in GIT_BRANCH_MODES" :key="m" :value="m">
                {{
                  m === 'worktree'
                    ? t('workspaceSetting.gitBranchMode.option.worktree.label')
                    : t('workspaceSetting.gitBranchMode.option.currentBranch.label')
                }}
              </option>
            </select>
          </div>
          <div class="project-config-row">
            <span class="project-config-row-label">{{
              t('workspaceSetting.defaultMainBranch.title.label')
            }}</span>
            <input
              v-model="draft.defaultMainBranch"
              class="project-config-field"
              :placeholder="t('workspaceSetting.defaultMainBranch.placeholder')"
              data-testid="default-main-branch"
            />
          </div>
          <p class="project-config-hint">{{ t('workspaceSetting.defaultMainBranch.hint') }}</p>
        </section>

        <!-- Sandbox section: available in both git branch modes. Which run enters
             the sandbox is decided by the `enabled` switch and the session-kind
             allowlist; the read-write execution root differs per mode (isolated
             worktree, or the source workspace under current-branch). -->
        <section class="project-config-section" data-testid="project-config-sandbox">
          <p class="project-config-section-title">
            {{ t('workspaceSetting.sandbox.title.label') }}
          </p>
          <p class="project-config-hint">{{ t('workspaceSetting.sandbox.hint') }}</p>

          <label class="project-config-toggle">
            <input
              v-model="sandboxDraft.enabled"
              type="checkbox"
              :true-value="true"
              :false-value="false"
              data-testid="project-config-sandbox-enabled"
            />
            {{ t('workspaceSetting.sandbox.enable.label') }}
          </label>

          <template v-if="sandboxDraft.enabled">
            <!-- Supplementary allowed directories (same-path, read-only by default). -->
            <div class="project-config-row project-config-sandbox-mounts">
              <span class="project-config-row-label">{{
                t('workspaceSetting.sandbox.extraMounts.label')
              }}</span>
              <div class="project-config-agent-list">
                <p class="project-config-hint">
                  {{ t('workspaceSetting.sandbox.extraMounts.hint') }}
                </p>
                <!-- Built-in (embedded) allowances: always in the allow set, shown
                     read-only so users see them; cannot be edited or removed here. -->
                <ul
                  class="project-config-embedded-mounts"
                  data-testid="project-config-sandbox-embedded"
                >
                  <li class="project-config-embedded-caption">
                    {{ t('workspaceSetting.sandbox.embedded.label') }}
                  </li>
                  <li
                    v-for="em in embeddedMounts"
                    :key="em.key"
                    class="project-config-embedded-row"
                    :data-testid="`project-config-sandbox-embedded-${em.key}`"
                  >
                    <span class="project-config-embedded-name">{{ em.name }}</span>
                    <code v-if="em.path" class="project-config-readonly">{{ em.path }}</code>
                    <span v-else class="project-config-embedded-desc">{{ em.desc }}</span>
                    <span class="project-config-embedded-badge">{{
                      em.readonly
                        ? t('workspaceSetting.sandbox.extraMounts.ro')
                        : t('workspaceSetting.sandbox.extraMounts.rw')
                    }}</span>
                    <span
                      class="project-config-embedded-lock"
                      :title="t('workspaceSetting.sandbox.embedded.lockedTitle')"
                      >🔒</span
                    >
                  </li>
                </ul>
                <div
                  v-for="(m, idx) in extraMounts"
                  :key="idx"
                  class="project-config-mount-row"
                  data-testid="project-config-sandbox-mount"
                >
                  <input
                    v-model="m.path"
                    class="project-config-field"
                    :placeholder="t('workspaceSetting.sandbox.extraMounts.pathPlaceholder')"
                    :data-testid="`project-config-sandbox-mount-path-${idx}`"
                  />
                  <select
                    v-model="m.readonly"
                    class="mode-select"
                    :data-testid="`project-config-sandbox-mount-mode-${idx}`"
                  >
                    <option :value="true">
                      {{ t('workspaceSetting.sandbox.extraMounts.ro') }}
                    </option>
                    <option :value="false">
                      {{ t('workspaceSetting.sandbox.extraMounts.rw') }}
                    </option>
                  </select>
                  <button
                    type="button"
                    class="icon-btn"
                    :title="t('workspaceSetting.sandbox.extraMounts.remove')"
                    :data-testid="`project-config-sandbox-mount-remove-${idx}`"
                    @click="removeExtraMount(idx)"
                  >
                    🗑
                  </button>
                </div>
                <button
                  type="button"
                  class="agent-add"
                  data-testid="project-config-sandbox-mount-add"
                  @click="addExtraMount"
                >
                  {{ t('workspaceSetting.sandbox.extraMounts.add') }}
                </button>
              </div>
            </div>

            <!-- Session kinds that enter the sandbox (default: work). -->
            <div class="project-config-row project-config-sandbox-kinds">
              <span class="project-config-row-label">{{
                t('workspaceSetting.sandbox.sessionKinds.label')
              }}</span>
              <div class="project-config-agent-list" data-testid="project-config-sandbox-kinds">
                <p class="project-config-hint">
                  {{ t('workspaceSetting.sandbox.sessionKinds.hint') }}
                </p>
                <label
                  v-for="kind in sessionKindOptions"
                  :key="kind"
                  class="project-config-agent-item"
                >
                  <input
                    type="checkbox"
                    :checked="isSessionKindSelected(kind)"
                    :data-testid="`project-config-sandbox-kind-${kind}`"
                    @change="toggleSessionKind(kind)"
                  />
                  {{ kind }}
                </label>
              </div>
            </div>

            <!-- Retention window (days) for the persistent codex CODEX_HOME rollouts. -->
            <div class="project-config-row">
              <span class="project-config-row-label">{{
                t('workspaceSetting.sandbox.retention.label')
              }}</span>
              <input
                v-model.number="sandboxRetentionDays"
                class="project-config-field project-config-number"
                type="number"
                min="1"
                step="1"
                data-testid="project-config-sandbox-retention"
              />
            </div>
            <p class="project-config-hint">
              {{ t('workspaceSetting.sandbox.retention.hint') }}
            </p>
          </template>
        </section>
      </div>

      <!-- ============ Collaboration tab ============ -->
      <div
        v-show="activeTab === 'collab'"
        class="project-config-tab-panel"
        role="tabpanel"
        data-testid="project-config-tab-collab"
      >
        <section class="project-config-section">
          <div class="project-config-row">
            <span class="project-config-row-label">{{
              t('workspaceSetting.rounds.title.label')
            }}</span>
            <input
              v-model.number="draft.maxRoundsPerStage"
              class="project-config-field project-config-number"
              type="number"
              :min="MIN_ROUNDS_PER_STAGE"
              step="1"
            />
          </div>
          <p class="project-config-hint">
            {{ t('workspaceSetting.rounds.hint', { min: MIN_ROUNDS_PER_STAGE }) }}
          </p>
        </section>

        <section class="project-config-section">
          <div class="project-config-row">
            <span class="project-config-row-label">{{
              t('workspaceSetting.speechChars.title.label')
            }}</span>
            <input
              v-model.number="draft.maxSpeechChars"
              class="project-config-field project-config-number"
              type="number"
              :min="MIN_SPEECH_CHARS"
              step="1"
            />
          </div>
          <p class="project-config-hint">
            {{ t('workspaceSetting.speechChars.hint', { min: MIN_SPEECH_CHARS }) }}
          </p>
        </section>

        <section class="project-config-section">
          <p class="project-config-section-title">
            {{ t('workspaceSetting.consensus.title.label') }}
          </p>
          <i18n-t
            keypath="workspaceSetting.consensus.hint1.text"
            tag="p"
            class="project-config-hint"
          >
            <template #other
              ><em>{{ t('workspaceSetting.consensus.hint1.other') }}</em></template
            >
          </i18n-t>
          <i18n-t
            keypath="workspaceSetting.consensus.hint2.text"
            tag="p"
            class="project-config-hint"
          >
            <template #ask
              ><strong>{{ t('workspaceSetting.consensus.hint2.ask') }}</strong></template
            >
            <template #you
              ><em>{{ t('workspaceSetting.consensus.hint2.you') }}</em></template
            >
            <template #on
              ><em>{{ t('workspaceSetting.consensus.hint2.on') }}</em></template
            >
          </i18n-t>
          <div v-if="draft.consensus" class="project-config-row">
            <label class="project-config-toggle">
              <input v-model="draft.consensus.enabled" type="checkbox" />
              {{ t('workspaceSetting.consensus.toggle.label') }}
            </label>
            <label class="project-config-toggle">
              <input
                v-model="draft.consensus.majority"
                type="checkbox"
                data-testid="project-config-consensus-majority"
              />
              {{ t('workspaceSetting.consensus.majority.label') }}
            </label>
          </div>
          <template v-if="draft.consensus">
            <p class="project-config-hint">{{ t('workspaceSetting.consensus.voters.hint') }}</p>
            <div class="project-config-row">
              <label class="project-config-toggle">
                <input
                  v-model="draft.consensus.mode"
                  type="radio"
                  value="all"
                  data-testid="project-config-consensus-mode-all"
                />
                {{ t('workspaceSetting.consensus.voters.all.label') }}
              </label>
              <label class="project-config-toggle">
                <input
                  v-model="draft.consensus.mode"
                  type="radio"
                  value="custom"
                  data-testid="project-config-consensus-mode-custom"
                />
                {{ t('workspaceSetting.consensus.voters.custom.label') }}
              </label>
            </div>
            <div
              v-if="draft.consensus.mode === 'custom'"
              class="project-config-row project-config-consensus-agents"
            >
              <template v-if="consensusSelectableAgents.length > 0">
                <label
                  v-for="a in consensusSelectableAgents"
                  :key="a.id"
                  class="project-config-agent-item"
                >
                  <input
                    type="checkbox"
                    :checked="isConsensusAgentSelected(a.id)"
                    :data-testid="`project-config-consensus-agent-${a.id}`"
                    @change="toggleConsensusAgent(a.id)"
                  />
                  {{ a.displayName || a.id }}
                </label>
              </template>
              <p
                v-else
                class="project-config-hint"
                data-testid="project-config-consensus-agents-empty"
              >
                {{ t('workspaceSetting.consensus.voters.empty') }}
              </p>
            </div>
          </template>
        </section>

        <!-- SDD section: master switch + the FIXED, centralized spec root. The spec
             root is resolved server-side (`~/.c3/specs/<project-path-segment>`) and
             is READ-ONLY — it cannot be edited here or via the protocol. -->
        <section class="project-config-section">
          <p class="project-config-section-title">{{ t('workspaceSetting.sdd.title.label') }}</p>
          <p class="project-config-hint">{{ t('workspaceSetting.sdd.hint') }}</p>
          <label class="project-config-toggle">
            <input v-model="draft.sddEnabled" type="checkbox" data-testid="sdd-enabled" />
            {{ t('workspaceSetting.sdd.toggle.label') }}
          </label>
          <div v-if="draft.sddEnabled" class="project-config-row">
            <span class="project-config-row-label">{{
              t('workspaceSetting.sdd.specRoot.title.label')
            }}</span>
            <code class="project-config-readonly" data-testid="sdd-spec-root">{{
              props.resolvedSpecRoot ?? '—'
            }}</code>
          </div>
          <p v-if="draft.sddEnabled" class="project-config-hint">
            {{ t('workspaceSetting.sdd.specRoot.hint') }}
          </p>
        </section>
      </div>

      <!-- ============ Skill repos tab ============ -->
      <div
        v-show="activeTab === 'skillRepos'"
        class="project-config-tab-panel"
        role="tabpanel"
        data-testid="project-config-tab-skillRepos"
      >
        <section class="project-config-section">
          <p class="project-config-section-title">
            {{ t('workspaceSetting.skillRepos.title.label') }}
          </p>
          <p class="project-config-hint">{{ t('workspaceSetting.skillRepos.hint') }}</p>
          <!-- Skills mount silently into every supported vendor at the configured ref's head. -->
          <div
            v-if="!draft.skillRepos || draft.skillRepos.length === 0"
            class="project-config-hint skill-repos-empty"
          >
            {{ t('workspaceSetting.skillRepos.empty') }}
          </div>
          <div
            v-for="r in draft.skillRepos ?? []"
            :key="r.id"
            class="skill-repo-row"
            data-testid="skill-repo-row"
          >
            <input
              v-model="r.id"
              class="agent-field skill-repo-name"
              :placeholder="t('workspaceSetting.skillRepos.id.placeholder')"
              data-testid="skill-repo-id"
            />
            <input
              v-model="r.repo"
              class="agent-field"
              :placeholder="t('workspaceSetting.skillRepos.repo.placeholder')"
              :title="t('workspaceSetting.skillRepos.repo.parseHelp')"
              data-testid="skill-repo-repo"
              @paste="onRepoPaste($event, r.id)"
            />
            <div class="field-group">
              <input
                v-model="r.ref"
                class="agent-field"
                :placeholder="t('workspaceSetting.skillRepos.ref.placeholder')"
                data-testid="skill-repo-ref"
              />
              <span v-if="missingRef(r)" class="field-error" data-testid="skill-repo-ref-error">{{
                t('workspaceSetting.skillRepos.ref.required')
              }}</span>
            </div>
            <input
              v-model="r.subpath"
              class="agent-field"
              :placeholder="t('workspaceSetting.skillRepos.subpath.placeholder')"
              data-testid="skill-repo-subpath"
              @input="onSubpathInput(r)"
            />
            <span
              class="skill-repo-status"
              :class="rowLinked(r) ? 'skill-repo-status-linked' : 'skill-repo-status-unlinked'"
              :data-linked="rowLinked(r) ? 'true' : 'false'"
              data-testid="skill-repo-status"
            >
              {{
                rowLinked(r)
                  ? t('workspaceSetting.skillRepos.status.linked.label')
                  : t('workspaceSetting.skillRepos.status.unlinked.label')
              }}
            </span>
            <button
              class="skill-repo-install"
              :disabled="!canInstall(r)"
              :title="t('workspaceSetting.skillRepos.install.tooltip')"
              data-testid="skill-repo-install"
              @click="onInstall(r)"
            >
              {{
                rowInstalling(r)
                  ? t('workspaceSetting.skillRepos.install.busy.label')
                  : t('workspaceSetting.skillRepos.install.label')
              }}
            </button>
            <button
              class="icon-btn"
              :title="t('workspaceSetting.skillRepos.remove.tooltip')"
              data-testid="skill-repo-remove"
              @click="removeSkillRepo(r.id)"
            >
              🗑
            </button>
          </div>
          <button
            class="agent-add"
            data-testid="project-config-add-skill-repo"
            @click="addSkillRepo"
          >
            {{ t('workspaceSetting.skillRepos.add.label') }}
          </button>
        </section>
      </div>
    </div>

    <div class="project-config-foot">
      <!-- Per-tab Save lives beside Close; only the active tab's Save is shown. -->
      <div v-show="activeTab === 'defaultMode'" class="project-config-tab-actions">
        <span
          v-if="tabDirtyMap.defaultMode"
          class="project-config-unsaved"
          data-testid="project-config-unsaved-defaultMode"
          >{{ t('workspaceSetting.tabs.unsaved.label') }}</span
        >
        <button data-testid="project-config-save-defaultMode" @click="saveTab('defaultMode')">
          {{ t('common.action.save.label') }}
        </button>
      </div>
      <div v-show="activeTab === 'gitSandbox'" class="project-config-tab-actions">
        <span
          v-if="tabDirtyMap.gitSandbox"
          class="project-config-unsaved"
          data-testid="project-config-unsaved-gitSandbox"
          >{{ t('workspaceSetting.tabs.unsaved.label') }}</span
        >
        <button data-testid="project-config-save-gitSandbox" @click="saveTab('gitSandbox')">
          {{ t('common.action.save.label') }}
        </button>
      </div>
      <div v-show="activeTab === 'collab'" class="project-config-tab-actions">
        <span
          v-if="tabDirtyMap.collab"
          class="project-config-unsaved"
          data-testid="project-config-unsaved-collab"
          >{{ t('workspaceSetting.tabs.unsaved.label') }}</span
        >
        <button data-testid="project-config-save-collab" @click="saveTab('collab')">
          {{ t('common.action.save.label') }}
        </button>
      </div>
      <div v-show="activeTab === 'skillRepos'" class="project-config-tab-actions">
        <span
          v-if="tabDirtyMap.skillRepos"
          class="project-config-unsaved"
          data-testid="project-config-unsaved-skillRepos"
          >{{ t('workspaceSetting.tabs.unsaved.label') }}</span
        >
        <button data-testid="project-config-save-skillRepos" @click="saveTab('skillRepos')">
          {{ t('common.action.save.label') }}
        </button>
      </div>
      <button class="ghost" data-testid="project-config-close" @click="emit('close')">
        {{ t('common.action.close.label') }}
      </button>
    </div>

    <!-- Confirm leaving a tab with unsaved changes (the draft is kept, not lost). -->
    <ConfirmDialog
      :open="pendingTabSwitch !== null"
      :title="t('workspaceSetting.tabs.switch.confirm.title')"
      :message="t('workspaceSetting.tabs.switch.confirm.body')"
      :confirm-label="t('workspaceSetting.tabs.switch.confirm.confirm')"
      :cancel-label="t('workspaceSetting.tabs.switch.confirm.stay')"
      @confirm="confirmTabSwitch"
      @cancel="cancelTabSwitch"
    />
  </div>
</template>

<style scoped>
.project-config-page {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary, #1e1e2e);
  color: var(--text-primary, #cdd6f4);
}

.project-config-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  border-bottom: 1px solid var(--border, #313244);
}

.project-config-head h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

/* ---- Tab navigation ---- */
/* Rendered by the shared TabNav component: `.project-config-tabs` is its root, which
   still carries this page's scope attribute, so it styles normally; the buttons and
   the dot live inside the component and need `:deep`. This page keeps ownership of
   the selectors so each settings page can style its own tab bar.
   Scrolls horizontally on narrow screens so all tabs stay reachable without wrapping. */
.project-config-tabs {
  display: flex;
  flex-shrink: 0;
  gap: 8px;
  padding: 0 24px;
  border-bottom: 1px solid var(--border, #313244);
  overflow-x: auto;
  scrollbar-width: none;
}
.project-config-tabs::-webkit-scrollbar {
  display: none;
}
.project-config-tabs :deep(.project-config-tab) {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  height: 40px;
  padding: 0 12px;
  background: transparent;
  border: 0;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  color: var(--text-secondary, #a6adc8);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
}
.project-config-tabs :deep(.project-config-tab:hover:not(:disabled)) {
  filter: none;
  color: var(--text-primary, #cdd6f4);
}
.project-config-tabs :deep(.project-config-tab.active) {
  color: var(--text-primary, #cdd6f4);
  border-bottom-color: var(--c-primary, #89b4fa);
}
/* Unsaved-changes marker on a tab. */
.project-config-tabs :deep(.project-config-tab-dot) {
  color: var(--c-warning, #f9e2af);
  font-size: 0.6em;
  line-height: 1;
}
/* Per-tab Save row in the footer: save button + optional unsaved-changes label,
   shown beside the Close button for the active tab. */
.project-config-tab-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
}
.project-config-unsaved {
  font-size: 12px;
  color: var(--text-secondary, #a6adc8);
}

.project-config-body {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}

.project-config-section {
  padding: var(--sp-4) var(--sp-6);
  background: var(--c-card);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
}
.project-config-section + .project-config-section {
  margin-top: var(--sp-6);
}

.project-config-section-title {
  margin: 0 0 4px;
  font-size: 14px;
  font-weight: 600;
}

.project-config-hint {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--text-secondary, #a6adc8);
  line-height: 1.5;
}

.project-config-field {
  width: 100%;
  max-width: 400px;
  padding: 6px 10px;
  border: 1px solid var(--border, #313244);
  border-radius: 6px;
  background: var(--bg-secondary, #181825);
  color: var(--text-primary, #cdd6f4);
  font-size: 13px;
}

.project-config-number {
  max-width: 120px;
}

/* Read-only resolved value (e.g. the fixed, centralized SDD spec root). */
.project-config-readonly {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  border: 1px solid var(--border, #313244);
  border-radius: 6px;
  background: var(--bg, #11111b);
  color: var(--text-secondary, #a6adc8);
  font-size: 12px;
  font-family: var(--font-mono, ui-monospace, monospace);
  word-break: break-all;
}

/* Built-in (embedded) allowed dirs — read-only, non-editable informational list. */
.project-config-embedded-mounts {
  list-style: none;
  margin: 0 0 10px;
  padding: 8px 10px;
  border: 1px dashed var(--border, #313244);
  border-radius: 6px;
  background: var(--bg, #11111b);
}
.project-config-embedded-caption {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary, #a6adc8);
  margin-bottom: 6px;
}
.project-config-embedded-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  padding: 4px 0;
}
.project-config-embedded-name {
  flex-shrink: 0;
  min-width: 96px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary, #cdd6f4);
}
.project-config-embedded-desc {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text-secondary, #a6adc8);
}
.project-config-embedded-badge {
  flex-shrink: 0;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 11px;
  color: var(--text-secondary, #a6adc8);
  background: var(--bg-secondary, #181825);
  border: 1px solid var(--border, #313244);
}
.project-config-embedded-lock {
  flex-shrink: 0;
  font-size: 11px;
  opacity: 0.7;
}

/* --- Compact row layout (label + control on same line) --- */
.project-config-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin-bottom: 8px;
}
.project-config-row > .project-config-toggle {
  margin-top: 0;
}

.project-config-row-label {
  flex-shrink: 0;
  min-width: 100px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary, #a6adc8);
}

/* Inline field: label + control group used inside a row (e.g. Codex dual policy) */
.inline-field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
.inline-field-label {
  font-size: 12px;
  color: var(--text-secondary, #a6adc8);
  white-space: nowrap;
}

.project-config-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 13px;
  cursor: pointer;
}

.project-config-toggle input[type='checkbox'] {
  margin: 0;
}

.project-config-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 24px;
  border-top: 1px solid var(--border, #313244);
}

.skill-repo-status {
  display: inline-flex;
  align-items: center;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
}
.skill-repo-status-linked {
  color: var(--c-success, #a6e3a1);
}
.skill-repo-status-unlinked {
  color: var(--text-secondary, #a6adc8);
}

.skill-repo-install {
  flex: 0 0 auto;
  height: 30px;
  padding: 0 12px;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}

@media (max-width: 767px) {
  .project-config-page {
    height: 100dvh;
  }

  .project-config-head {
    flex-shrink: 0;
    padding: calc(12px + env(safe-area-inset-top)) 16px 12px;
  }

  .project-config-tabs {
    padding: 0 16px;
  }

  .project-config-body {
    min-height: 0;
    padding: 16px;
  }

  .project-config-section {
    padding: 16px;
    border-radius: var(--radius-md);
  }

  .project-config-section + .project-config-section {
    margin-top: 16px;
  }

  .project-config-row,
  .inline-field,
  .skill-repo-row {
    flex-direction: column;
    align-items: stretch;
  }

  .project-config-row-label,
  .inline-field-label {
    min-width: 0;
    white-space: normal;
  }

  .project-config-field,
  .project-config-number,
  .mode-select,
  .skill-repo-row .agent-field,
  .skill-repo-row .skill-repo-name {
    width: 100%;
    max-width: none;
    flex: 1 1 auto;
  }

  .project-config-toggle {
    align-items: flex-start;
  }

  .project-config-foot {
    flex-shrink: 0;
    padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
  }

  .project-config-foot > .project-config-tab-actions {
    flex: 1;
  }
  .project-config-foot button {
    flex: 1;
  }
}
</style>
