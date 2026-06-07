<script setup lang="ts">
/*
 * ProjectConfig.vue — 项目配置页：编辑 5 项 workspace 级配置。
 *
 * 编辑用本地草稿，打开时从 App 注入的服务端配置深拷贝而来，保存时整体上抛。
 * 沿用 SettingsPanel 的草稿编辑模式。
 */
import { ref, watch } from 'vue'
import type { PermissionMode, ProjectConfig } from '@ccc/shared/protocol'
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
    }
  },
  { immediate: true },
)
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
