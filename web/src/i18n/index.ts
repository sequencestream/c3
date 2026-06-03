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

export const SUPPORTED_LOCALES = ['en'] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]

export const i18n = createI18n<[MessageSchema], Locale>({
  legacy: false,
  locale: 'en',
  fallbackLocale: 'en',
  // 缺 key / 走 fallback 时显式 console warning,不静默
  missingWarn: true,
  fallbackWarn: true,
  messages: {
    en,
  },
})

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
