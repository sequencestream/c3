<script setup lang="ts">
/*
 * ProjectConfig.vue — 项目配置页：编辑 5 项 workspace 级配置。
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
  ProjectConfig,
  ProjectSandboxConfig,
  SkillRepoConfig,
  SystemSandboxDef,
  VendorId,
  VendorModeCatalog,
  ModeToken,
} from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'
import { useModeLabel } from '@/composables/useModeLabel'

const { t } = useTypedI18n()
const modeLabel = useModeLabel()

// Render order for per-vendor sections in the form.
const VENDOR_ORDER: VendorId[] = ['claude', 'codex', 'opencode']

// Per-stage discussion round cap: floor enforced both here and server-side.
const MIN_ROUNDS_PER_STAGE = 8
const DEFAULT_ROUNDS_PER_STAGE = 12

// Discussion speech character limit: minimum enforced both here and server-side.
const MIN_SPEECH_CHARS = 300
const DEFAULT_SPEECH_CHARS = 300

const props = defineProps<{
  open: boolean
  projectConfig: ProjectConfig | null
  currentWorkspace: string | null
  vendorModes: Record<VendorId, VendorModeCatalog> | null
  /** System sandbox definitions — drives the sandbox name dropdown. */
  systemSandboxes: SystemSandboxDef[]
}>()

const emit = defineEmits<{
  close: []
  save: [config: ProjectConfig]
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
      { claude: 'default', codex: 'auto', opencode: 'build' }[v]) as ModeToken
  }
  return out as Record<VendorId, ModeToken>
}

