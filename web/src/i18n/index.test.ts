/*
 * index.test.ts — `__humanReviewed__`-derived `ENABLED_LOCALES` 单测。
 *
 * 验证下拉下放闸:en/zh 为无条件基线;其余语种当且仅当原始 locale 对象顶层
 * `__humanReviewed__ === true` 才进集合。导入 index.ts 会触发 createI18n 的
 * DOM/navigator 副作用,均被 index.ts 内 try/catch 兜住,Node/vitest 下安全。
 */
import { describe, it, expect } from 'vitest'
import { ENABLED_LOCALES, isLocaleEnabled, deriveEnabledLocales } from './index'

// 合成基线对象:派生只看 __humanReviewed__,基线语种内容无关,空对象即可。
const en = {}
const zh = {}

describe('deriveEnabledLocales — __humanReviewed__ 派生', () => {
  it('flag === true 的非基线语种进集合', () => {
    const set = deriveEnabledLocales({
      en,
      zh,
      ja: { __humanReviewed__: true },
      ko: {},
      ru: { __humanReviewed__: false },
    })
    expect(set.has('ja')).toBe(true)
  })

  it('flag 缺失或为 false/非 true 的语种不进集合', () => {
    const set = deriveEnabledLocales({
      en,
      zh,
      ja: {},
      ko: { __humanReviewed__: false },
      ru: { __humanReviewed__: 'yes' }, // 非严格 true 不算
    })
    expect(set.has('ja')).toBe(false)
    expect(set.has('ko')).toBe(false)
    expect(set.has('ru')).toBe(false)
  })

  it('en/zh 恒进集合(无条件基线),即便缺 flag', () => {
    const set = deriveEnabledLocales({ en: {}, zh: {}, ja: {}, ko: {}, ru: {} })
    expect(set.has('en')).toBe(true)
    expect(set.has('zh')).toBe(true)
  })
})

describe('ENABLED_LOCALES — 当前 shipped locale JSON 派生结果', () => {
  it('下拉只暴露 en/zh(ja/ko/ru 未带 __humanReviewed__)', () => {
    expect([...ENABLED_LOCALES].sort()).toEqual(['en', 'zh'])
  })

  it('isLocaleEnabled 与 ENABLED_LOCALES 一致', () => {
    expect(isLocaleEnabled('en')).toBe(true)
    expect(isLocaleEnabled('zh')).toBe(true)
    expect(isLocaleEnabled('ja')).toBe(false)
    expect(isLocaleEnabled('ko')).toBe(false)
    expect(isLocaleEnabled('ru')).toBe(false)
  })
})
