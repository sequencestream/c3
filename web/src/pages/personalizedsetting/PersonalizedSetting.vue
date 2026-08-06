<script setup lang="ts">
/*
 * PersonalizedSetting.vue — 个人化设置页(全屏面板),与系统设置、工作区设置三者并列。
 *
 * 承载「因人而异」的偏好项,不经管理员门禁:普通账户同样可打开并修改自己的设置,故本页
 * 不读 isAdmin、无只读提示、无 Save 按钮。每项都是即时生效 + 即时持久化(选中即应用语言
 * 并按当前身份保存),因此没有草稿/脏状态机,不复用 useTabbedDraftSave。
 *
 * 存储位置由身份决定,页面本身不关心:已登录账户存服务端账户记录,无身份时存本浏览器。
 * 桌面与移动端共用同一版面(单列卡片),入口见 AppHeader。
 */
import { computed } from 'vue'
import type { PersonalizedSettings, UiLang, UiTheme } from '@ccc/shared/protocol'
import { useTypedI18n, isLocaleEnabled, type Locale } from '@/i18n'
import { UI_LANGS as ALL_UI_LANGS } from '@/lib/personalized-settings'
import { DEFAULT_THEME, THEMES } from '@/lib/theme'
import { DEFAULT_FONT_SCALE, FONT_SCALE_MAX, FONT_SCALE_MIN } from '@/lib/font-scale'

const { t } = useTypedI18n()

const props = defineProps<{
  open: boolean
  settings: PersonalizedSettings
}>()

const emit = defineEmits<{
  close: []
  // 即时生效的显示语言切换(选中即抛,无 Save)。
  'set-ui-lang': [lang: UiLang]
  // 即时生效的显示样式切换(同上)。
  'set-theme': [theme: UiTheme]
  // 即时生效的字体大小调整(拖动即抛,无 Save)。
  'set-font-scale': [scale: number]
}>()

// 可选显示语言。下放开关 = `web/src/i18n/index.ts` 的 `ENABLED_LOCALES`,由各 locale
// 的 `__humanReviewed__` 派生(en/zh 无条件基线;其余语种须人在 JSON 翻
// `__humanReviewed__: true` 后才进集合,模型不写此字段)。此处按全表过滤,避免模型/人类
// 各自维护一份注释掉的 ja/ko,容易漂移。
//
// 标签是「语言原生名」——BCP-47 惯例,语言名 = 语言本身的标识符。把 "日本語" 翻成
// "Japanese" 等于把下拉项变成翻译,违背语言切换的语义。豁免于 web/CLAUDE.md 的
// no-raw-text 规则,作用域仅限此 UI_LANG_LABELS 注册表。
const UI_LANG_LABELS: Record<Locale, string> = {
  en: 'English',
  zh: '简体中文',
  ja: '日本語',
  ko: '한국어',
  ru: 'Русский',
}
const UI_LANGS = computed<{ value: UiLang; label: string }[]>(() =>
  ALL_UI_LANGS.filter((l): l is Locale => isLocaleEnabled(l)).map((l) => ({
    value: l,
    label: UI_LANG_LABELS[l],
  })),
)

// 缺省 en:与「无账户记录、无本地记录」时的内置默认一致,故下拉永远有选中项。
const uiLang = computed<UiLang>(() => props.settings.uiLang ?? 'en')

function onUiLangChange(e: Event): void {
  emit('set-ui-lang', (e.target as HTMLSelectElement).value as UiLang)
}

// 显示样式选项直接由主题注册表(`lib/theme.ts`)生成,本页不另存一份主题清单:注册表新增
// 一项(配套一组 CSS 变量)即自动出现在下拉里。标签走 i18n —— 主题名是普通 UI 文案,不像
// 语言名那样必须用母语写。
const THEME_OPTIONS = computed<{ value: UiTheme; label: string }[]>(() =>
  THEMES.map((theme) => ({ value: theme.id, label: t(theme.labelKey) })),
)

// 缺省 dark:与「无账户记录、无本地记录」时的内置默认一致,故下拉永远有选中项。
const theme = computed<UiTheme>(() => props.settings.theme ?? DEFAULT_THEME)

function onThemeChange(e: Event): void {
  emit('set-theme', (e.target as HTMLSelectElement).value as UiTheme)
}

// 缺省 100:与「无账户记录、无本地记录」时的内置默认一致,故拖动条永远有取值。
const fontScale = computed<number>(() => props.settings.fontScale ?? DEFAULT_FONT_SCALE)

function onFontScaleChange(e: Event): void {
  emit('set-font-scale', Number((e.target as HTMLInputElement).value))
}
</script>

<template>
  <div v-if="open" class="settings-page" data-testid="personalized-setting-page">
    <div class="settings-head">
      <h2>{{ t('personalizedSetting.title.label') }}</h2>
      <button class="icon-btn" :title="t('common.action.close.tooltip')" @click="emit('close')">
        ✕
      </button>
    </div>

    <div class="settings-body">
      <section class="settings-section">
        <p class="settings-section-title">{{ t('personalizedSetting.displayLang.title.label') }}</p>
        <p class="settings-hint">{{ t('personalizedSetting.displayLang.hint') }}</p>
        <select
          :value="uiLang"
          class="lang-select mode-select"
          data-testid="personalized-ui-lang"
          @change="onUiLangChange"
        >
          <option v-for="l in UI_LANGS" :key="l.value" :value="l.value">{{ l.label }}</option>
        </select>
      </section>

      <section class="settings-section">
        <p class="settings-section-title">{{ t('personalizedSetting.theme.title.label') }}</p>
        <p class="settings-hint">{{ t('personalizedSetting.theme.hint') }}</p>
        <select
          :value="theme"
          class="lang-select mode-select"
          data-testid="personalized-theme"
          @change="onThemeChange"
        >
          <option v-for="opt in THEME_OPTIONS" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </option>
        </select>
      </section>

      <section class="settings-section">
        <p class="settings-section-title">{{ t('personalizedSetting.fontScale.title.label') }}</p>
        <p class="settings-hint">{{ t('personalizedSetting.fontScale.hint') }}</p>
        <div class="font-scale-row">
          <input
            type="range"
            :min="FONT_SCALE_MIN"
            :max="FONT_SCALE_MAX"
            step="1"
            :value="fontScale"
            class="font-scale-slider"
            data-testid="personalized-font-scale"
            @input="onFontScaleChange"
          />
          <span class="font-scale-value" data-testid="personalized-font-scale-value">
            {{ t('personalizedSetting.fontScale.percentage', { value: fontScale }) }}
          </span>
        </div>
      </section>
    </div>

    <div class="settings-foot">
      <button class="ghost" data-testid="personalized-setting-close" @click="emit('close')">
        {{ t('common.action.close.label') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.font-scale-row {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
}
.font-scale-slider {
  flex: 1;
  min-width: 0;
  accent-color: var(--c-primary);
}
.font-scale-value {
  flex: none;
  min-width: 3.5em;
  font-size: var(--fs-body);
  font-variant-numeric: tabular-nums;
  color: var(--c-text);
}
</style>
