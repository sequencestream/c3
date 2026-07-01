import { createI18n } from 'vue-i18n'
import { useI18n } from 'vue-i18n'
import { DATE_FORMATS, NUMBER_FORMATS } from '../lib/datetime-formats'
import en from '../locales/en.json'
import zh from '../locales/zh.json'
import ja from '../locales/ja.json'
import ko from '../locales/ko.json'
import ru from '../locales/ru.json'

/**
 * en.json 是文案基准:类型 schema 即由它推导。
 * 拼错的 key 会在 vue-tsc 阶段报类型错误,从而阻断构建。
 */
export type MessageSchema = typeof en

declare module 'vue-i18n' {
  // 让模板里的 $t / 原生 t 获得 key 自动补全(基于 en.json 结构)。
  // 空 en.json 时 MessageSchema 为 {},此处接口为空属预期,禁用空对象类型告警。
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  export interface DefineLocaleMessage extends MessageSchema {}
}

/**
 * 把消息 schema 递归展开成「点分叶子路径」的有限并集。
 *
 * 注意:vue-i18n 原生 t 的签名是 `<Key extends string>(key: Key | ResourceKeys)`,
 * Key 会从入参推断为字面量,故原生 t 永远接受任意字符串、不会对拼错报错(仅补全)。
 * 这里用 LocaleKey 约束 key 形参为有限并集,才能让拼错在 vue-tsc 阶段编译失败。
 *
 * 空 en.json 时 LocaleKey = never,t(key: never) 对任何字面量调用都报错 —— 但本阶段
 * 不抽取文案、不调用 t,故「空 en.json 可编译通过」依然成立;后续随 en.json 填充解锁。
 */
type LocaleLeafKeys<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? `${Prefix}${K}`
    : T[K] extends Record<string, unknown>
      ? LocaleLeafKeys<T[K], `${Prefix}${K}.`>
      : `${Prefix}${K}`
}[keyof T & string]

export type LocaleKey = LocaleLeafKeys<MessageSchema>

// UI 显示语言全集,与 shared 的 `UiLang` 对齐(同一并集)。仅 en 有译文,其余
// 暂走 fallback('en');随母需求补 zh.json 等后解锁。
export const SUPPORTED_LOCALES = ['en', 'zh', 'ja', 'ko', 'ru'] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]

/**
 * Locale-file metadata key. A double-underscore-bracketed top-level key that
 * holds per-file metadata (e.g. `__humanReviewed__: true`) instead of a
 * translation. Stripped before being passed to vue-i18n and skipped by
 * `scripts/i18n/check.mjs`'s `flatten()` so it doesn't pollute the keyspace.
 *
 * Convention: model never writes this field; humans edit the locale JSON
 * directly to flip `__humanReviewed__` after proofreading.
 */
const META_KEY_RE = /^__[A-Za-z][A-Za-z0-9_]*__$/

/** Strip top-level `__*__` metadata keys so vue-i18n only sees translations.
 *  Returns the same MessageSchema type the input had — the meta key is structurally
 *  optional and never read by vue-i18n, so casting to MessageSchema is sound. */
function stripLocaleMeta(obj: unknown): MessageSchema {
  const out: Record<string, unknown> = {}
  if (!obj || typeof obj !== 'object') return out as MessageSchema
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (META_KEY_RE.test(k)) continue
    out[k] = v
  }
  return out as MessageSchema
}

/** 默认/兜底语言。 */
const DEFAULT_LOCALE: Locale = 'en'

/**
 * 每 locale 复用同一份命名预设(`d()` / `n()` 的 key)。Intl 按 locale 本地化排布,
 * 故选项无需逐语言定制;预设单一数据源在 `lib/datetime-formats.ts`。
 */
const datetimeFormats = Object.fromEntries(
  SUPPORTED_LOCALES.map((l) => [l, DATE_FORMATS]),
) as Record<Locale, typeof DATE_FORMATS>
const numberFormats = Object.fromEntries(
  SUPPORTED_LOCALES.map((l) => [l, NUMBER_FORMATS]),
) as Record<Locale, typeof NUMBER_FORMATS>

