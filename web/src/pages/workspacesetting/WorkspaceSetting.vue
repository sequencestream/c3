<script setup lang="ts">
/*
 * WorkspaceSetting.vue — 工作区配置页：编辑 workspace 级配置。
 *
 * 编辑用本地草稿，打开时从 App 注入的服务端配置深拷贝而来，保存时整体上抛。
 * 沿用 SettingsPanel 的草稿编辑模式。
 */
import { ref, computed, watch } from 'vue'
import type {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  CodexApprovalPolicy,
  CodexPolicy,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  CodexSandboxMode,
  WorkspaceSetting,
  WorkspaceSandboxConfig,
  AgentConfig,
  SkillRepoConfig,
  SkillLinkStatus,
  SystemSandboxDef,
  VendorId,
  VendorModeCatalog,
  ModeToken,
} from '@ccc/shared/protocol'
import { GIT_BRANCH_MODES } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'
import { useModeLabel } from '@/composables/useModeLabel'

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
  currentWorkspace: string | null
  vendorModes: Record<VendorId, VendorModeCatalog> | null
  /** System sandbox definitions — drives the sandbox name dropdown. */
  systemSandboxes: SystemSandboxDef[]
  /** All configured agents — the sandbox agent picker shows enabled custom ones. */
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

/**
/** Section heading for a vendor using the configured i18n label. */
function vendorSectionLabel(v: VendorId): string {
  return t(`workspaceSetting.defaultMode.section.${v}.label` as const)
}

/**
 * Read the per-vendor default-mode map from server config, handling both
 * the new `Record<VendorId, ModeToken>` and legacy single-string formats.
 */
function loadDefaultMode(
  src: Record<VendorId, ModeToken | CodexPolicy> | string | undefined,
  vendorModes: Record<VendorId, VendorModeCatalog> | null,
): Record<VendorId, ModeToken | CodexPolicy> {
  if (src && typeof src === 'object') {
    return { ...freshDefaultMode(vendorModes), ...src } as Record<VendorId, ModeToken | CodexPolicy>
  }
  return freshDefaultMode(vendorModes)
}

// A local, editable copy of the workspace setting; committed on Save.
const draft = ref<WorkspaceSetting>({
  defaultMode: freshDefaultMode(null),
  devSkill: '',
  maxRoundsPerStage: DEFAULT_ROUNDS_PER_STAGE,
  maxSpeechChars: DEFAULT_SPEECH_CHARS,
  consensus: { enabled: false, majority: false, mode: 'all', agentIds: [] },
  skillRepos: [],
  gitBranchMode: 'current-branch',
  defaultMainBranch: '',
})

// Codex dual-policy draft (2026-06-08).
const draftCodexPolicy = ref<CodexPolicy>({
  sandboxMode: 'workspace-write',
  approvalPolicy: 'on-request',
})