/**
/** Section heading for a vendor using the configured i18n label. */
function vendorSectionLabel(v: VendorId): string {
  return t(`projectConfig.defaultMode.section.${v}.label` as const)
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

// A local, editable copy of the project config; committed on Save.
const draft = ref<ProjectConfig>({
  defaultMode: freshDefaultMode(null),
  devSkill: '',
  maxRoundsPerStage: DEFAULT_ROUNDS_PER_STAGE,
  maxSpeechChars: DEFAULT_SPEECH_CHARS,
  consensus: { enabled: false, majority: false },
  skillRepos: [],
})

// Codex dual-policy draft (2026-06-08).
const draftCodexPolicy = ref<CodexPolicy>({
  sandboxMode: 'workspace-write',
  approvalPolicy: 'on-request',
})

// Re-seed the draft whenever the panel opens or fresh server config arrives.
watch(
  () => [props.open, props.projectConfig, props.vendorModes, props.systemSandboxes] as const,
  ([open, config, vm, sandboxes]) => {
    if (!open) return
    draft.value = {
      defaultMode: loadDefaultMode(config?.defaultMode, vm),
      devSkill: config?.devSkill ?? '',
      maxRoundsPerStage: config?.maxRoundsPerStage ?? DEFAULT_ROUNDS_PER_STAGE,
      maxSpeechChars: config?.maxSpeechChars ?? DEFAULT_SPEECH_CHARS,
      consensus: {
        enabled: config?.consensus?.enabled ?? false,
        majority: config?.consensus?.majority ?? false,
      },
      skillRepos: config?.skillRepos ? config.skillRepos.map((r) => ({ ...r })) : [],
    }
    // Re-seed the sandbox draft from server config (sandboxDraft computed
    // wraps draft.value.sandbox, which starts undefined — the watch sets it).
    // Validate that the referenced sandbox name still exists in the current
    // system definitions — if it was deleted or renamed, treat as unconfigured.
    if (config?.sandbox && config.sandbox.sandbox && sandboxes.some(sb => sb.name === config.sandbox!.sandbox)) {
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
  },
  { immediate: true },
)

// Always-non-null defaultMode ref for the template (ProjectConfig.defaultMode is optional).
const draftDefaultMode = computed(
  () => draft.value.defaultMode ?? { claude: 'default', codex: 'auto', opencode: 'build' },
)

/**
 * Always-non-null sandbox ref for the template (ProjectConfig.sandbox is optional).
 * Exported as `sandboxDraft` so v-model bindings don't trigger "possibly undefined"
 * even when sandbox hasn't been explicitly set.
 */
const sandboxDraft = computed<ProjectSandboxConfig>({
  get: () => draft.value.sandbox ?? {},
  set: (val) => {
    draft.value.sandbox = val
  },
})

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

function onSave() {
  // Inject the Codex dual-policy object into the saved defaultMode (2026-06-08).
  const defaultMode: Record<string, unknown> = {
    ...(draft.value.defaultMode as Record<string, unknown>),
  }
  defaultMode['codex'] = { ...draftCodexPolicy.value }
  // Only emit sandbox when enabled (or has meaningful fields); the server
  // normalizeSandboxConfig also strips empty objects on persist.
  const sandbox = sandboxDraft.value.enabled ? sandboxDraft.value : undefined
  emit('save', {
    ...draft.value,
    defaultMode: defaultMode as ProjectConfig['defaultMode'],
    sandbox,
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
  if (parsed.subpath) updated.subpath = parsed.subpath
  draft.value.skillRepos = [...list.slice(0, idx), updated, ...list.slice(idx + 1)]
}
</script>

<template>
  <div v-if="open" class="project-config-page">
    <div class="project-config-head">
      <h2>{{ t('projectConfig.title.label') }}</h2>
      <button class="icon-btn" :title="t('common.action.close.tooltip')" @click="emit('close')">
        ✕
      </button>
    </div>
    <div class="project-config-body">
      <section class="project-config-section">
        <p class="project-config-section-title">{{ t('projectConfig.defaultMode.title.label') }}</p>
        <p class="project-config-hint">{{ t('projectConfig.defaultMode.hint') }}</p>
        <div v-for="v in VENDOR_ORDER" :key="v" class="project-config-vendor-mode">
          <p class="project-config-vendor-label">{{ vendorSectionLabel(v) }}</p>
          <!-- Codex dual-policy config (2026-06-08): independent sandbox + approval dropdowns -->
          <template v-if="v === 'codex'">
            <div class="codex-dual-policy">
              <label class="codex-policy-field">
                {{ t('codex.sandboxMode.label') }}
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
              <label class="codex-policy-field">
                {{ t('codex.approvalPolicy.label') }}
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
            </div>
          </template>
          <!-- Claude / Opencode: catalog-based single-select -->
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
        <p class="project-config-section-title">{{ t('projectConfig.devSkill.title.label') }}</p>
        <p class="project-config-hint">{{ t('projectConfig.devSkill.hint') }}</p>
        <input
          v-model="draft.devSkill"
          class="project-config-field"
          :placeholder="t('projectConfig.devSkill.placeholder')"
        />
      </section>

      <section class="project-config-section">
        <p class="project-config-section-title">{{ t('projectConfig.rounds.title.label') }}</p>
        <p class="project-config-hint">
          {{ t('projectConfig.rounds.hint', { min: MIN_ROUNDS_PER_STAGE }) }}
        </p>
        <input
          v-model.number="draft.maxRoundsPerStage"
          class="project-config-field project-config-number"
          type="number"
          :min="MIN_ROUNDS_PER_STAGE"
          step="1"
        />
      </section>

      <section class="project-config-section">
        <p class="project-config-section-title">{{ t('projectConfig.speechChars.title.label') }}</p>
        <p class="project-config-hint">
          {{ t('projectConfig.speechChars.hint', { min: MIN_SPEECH_CHARS }) }}
        </p>
        <input
          v-model.number="draft.maxSpeechChars"
          class="project-config-field project-config-number"
          type="number"
          :min="MIN_SPEECH_CHARS"
          step="1"
        />
      </section>

      <section class="project-config-section">
        <p class="project-config-section-title">{{ t('projectConfig.consensus.title.label') }}</p>
        <i18n-t keypath="projectConfig.consensus.hint1.text" tag="p" class="project-config-hint">
          <template #other
            ><em>{{ t('projectConfig.consensus.hint1.other') }}</em></template
          >
        </i18n-t>
        <i18n-t keypath="projectConfig.consensus.hint2.text" tag="p" class="project-config-hint">
          <template #ask
            ><strong>{{ t('projectConfig.consensus.hint2.ask') }}</strong></template
          >
          <template #you
            ><em>{{ t('projectConfig.consensus.hint2.you') }}</em></template
          >
          <template #on
            ><em>{{ t('projectConfig.consensus.hint2.on') }}</em></template
          >
        </i18n-t>
        <label v-if="draft.consensus" class="project-config-toggle">
          <input v-model="draft.consensus.enabled" type="checkbox" />
          {{ t('projectConfig.consensus.toggle.label') }}
        </label>
        <label v-if="draft.consensus" class="project-config-toggle">
          <input
            v-model="draft.consensus.majority"
            type="checkbox"
            data-testid="project-config-consensus-majority"
          />
          {{ t('projectConfig.consensus.majority.label') }}
        </label>
      </section>

      <section class="project-config-section">
        <p class="project-config-section-title">{{ t('projectConfig.skillRepos.title.label') }}</p>
        <p class="project-config-hint">{{ t('projectConfig.skillRepos.hint') }}</p>
        <!-- Skills mount silently into every supported vendor at the configured ref's head. -->
        <div
          v-if="!draft.skillRepos || draft.skillRepos.length === 0"
          class="project-config-hint skill-repos-empty"
        >
          {{ t('projectConfig.skillRepos.empty') }}
        </div>
        <div
          v-for="r in draft.skillRepos ?? []"
          :key="r.id"
          class="skill-repo-row"
          data-testid="skill-repo-row"
        >
          <input
            v-model="r.id"
            class="agent-field"
            :placeholder="t('projectConfig.skillRepos.id.placeholder')"
            data-testid="skill-repo-id"
          />
          <input
            v-model="r.repo"
            class="agent-field"
            :placeholder="t('projectConfig.skillRepos.repo.placeholder')"
            :title="t('projectConfig.skillRepos.repo.parseHelp')"
            data-testid="skill-repo-repo"
            @paste="onRepoPaste($event, r.id)"
          />
          <div class="field-group">
            <input
              v-model="r.ref"
              class="agent-field"
              :placeholder="t('projectConfig.skillRepos.ref.placeholder')"
              data-testid="skill-repo-ref"
            />
            <span v-if="missingRef(r)" class="field-error" data-testid="skill-repo-ref-error">{{
              t('projectConfig.skillRepos.ref.required')
            }}</span>
          </div>
          <input
            v-model="r.subpath"
            class="agent-field"
            :placeholder="t('projectConfig.skillRepos.subpath.placeholder')"
            data-testid="skill-repo-subpath"
          />
          <button
            class="icon-btn"
            :title="t('projectConfig.skillRepos.remove.tooltip')"
            data-testid="skill-repo-remove"
            @click="removeSkillRepo(r.id)"
          >
            🗑
          </button>
        </div>
        <button class="agent-add" data-testid="project-config-add-skill-repo" @click="addSkillRepo">
          {{ t('projectConfig.skillRepos.add.label') }}
        </button>
      </section>

      <!-- Sandbox section: only visible when system sandbox definitions exist -->
      <section
        v-if="props.systemSandboxes.length > 0"
        class="project-config-section"
        data-testid="project-config-sandbox"
      >
        <p class="project-config-section-title">{{ t('projectConfig.sandbox.title.label') }}</p>
        <p class="project-config-hint">{{ t('projectConfig.sandbox.hint') }}</p>

        <label class="project-config-toggle">
          <input
            v-model="sandboxDraft.enabled"
            type="checkbox"
            :true-value="true"
            :false-value="undefined"
            data-testid="project-config-sandbox-enabled"
          />
          {{ t('projectConfig.sandbox.enable.label') }}
        </label>

        <template v-if="sandboxDraft.enabled">
          <div class="project-config-vendor-mode">
            <p class="project-config-vendor-label">{{ t('projectConfig.sandbox.name.label') }}</p>
            <select
              v-model="sandboxDraft.sandbox"
              class="mode-select"
              data-testid="project-config-sandbox-name"
            >
              <option value="" disabled>
                {{ t('projectConfig.sandbox.name.placeholder') }}
              </option>
              <option v-for="sb in props.systemSandboxes" :key="sb.name" :value="sb.name">
                {{ sb.name }}
              </option>
            </select>
          </div>

          <label class="project-config-toggle">
            <input v-model="sandboxDraft.networkDisabled" type="checkbox" />
            {{ t('projectConfig.sandbox.networkDisabled.label') }}
          </label>

          <div class="project-config-vendor-mode">
            <p class="project-config-vendor-label">
              {{ t('projectConfig.sandbox.memoryLimitOverride.label') }}
            </p>
            <input
              v-model="sandboxDraft.memoryLimitOverride"
              class="project-config-field"
              :placeholder="t('projectConfig.sandbox.memoryLimitOverride.placeholder')"
              data-testid="project-config-sandbox-memory"
            />
          </div>

          <div class="project-config-vendor-mode">
            <p class="project-config-vendor-label">
              {{ t('projectConfig.sandbox.cpuLimitOverride.label') }}
            </p>
            <input
              v-model.number="sandboxDraft.cpuLimitOverride"
              class="project-config-field project-config-number"
              type="number"
              min="0"
              step="0.5"
              :placeholder="t('projectConfig.sandbox.cpuLimitOverride.placeholder')"
              data-testid="project-config-sandbox-cpu"
            />
          </div>

          <div class="project-config-vendor-mode">
            <p class="project-config-vendor-label">
              {{ t('projectConfig.sandbox.imageOverride.label') }}
            </p>
            <input
              v-model="sandboxDraft.imageOverride"
              class="project-config-field"
              :placeholder="t('projectConfig.sandbox.imageOverride.placeholder')"
              data-testid="project-config-sandbox-image"
            />
          </div>
        </template>
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

.project-config-vendor-mode {
  margin-bottom: 12px;
}

.project-config-vendor-label {
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary, #a6adc8);
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
</style>
