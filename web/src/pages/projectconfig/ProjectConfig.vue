<script setup lang="ts">
/*
 * ProjectConfig.vue — 项目配置页：编辑 5 项 workspace 级配置。
 *
 * 编辑用本地草稿，打开时从 App 注入的服务端配置深拷贝而来，保存时整体上抛。
 * 沿用 SettingsPanel 的草稿编辑模式。
 */
import { ref, watch } from 'vue'
import type { PermissionMode, ProjectConfig, SkillRepoConfig } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'
import { useModeLabel } from '@/composables/useModeLabel'

const { t } = useTypedI18n()
const modeLabel = useModeLabel()

const MODES: PermissionMode[] = ['default', 'auto', 'plan', 'acceptEdits', 'bypassPermissions']

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
}>()

const emit = defineEmits<{
  close: []
  save: [config: ProjectConfig]
}>()

// A local, editable copy of the project config; committed on Save.
const draft = ref<ProjectConfig>({
  defaultMode: 'default',
  devSkill: '',
  maxRoundsPerStage: DEFAULT_ROUNDS_PER_STAGE,
  maxSpeechChars: DEFAULT_SPEECH_CHARS,
  consensus: { enabled: false, majority: false },
  skillRepos: [],
})

// Re-seed the draft whenever the panel opens or fresh server config arrives.
watch(
  () => [props.open, props.projectConfig] as const,
  ([open, config]) => {
    if (!open) return
    draft.value = {
      defaultMode: config?.defaultMode ?? 'default',
      devSkill: config?.devSkill ?? '',
      maxRoundsPerStage: config?.maxRoundsPerStage ?? DEFAULT_ROUNDS_PER_STAGE,
      maxSpeechChars: config?.maxSpeechChars ?? DEFAULT_SPEECH_CHARS,
      consensus: {
        enabled: config?.consensus?.enabled ?? false,
        majority: config?.consensus?.majority ?? false,
      },
      skillRepos: config?.skillRepos ? config.skillRepos.map((r) => ({ ...r })) : [],
    }
  },
  { immediate: true },
)

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
        <select v-model="draft.defaultMode" class="mode-select">
          <option v-for="m in MODES" :key="m" :value="m">{{ modeLabel(m) }}</option>
        </select>
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
    </div>
    <div class="project-config-foot">
      <button class="ghost" @click="emit('close')">{{ t('common.action.cancel.label') }}</button>
      <button data-testid="project-config-save" @click="emit('save', draft)">
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
  margin-bottom: 28px;
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