// Re-seed the draft whenever the panel opens or fresh server config arrives.
watch(
  () =>
    [
      props.open,
      props.workspaceSetting,
      props.detectedMainBranch,
      props.vendorModes,
      props.systemSandboxes,
    ] as const,
  ([open, config, detected, vm, sandboxes]) => {
    if (!open) return
    draft.value = {
      defaultMode: loadDefaultMode(config?.defaultMode, vm),
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
    }
    // Re-seed the sandbox draft from server config (sandboxDraft computed
    // wraps draft.value.sandbox, which starts undefined — the watch sets it).
    // Validate that the referenced sandbox name still exists in the current
    // system definitions — if it was deleted or renamed, treat as unconfigured.
    if (
      config?.sandbox &&
      config.sandbox.sandbox &&
      sandboxes.some((sb) => sb.name === config.sandbox!.sandbox)
    ) {
      draft.value.sandbox = { ...config.sandbox }
    } else {
      // Keep a reactive empty object so the sandboxDraft computed's v-model
      // bindings (e.g. `sandboxDraft.enabled`) propagate through Vue reactivity
      // instead of being lost on the non-reactive `?? {}` fallback (which breaks
      // the "enable" checkbox and hides the sandbox name dropdown).
      draft.value.sandbox = {}
    }
    // Seed codex policy from config: CodexPolicy object or translate legacy token.
    const codexVal = config?.defaultMode?.['codex']
    if (codexVal && typeof codexVal === 'object' && 'sandboxMode' in codexVal) {
      draftCodexPolicy.value = codexVal as CodexPolicy
    } else if (codexVal === 'read-only') {
      draftCodexPolicy.value = { sandboxMode: 'read-only', approvalPolicy: 'on-request' }
    } else if (codexVal === 'full-access') {
      draftCodexPolicy.value = { sandboxMode: 'workspace-write', approvalPolicy: 'never' }
    } else {
      // auto or fallback
      draftCodexPolicy.value = { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' }
    }
    // Ask the parent to (re)fetch each skill repo's link status for this workspace.
    // No auto-polling — only on open (and after an install completes, via the parent).
    emit('queryLinkStatus')
  },
  { immediate: true },
)

// Always-non-null defaultMode ref for the template (WorkspaceSetting.defaultMode is optional).
const draftDefaultMode = computed(
  () => draft.value.defaultMode ?? { claude: 'default', codex: 'auto' },
)

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

/**
 * Custom agents that may be selected for the sandbox container — mirrors the
 * server's custom-only normalize invariant (`enabled && configMode === 'custom'`).
 */
const selectableAgents = computed<AgentConfig[]>(() =>
  (props.agents ?? []).filter((a) => a.enabled && a.configMode === 'custom'),
)

/** Whether the given agent id is in the sandbox draft's `agentIds` pool. */
function isAgentSelected(id: string): boolean {
  return (sandboxDraft.value.agentIds ?? []).includes(id)
}

/** Toggle an agent id in the sandbox draft's `agentIds` pool. */
function toggleAgent(id: string): void {
  const current = sandboxDraft.value.agentIds ?? []
  const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id]
  sandboxDraft.value = { ...sandboxDraft.value, agentIds: next.length > 0 ? next : undefined }
}

// ---- Consensus custom voter picker ----

