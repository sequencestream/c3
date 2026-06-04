import { createI18n } from 'vue-i18n'
import { useI18n } from 'vue-i18n'
import en from '../locales/en.json'

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

/** 默认/兜底语言。 */
const DEFAULT_LOCALE: Locale = 'en'

/** localStorage 里持久化用户显式选择的 UI 语言的 key。 */
const LOCALE_KEY = 'c3.uiLang'

function isSupported(v: unknown): v is Locale {
  return typeof v === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(v)
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
  // 仅 en 有真译文;zh/ja/ko/ru 本阶段先指向 en 占位(切过去即显示英文,等同
  // fallback,但满足 createI18n 对每个 locale 都要有 messages 的类型约束)。母需求
  // 补出各语言文件后,把对应项替换为真正的译文导入即可。
  messages: {
    en,
    zh: en,
    ja: en,
    ko: en,
    ru: en,
  },
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
