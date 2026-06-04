<script setup lang="ts">
/*
 * SettingsPanel.vue — 系统设置页：agent 列表（含默认 agent）与共识投票开关。
 *
 * 编辑用本地草稿，打开时从 App 注入的服务端设置深拷贝而来，保存时整体上抛。
 */
import { computed, ref, watch } from 'vue'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'
import type { AgentConfig, PermissionMode, SystemSettings, UiLang } from '@ccc/shared/protocol'
import { useTypedI18n, isLocaleEnabled, type Locale } from '@/i18n'
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

// 浏览器语音输入的可选识别语言（BCP-47）。与 UI 语言（UI_LANGS）彻底解耦。
const VOICE_LANGS = computed<{ value: string; label: string }[]>(() => [
  { value: 'zh-CN', label: t('settings.voiceLang.zhCN.label') },
  { value: 'en-US', label: t('settings.voiceLang.enUS.label') },
  { value: 'zh-TW', label: t('settings.voiceLang.zhTW.label') },
  { value: 'zh-HK', label: t('settings.voiceLang.zhHK.label') },
])

// UI 显示语言。本阶段的下放开关在 `web/src/i18n/index.ts` 的 `ENABLED_LOCALES`
// 集合(模型不自动写;ja/ko 走完人校 + `__humanReviewed__: true` 才进集合)。
// 此处全表声明,渲染时再按 `isLocaleEnabled` 过滤,避免模型/人类各自维护一份
// 注释掉的 ja/ko,容易漂移。
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

const props = defineProps<{
  open: boolean
  settings: SystemSettings | null
}>()

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
  defaultMode: 'default',
  consensus: { enabled: false },
  voiceLang: 'zh-CN',
  uiLang: 'en',
  showToolSessions: false,
  devSkill: '',
  maxRoundsPerStage: DEFAULT_ROUNDS_PER_STAGE,
  maxSpeechChars: DEFAULT_SPEECH_CHARS,
})

// Re-seed the draft whenever the panel opens or fresh server settings arrive.
// Deep-copy so edits to the draft don't mutate the rendered server state.
watch(
  () => [props.open, props.settings] as const,
  ([open, settings]) => {
    if (!open || !settings) return
    draft.value = {
      agents: settings.agents.map((a) => ({ ...a })),
      defaultAgentId: settings.defaultAgentId,
      defaultMode: settings.defaultMode ?? 'default',
      consensus: { enabled: settings.consensus?.enabled ?? false },
      voiceLang: settings.voiceLang ?? 'zh-CN',
      uiLang: settings.uiLang ?? 'en',
      showToolSessions: settings.showToolSessions ?? false,
      devSkill: settings.devSkill ?? '',
      maxRoundsPerStage: settings.maxRoundsPerStage ?? DEFAULT_ROUNDS_PER_STAGE,
      maxSpeechChars: settings.maxSpeechChars ?? DEFAULT_SPEECH_CHARS,
    }
  },
  { immediate: true },
)

function addAgent() {
  // Locally-unique id so the default-agent radio can target it before save; the
  // server keeps it as-is (only id-less agents get a fresh uuid on normalize).
  const id = `new-${Date.now()}-${draft.value.agents.length}`
  draft.value.agents.push({
    id,
    name: '',
    baseUrl: '',
    apiKey: '',
    model: '',
    icon: '',
    enabled: true,
  })
}

// An agent counts as enabled unless explicitly disabled (back-compat with
// configs/drafts that predate the field).
function isEnabled(a: AgentConfig): boolean {
  return a.enabled !== false
}

function removeAgent(id: string) {
  if (id === SYSTEM_AGENT_ID) return
  draft.value.agents = draft.value.agents.filter((a) => a.id !== id)
  if (draft.value.defaultAgentId === id) draft.value.defaultAgentId = SYSTEM_AGENT_ID
}