/**
 * Agents selectable as custom consensus voters — every enabled agent. The
 * runtime intersects this allowlist with the session's own vendor + enabled set
 * (`vendorScopedVoters`), so the picker need not pre-filter by vendor; a cross-
 * vendor pick is simply inert for a session of a different vendor.
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

function onSave() {
  // Inject the Codex dual-policy object into the saved defaultMode (2026-06-08).
  const defaultMode: Record<string, unknown> = {
    ...(draft.value.defaultMode as Record<string, unknown>),
  }
  defaultMode['codex'] = { ...draftCodexPolicy.value }
  // Sandbox is worktree-only: emit it only when the branch mode is `worktree`
  // AND it is enabled. Under current-branch the section is hidden, so we drop
  // any (now-stale) sandbox draft rather than persisting a hidden dirty config.
  // The server normalizeSandboxConfig also enforces this + strips empty objects.
  const sandbox =
    draft.value.gitBranchMode === 'worktree' && sandboxDraft.value.enabled
      ? sandboxDraft.value
      : undefined
  // Trim the branch; empty ⇒ omit (server normalizes blank → undefined anyway).
  const defaultMainBranch = draft.value.defaultMainBranch?.trim() || undefined
  emit('save', {
    ...draft.value,
    defaultMode: defaultMode as WorkspaceSetting['defaultMode'],
    sandbox,
    defaultMainBranch,
  })
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
    <div class="project-config-body">
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

      <!-- Sandbox section: worktree-only — isolation only makes sense in an
           isolated worktree (under current-branch the container would bind-mount
           the live checkout), so it is grouped right after the git branch
           strategy and hidden whenever the mode is not `worktree`. -->
      <section
        v-if="draft.gitBranchMode === 'worktree' && props.systemSandboxes.length > 0"
        class="project-config-section"
        data-testid="project-config-sandbox"
      >
        <p class="project-config-section-title">{{ t('workspaceSetting.sandbox.title.label') }}</p>
        <p class="project-config-hint">{{ t('workspaceSetting.sandbox.hint') }}</p>

        <label class="project-config-toggle">
          <input
            v-model="sandboxDraft.enabled"
            type="checkbox"
            :true-value="true"
            :false-value="undefined"
            data-testid="project-config-sandbox-enabled"
          />
          {{ t('workspaceSetting.sandbox.enable.label') }}
        </label>

        <template v-if="sandboxDraft.enabled">
          <div class="project-config-row">
            <span class="project-config-row-label">{{
              t('workspaceSetting.sandbox.name.label')
            }}</span>
            <select
              v-model="sandboxDraft.sandbox"
              class="mode-select"
              data-testid="project-config-sandbox-name"
            >
              <option value="" disabled>
                {{ t('workspaceSetting.sandbox.name.placeholder') }}
              </option>
              <option v-for="sb in props.systemSandboxes" :key="sb.name" :value="sb.name">
                {{ sb.name }}
              </option>
            </select>
          </div>

          <div class="project-config-row">
            <span class="project-config-row-label">{{
              t('workspaceSetting.sandbox.networkDisabled.label')
            }}</span>
            <input v-model="sandboxDraft.networkDisabled" type="checkbox" />
          </div>

          <div class="project-config-row">
            <span class="project-config-row-label">{{
              t('workspaceSetting.sandbox.memoryLimitOverride.label')
            }}</span>
            <input
              v-model="sandboxDraft.memoryLimitOverride"
              class="project-config-field"
              :placeholder="t('workspaceSetting.sandbox.memoryLimitOverride.placeholder')"
              data-testid="project-config-sandbox-memory"
            />
          </div>

          <div class="project-config-row">
            <span class="project-config-row-label">{{
              t('workspaceSetting.sandbox.cpuLimitOverride.label')
            }}</span>
            <input
              v-model.number="sandboxDraft.cpuLimitOverride"
              class="project-config-field project-config-number"
              type="number"
              min="0"
              step="0.5"
              :placeholder="t('workspaceSetting.sandbox.cpuLimitOverride.placeholder')"
              data-testid="project-config-sandbox-cpu"
            />
          </div>

          <div class="project-config-row">
            <span class="project-config-row-label">{{
              t('workspaceSetting.sandbox.imageOverride.label')
            }}</span>
            <input
              v-model="sandboxDraft.imageOverride"
              class="project-config-field"
              :placeholder="t('workspaceSetting.sandbox.imageOverride.placeholder')"
              data-testid="project-config-sandbox-image"
            />
          </div>

          <!-- Agent multi-select: the whole section is already worktree-gated,
               so no inner branch-mode check is needed — list the enabled custom
               agents, or an empty-state hint when there are none. -->
          <div class="project-config-row project-config-sandbox-agents">
            <span class="project-config-row-label">{{
              t('workspaceSetting.sandbox.agents.label')
            }}</span>
            <div
              v-if="selectableAgents.length > 0"
              class="project-config-agent-list"
              data-testid="project-config-sandbox-agents"
            >
              <p class="project-config-hint">{{ t('workspaceSetting.sandbox.agents.hint') }}</p>
              <label v-for="a in selectableAgents" :key="a.id" class="project-config-agent-item">
                <input
                  type="checkbox"
                  :checked="isAgentSelected(a.id)"
                  :data-testid="`project-config-sandbox-agent-${a.id}`"
                  @change="toggleAgent(a.id)"
                />
                {{ a.displayName || a.id }}
              </label>
            </div>
            <p v-else class="project-config-hint" data-testid="project-config-sandbox-agents-empty">
              {{ t('workspaceSetting.sandbox.agents.empty') }}
            </p>
          </div>
        </template>
      </section>

      <section class="project-config-section">
        <p class="project-config-section-title">
          {{ t('workspaceSetting.consensus.title.label') }}
        </p>
        <i18n-t keypath="workspaceSetting.consensus.hint1.text" tag="p" class="project-config-hint">
          <template #other
            ><em>{{ t('workspaceSetting.consensus.hint1.other') }}</em></template
          >
        </i18n-t>
        <i18n-t keypath="workspaceSetting.consensus.hint2.text" tag="p" class="project-config-hint">
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
        <button class="agent-add" data-testid="project-config-add-skill-repo" @click="addSkillRepo">
          {{ t('workspaceSetting.skillRepos.add.label') }}
        </button>
      </section>
    </div>
    <div class="project-config-foot">
      <button class="ghost" @click="emit('close')">{{ t('common.action.cancel.label') }}</button>
      <button data-testid="project-config-save" @click="onSave">
        {{ t('common.action.save.label') }}
      </button>
    </div>
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

  .project-config-foot button {
    flex: 1;
  }
}
</style>