/**
 * 俄语基数复数规则(CLDR cardinal),映射到 3 分支消息 `one | few | many`:
 *   - one : 末位 1 且非 11(1, 21, 31…)
 *   - few : 末位 2–4 且非 12–14(2–4, 22–24…)
 *   - many: 其余(0, 5–20, 11–14…)
 * vue-i18n 默认规则按「n===1 ? 0 : 1」二分,对俄语错误,故需此自定义规则。
 * zh/ja/ko 为单形式消息(无 `|`),无需自定义规则。
 */
function russianPluralIndex(choice: number, choicesLength: number): number {
  const n = Math.abs(choice)
  const mod10 = n % 10
  const mod100 = n % 100
  let idx: number
  if (mod10 === 1 && mod100 !== 11) idx = 0
  else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) idx = 1
  else idx = 2
  return Math.min(idx, choicesLength - 1)
}

/** localStorage 里持久化用户显式选择的 UI 语言的 key。 */
const LOCALE_KEY = 'c3.uiLang'

function isSupported(v: unknown): v is Locale {
  return typeof v === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(v)
}

/**
 * Always-on baseline: the reviewed M1 default languages. These are exposed
 * unconditionally rather than `__humanReviewed__`-gated — they are the proofread
 * defaults, and flag-gating them would risk locking out the base language on a
 * missing flag. (Accepted minor asymmetry vs. all other locales.)
 */
const BASELINE_LOCALES: readonly Locale[] = ['en', 'zh']

/**
 * Raw imported locale objects, keyed by locale. Read BEFORE `stripLocaleMeta`,
 * so the top-level `__humanReviewed__` metadata is still present here (it is the
 * derivation input). `stripLocaleMeta` removes it only from what vue-i18n sees.
 */
const RAW_LOCALES: Record<Locale, unknown> = { en, zh, ja, ko, ru }

/** True iff a raw locale object carries top-level `__humanReviewed__ === true`.
 *  Typed `unknown` because `MessageSchema` (= `typeof en`) does not model the
 *  meta key, so the flag is read defensively off an untyped object. */
function isHumanReviewed(raw: unknown): boolean {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as Record<string, unknown>).__humanReviewed__ === true
  )
}

/**
 * Derive the set of locales exposed in the UI language dropdown from each
 * locale's `__humanReviewed__` flag. A locale is enabled iff it is in
 * {@link BASELINE_LOCALES} (en / zh) OR its raw object has `__humanReviewed__
 * === true`.
 *
 * The model NEVER writes `__humanReviewed__`; a human flips it in the locale
 * JSON after proofreading. This keeps the gate honest: a translation can be
 * drafted and CI-validated (presence, placeholder integrity, coverage) without
 * leaking into the UI until a reviewer signs off.
 *
 * Exported (with an injectable `rawLocales`) so the derivation is unit-testable
 * against synthetic locale objects independent of the shipped JSON.
 */
export function deriveEnabledLocales(
  rawLocales: Record<Locale, unknown> = RAW_LOCALES,
): ReadonlySet<Locale> {
  return new Set<Locale>(
    SUPPORTED_LOCALES.filter((l) => BASELINE_LOCALES.includes(l) || isHumanReviewed(rawLocales[l])),
  )
}

/** Locales exposed in the UI language dropdown (see {@link deriveEnabledLocales}). */
export const ENABLED_LOCALES: ReadonlySet<Locale> = deriveEnabledLocales()

/** True if `locale` should appear in the UI language dropdown. */
export function isLocaleEnabled(locale: Locale): boolean {
  return ENABLED_LOCALES.has(locale)
}

/** 读取持久化的 UI 语言;不存在/不合法/不可用时返回 null。 */
export function readStoredLocale(): Locale | null {
  try {
    const v = localStorage.getItem(LOCALE_KEY)
    return isSupported(v) ? v : null
  } catch {
    return null
  }
}

/** 持久化用户显式选择的 UI 语言(localStorage 不可用时静默忽略)。 */
export function setStoredLocale(locale: Locale): void {
  try {
    localStorage.setItem(LOCALE_KEY, locale)
  } catch {
    /* localStorage unavailable — non-fatal */
  }
}