function isSystemAgent(a: AgentConfig): boolean {
  return a.id === SYSTEM_AGENT_ID
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
        <div class="agent-table">
          <div class="agent-row agent-row-head">
            <span class="col-on">{{ t('settings.agents.col.on.label') }}</span>
            <span class="col-default">{{ t('settings.agents.col.default.label') }}</span>
            <span class="col-icon">{{ t('settings.agents.col.icon.label') }}</span>
            <span class="col-name">{{ t('settings.agents.col.name.label') }}</span>
            <span class="col-url">{{ t('settings.agents.col.baseUrl.label') }}</span>
            <span class="col-key">{{ t('settings.agents.col.apiKey.label') }}</span>
            <span class="col-model">{{ t('settings.agents.col.model.label') }}</span>
            <span class="col-actions"></span>
          </div>
          <div v-for="a in draft.agents" :key="a.id" class="agent-row">
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
            <input
              v-model="a.icon"
              class="agent-field col-icon"
              :placeholder="t('settings.agents.icon.placeholder')"
              maxlength="16"
            />
            <input
              v-model="a.name"
              class="agent-field col-name"
              :placeholder="
                isSystemAgent(a)
                  ? t('settings.agents.systemName.placeholder')
                  : t('settings.agents.name.placeholder')
              "
              :disabled="isSystemAgent(a)"
            />
            <input
              v-model="a.baseUrl"
              class="agent-field col-url"
              :placeholder="isSystemAgent(a) ? '—' : t('settings.agents.baseUrl.placeholder')"
              :disabled="isSystemAgent(a)"
            />
            <input
              v-model="a.apiKey"
              class="agent-field col-key"
              type="password"
              autocomplete="off"
              :placeholder="isSystemAgent(a) ? '—' : t('settings.agents.apiKey.placeholder')"
              :disabled="isSystemAgent(a)"
            />
            <input
              v-model="a.model"
              class="agent-field col-model"
              :placeholder="isSystemAgent(a) ? '—' : t('settings.agents.model.placeholder')"
              :disabled="isSystemAgent(a)"
            />
            <span class="col-actions">
              <button
                v-if="!isSystemAgent(a)"
                class="icon-btn"
                :title="t('settings.agents.remove.tooltip')"
                @click="removeAgent(a.id)"
              >
                🗑
              </button>
              <span v-else class="agent-badge">{{ t('settings.agents.builtin.label') }}</span>
            </span>
          </div>
        </div>
        <button class="agent-add" data-testid="settings-add-agent" @click="addAgent">
          {{ t('settings.agents.add.label') }}
        </button>
      </section>

      <section class="settings-section">
        <p class="settings-section-title">{{ t('settings.defaultMode.title.label') }}</p>
        <p class="settings-hint">{{ t('settings.defaultMode.hint') }}</p>
        <select v-model="draft.defaultMode" class="mode-select">
          <option v-for="m in MODES" :key="m" :value="m">{{ modeLabel(m) }}</option>
        </select>
      </section>

      <section class="settings-section">
        <p class="settings-section-title">{{ t('settings.devSkill.title.label') }}</p>
        <p class="settings-hint">{{ t('settings.devSkill.hint') }}</p>
        <input
          v-model="draft.devSkill"
          class="agent-field dev-skill-input"
          :placeholder="t('settings.devSkill.placeholder')"
        />
      </section>

      <section class="settings-section">
        <p class="settings-section-title">{{ t('settings.rounds.title.label') }}</p>
        <p class="settings-hint">
          {{ t('settings.rounds.hint', { min: MIN_ROUNDS_PER_STAGE }) }}
        </p>
        <input
          v-model.number="draft.maxRoundsPerStage"
          class="agent-field rounds-input"
          type="number"
          :min="MIN_ROUNDS_PER_STAGE"
          step="1"
        />
      </section>

      <section class="settings-section">
        <p class="settings-section-title">{{ t('settings.speechChars.title.label') }}</p>
        <p class="settings-hint">
          {{ t('settings.speechChars.hint', { min: MIN_SPEECH_CHARS }) }}
        </p>
        <input
          v-model.number="draft.maxSpeechChars"
          class="agent-field rounds-input"
          type="number"
          :min="MIN_SPEECH_CHARS"
          step="1"
        />
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
        <p class="settings-section-title">{{ t('settings.consensus.title.label') }}</p>
        <i18n-t keypath="settings.consensus.hint1.text" tag="p" class="settings-hint">
          <template #other
            ><em>{{ t('settings.consensus.hint1.other') }}</em></template
          >
        </i18n-t>
        <i18n-t keypath="settings.consensus.hint2.text" tag="p" class="settings-hint">
          <template #ask
            ><strong>{{ t('settings.consensus.hint2.ask') }}</strong></template
          >
          <template #you
            ><em>{{ t('settings.consensus.hint2.you') }}</em></template
          >
          <template #on
            ><em>{{ t('settings.consensus.hint2.on') }}</em></template
          >
        </i18n-t>
        <label v-if="draft.consensus" class="consensus-toggle">
          <input v-model="draft.consensus.enabled" type="checkbox" />
          {{ t('settings.consensus.toggle.label') }}
        </label>
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
