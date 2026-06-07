/*
 * format.test.ts — 日期 / 数字 / 复数本地化的集成单测。
 *
 * 直接用配置好的 i18n 实例(datetimeFormats / numberFormats / pluralRules)验证
 * `d()` / `n()` / `t(key, count)` 在五语下的渲染。Node 环境无 DOM,createI18n 的
 * DOM/navigator 副作用已被 index.ts 内 try/catch 兜住。
 */
import { describe, it, expect } from 'vitest'
import { i18n } from './index'

const g = i18n.global

describe('日期本地化 d()', () => {
  // 2026-05-31 14:30:05(本地时区)
  const ms = new Date(2026, 4, 31, 14, 30, 5).getTime()

  it('short 预设:en 输出月/日两位 MM/DD', () => {
    expect(g.d(ms, 'short', 'en')).toBe('05/31')
  })

  it('full 预设随 locale 排布不同(en 月在前、ja 年在前)', () => {
    const en = g.d(ms, 'full', 'en')
    const ja = g.d(ms, 'full', 'ja')
    expect(en).not.toBe(ja)
    expect(ja.indexOf('2026')).toBeLessThan(ja.indexOf('31'))
  })

  it('datetime 预设含秒', () => {
    expect(g.d(ms, 'datetime', 'en')).toMatch(/05/)
    expect(g.d(ms, 'datetime', 'en')).toMatch(/14/)
  })
})

describe('数字本地化 n()', () => {
  it('integer 千分位分组随 locale(en 用逗号、ru 用空格)', () => {
    const en = g.n(1234567, 'integer', 'en')
    const ru = g.n(1234567, 'integer', 'ru')
    expect(en).toContain(',')
    expect(ru).not.toContain(',')
    expect(en).not.toBe(ru)
  })

  it('decimal 保留至多两位小数', () => {
    expect(g.n(3.14159, 'decimal', 'en')).toBe('3.14')
  })
})

describe('复数(管道 | + 俄语自定义规则)', () => {
  const k = 'intent.automation.completedCount'
  // typed Composer.t 的重载对「宽 string key + (plural, options)」解析不友好,测试里
  // 直接按 (key, plural, { locale }) 形态调用,绕过严格泛型。
  const tc = g.t as unknown as (key: string, plural: number, opts: { locale: string }) => string
  const t = (count: number, locale: string) => tc(k, count, { locale })

  it('en:单/复二分', () => {
    expect(t(1, 'en')).toContain('one item')
    expect(t(3, 'en')).toContain('3 items')
  })

  it('zh:单形式不随数量切支,数字正确插值', () => {
    expect(t(1, 'zh')).toContain('1')
    expect(t(5, 'zh')).toContain('5')
  })

  it('ru:one / few / many 按 CLDR 选支', () => {
    expect(t(1, 'ru')).toMatch(/1 элемент(?![аов])/) // one
    expect(t(2, 'ru')).toMatch(/2 элемента/) // few
    expect(t(5, 'ru')).toMatch(/5 элементов/) // many
    expect(t(11, 'ru')).toMatch(/11 элементов/) // many(teen 例外)
    expect(t(21, 'ru')).toMatch(/21 элемент(?![аов])/) // one(末位 1 非 11)
    expect(t(22, 'ru')).toMatch(/22 элемента/) // few
  })
})
