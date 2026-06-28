import { createI18n, useI18n } from 'vue-i18n'
import zh from '../locales/zh.json'
import en from '../locales/en.json'

// 精简版前端 i18n，复刻主 web 的约定:vue-i18n + 按 locale 的 JSON 资源 +
// 编译期类型化 key。仅 zh/en 两语言,不引入主 web 的冻结清单/质量门/服务端错误码。

// zh 是文案基准:类型 schema 由它推导,拼错的 key 在 vue-tsc 阶段报错从而阻断构建。
export type MessageSchema = typeof zh

declare module 'vue-i18n' {
  // 让模板里的 $t / 原生 t 基于 zh.json 结构获得 key 自动补全。
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  export interface DefineLocaleMessage extends MessageSchema {}
}

// 把消息 schema 递归展开成「点分叶子路径」的有限并集,使拼错 key 在 vue-tsc 阶段失败。
// (vue-i18n 原生 t 会把入参推断为字面量,永远接受任意字符串,故需此约束。)
type LocaleLeafKeys<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? `${Prefix}${K}`
    : T[K] extends Record<string, unknown>
      ? LocaleLeafKeys<T[K], `${Prefix}${K}.`>
      : `${Prefix}${K}`
}[keyof T & string]

export type LocaleKey = LocaleLeafKeys<MessageSchema>

export const SUPPORTED_LOCALES = ['zh', 'en'] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]

// 默认/兜底语言:主受众为中文。
const DEFAULT_LOCALE: Locale = 'zh'

// localStorage 里持久化用户显式选择的 UI 语言的 key。
const LOCALE_KEY = 'c3ls.uiLang'

export function isSupported(v: unknown): v is Locale {
  return typeof v === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(v)
}

// 读取持久化的 UI 语言;不存在/不合法时返回 null。
export function readStoredLocale(): Locale | null {
  try {
    const v = localStorage.getItem(LOCALE_KEY)
    return isSupported(v) ? v : null
  } catch {
    return null
  }
}

// 持久化用户显式选择的 UI 语言(localStorage 不可用时静默忽略)。
export function setStoredLocale(locale: Locale): void {
  try {
    localStorage.setItem(LOCALE_KEY, locale)
  } catch {
    /* localStorage unavailable — non-fatal */
  }
}

// 首屏初值解析:localStorage(显式设置)→ navigator.language(zh* → zh,其余 → en)→ zh。
// 不把 navigator 探测写回 localStorage —— 浏览器偏好不算「显式设置」。
export function resolveInitialLocale(): Locale {
  const stored = readStoredLocale()
  if (stored) return stored
  try {
    const lang = navigator.language?.toLowerCase() ?? ''
    if (lang.startsWith('zh')) return 'zh'
    if (lang) return 'en'
  } catch {
    /* navigator unavailable — fall through to default */
  }
  return DEFAULT_LOCALE
}

// 第三泛型 false = composition 模式(与运行时 legacy: false 对齐):i18n.global 是
// Composer、locale 是可写 ref。
export const i18n = createI18n<[MessageSchema], Locale, false>({
  legacy: false,
  locale: resolveInitialLocale(),
  fallbackLocale: DEFAULT_LOCALE,
  missingWarn: true,
  fallbackWarn: true,
  messages: { zh, en },
})

// 切换运行时语言并同步 <html lang>;同时写 localStorage,使刷新后保持。
export function setLocale(locale: Locale): void {
  i18n.global.locale.value = locale
  setStoredLocale(locale)
  try {
    document.documentElement.lang = locale
  } catch {
    /* no document (SSR/test) — non-fatal */
  }
}

// 首屏:把解析出的初值同步给 <html lang>(createI18n 不碰 DOM)。
try {
  document.documentElement.lang = i18n.global.locale.value
} catch {
  /* no document — non-fatal */
}

// 类型安全的全局 t(组件外使用,如 lib)。key 拼错编译失败。
export function t(key: LocaleKey, named?: Record<string, unknown>): string {
  return named === undefined
    ? i18n.global.t(key)
    : i18n.global.t(key, named as Record<string, never>)
}

// 组件内使用的类型安全 i18n:t 把 key 约束为 LocaleKey(拼错编译失败),其余透传。
// 返回类型刻意交给推导(vue-i18n composer 的复合类型无法稳定手写注解,与主 web
// 的 useTypedI18n 同样处理)。组件内需要当前语言时读 `i18n.global.locale`(已被
// createI18n 泛型约束为 Locale),不要依赖 composer.locale 的默认字面量类型。
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function useTypedI18n() {
  // 全局作用域:本 SPA 不用 SFC `<i18n>` 自定义块,所有文案都在全局 messages 里,
  // 显式 useScope:'global' 既正确又消除 vue-i18n 的 "Not found parent scope" 警告。
  const composer = useI18n({ useScope: 'global' })
  function typedT(key: LocaleKey, named?: Record<string, unknown>): string {
    return named === undefined ? composer.t(key) : composer.t(key, named as Record<string, never>)
  }
  return { ...composer, t: typedT }
}

export default i18n