/**
 * 首屏初值解析(在 createI18n 之前同步执行,零 FOUC):
 *   1. localStorage(用户显式设置,主)
 *   2. navigator.language 前缀匹配(仅首次探测一次,不写回 localStorage —— 浏览器
 *      偏好不算「显式设置」)
 *   3. en(兜底)
 */
function resolveInitialLocale(): Locale {
  const stored = readStoredLocale()
  if (stored) return stored
  try {
    const prefix = navigator.language?.split('-')[0]?.toLowerCase()
    if (isSupported(prefix)) return prefix
  } catch {
    /* navigator unavailable — fall through to default */
  }
  return DEFAULT_LOCALE
}

// 第三泛型 `false` = composition 模式(与运行时 `legacy: false` 对齐),这样
// `i18n.global` 是 Composer、`locale` 是可写 ref(`.value` 可读写);否则类型默认
// 按 legacy 推断,`locale` 会被当成普通字符串而非 ref。
export const i18n = createI18n<[MessageSchema], Locale, false>({
  legacy: false,
  locale: resolveInitialLocale(),
  fallbackLocale: 'en',
  // 缺 key / 走 fallback 时显式 console warning,不静默
  missingWarn: true,
  fallbackWarn: true,
  // en/zh(M1)+ ja/ko(M2)+ ru(M3)均为真译文,330 key 全量覆盖。
  //
  // 注意:「真译文已加载」与「是否出现在 UI 下拉」是两件事 —— 后者由
  // `ENABLED_LOCALES`(由各 locale 的 `__humanReviewed__` 派生)控制,人校通过前不进下拉。
  // ja/ko/ru 译文虽已加载,但其 JSON 未带 `__humanReviewed__`,故未进 `ENABLED_LOCALES`,下拉暂只放 en/zh。
  //
  // `stripLocaleMeta` 删掉 `__*__` 顶层元数据,避免 vue-i18n 把它当 key 看待。
  // (vue-i18n 实际只遍历 string 值,boolean 不会崩;但删掉更干净,也让
  // `missingWarn` 不为这个 key 报警。)
  messages: {
    en: stripLocaleMeta(en),
    zh: stripLocaleMeta(zh),
    ja: stripLocaleMeta(ja),
    ko: stripLocaleMeta(ko),
    ru: stripLocaleMeta(ru),
  },
  // 日期/数字本地化:命名预设经 Intl(DateTimeFormat / NumberFormat)按 locale 渲染。
  datetimeFormats,
  numberFormats,
  // 俄语复数 3 分支(one/few/many);其余语言走 vue-i18n 默认(en 二分、CJK 单形式)。
  pluralRules: { ru: russianPluralIndex },
})

/**
 * 切换运行时语言的唯一出口:改 vue-i18n locale + 同步 <html lang>。
 * 不写 localStorage、不发 WS —— 那些副作用由调用方(App.setLocale / settings
 * reconcile)按各自语义决定,保持本函数纯粹。
 */
export function applyLocale(locale: Locale): void {
  i18n.global.locale.value = locale
  try {
    document.documentElement.lang = locale
  } catch {
    /* no document (SSR/test) — non-fatal */
  }
}

// 首屏:解析出的初值已喂给 createI18n,这里再同步一次 <html lang>(createI18n 不碰 DOM)。
applyLocale(i18n.global.locale.value as Locale)

/** 类型安全的全局 t(组件外使用,如 composables / lib)。key 拼错编译失败。 */
export function t(key: LocaleKey, named?: Record<string, unknown>): string {
  return named === undefined
    ? i18n.global.t(key)
    : i18n.global.t(key, named as Record<string, never>)
}

/**
 * 组件内使用的类型安全 i18n。返回的 t 把 key 约束为 LocaleKey,拼错编译失败;
 * 其余能力(locale、d、n 等)透传 vue-i18n 原生 composer。
 */
export function useTypedI18n() {
  const composer = useI18n()
  function typedT(key: LocaleKey): string
  function typedT(key: LocaleKey, plural: number): string
  function typedT(key: LocaleKey, named: Record<string, unknown>): string
  function typedT(key: LocaleKey, arg?: number | Record<string, unknown>): string {
    return composer.t(key as string, arg as never)
  }
  return { ...composer, t: typedT }
}

export default i18n
