import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  CONTRAST_BODY,
  CONTRAST_SECONDARY,
  contrastRatio,
  flatten,
  parseColor,
  readTokenBlock,
  relativeLuminance,
} from './contrast'

const css = readFileSync(resolve(__dirname, '../standard.css'), 'utf8')
const dark = readTokenBlock(css, ':root {')
const light = { ...dark, ...readTokenBlock(css, ":root[data-theme='light']") }

const WHITE = { r: 255, g: 255, b: 255 }
const BLACK = { r: 0, g: 0, b: 0 }

describe('WCAG maths', () => {
  it('spans the full 1:1 – 21:1 range', () => {
    expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 5)
    expect(contrastRatio(WHITE, WHITE)).toBeCloseTo(1, 5)
  })

  it('is symmetric — a pair has one ratio, not a foreground and a background one', () => {
    const a = parseColor('#5b5b66')
    const b = parseColor('#f1f1f5')
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10)
  })

  it('puts the reference greys on the right side of each threshold', () => {
    // #767676 is the canonical "just passes 4.5:1 on white" grey; #949494 is the
    // equivalent for 3:1. One shade lighter and each falls through its threshold.
    expect(contrastRatio(parseColor('#767676'), WHITE)).toBeGreaterThanOrEqual(CONTRAST_BODY)
    expect(contrastRatio(parseColor('#777777'), WHITE)).toBeLessThan(CONTRAST_BODY)
    expect(contrastRatio(parseColor('#949494'), WHITE)).toBeGreaterThanOrEqual(CONTRAST_SECONDARY)
    expect(contrastRatio(parseColor('#959595'), WHITE)).toBeLessThan(CONTRAST_SECONDARY)
  })

  it('applies the sRGB linearization instead of averaging channels', () => {
    // Pure green is far brighter than pure blue at the same channel value; a naive
    // mean would call them equal.
    expect(relativeLuminance({ r: 0, g: 255, b: 0 })).toBeCloseTo(0.7152, 4)
    expect(relativeLuminance({ r: 0, g: 0, b: 255 })).toBeCloseTo(0.0722, 4)
  })

  it('measures translucent colours after compositing, not by their own value', () => {
    // 50% black over white reads as mid grey, not as black.
    expect(flatten('rgba(0, 0, 0, 0.5)', WHITE)).toEqual({ r: 128, g: 128, b: 128 })
    expect(contrastRatio(flatten('rgba(0, 0, 0, 0.5)', WHITE), WHITE)).toBeLessThan(
      contrastRatio(BLACK, WHITE),
    )
  })

  it('parses the colour notations the tokens use, and rejects the rest', () => {
    expect(parseColor('#abc')).toEqual({ r: 170, g: 187, b: 204, a: 1 })
    expect(parseColor('#18181B')).toEqual({ r: 24, g: 24, b: 27, a: 1 })
    expect(parseColor('rgba(99, 102, 241, 0.12)')).toEqual({ r: 99, g: 102, b: 241, a: 0.12 })
    expect(() => parseColor('linear-gradient(135deg, #6366f1, #a855f7)')).toThrow()
  })
})

/**
 * The audited foreground/background pairs of the light theme.
 *
 * `on` names the surfaces a text token actually lands on in the UI, so a token is
 * verified against every backdrop it has to survive — not once against white.
 * `level` is the floor that text carries: `body` for anything conveying primary
 * information, `secondary` for large, decorative or genuinely auxiliary text.
 */
const SURFACES: Record<string, string> = {
  bg: '--c-bg', // 主内容区
  panel: '--c-panel', // 顶栏 / 状态栏 / 侧栏 / 下拉浮层
  card: '--c-card', // 悬浮卡片 / 对话框
  input: '--c-input', // 输入框 / 选择器
  code: '--c-code', // 代码块
  msgAi: '--c-msg-ai', // AI 对话气泡
  msgUser: '--c-msg-user', // 用户对话气泡
}

/**
 * Surfaces built by compositing a translucent overlay onto an opaque one. The
 * overlay is a token name where one exists and the literal from the component
 * stylesheet where the tint was written inline — status pills are the latter.
 */
const OVERLAYS: Record<string, [overlay: string, under: string]> = {
  hover: ['--c-hover-stronger', '--c-panel'], // 列表行悬停 / 次按钮
  primarySoft: ['--c-primary-soft', '--c-bg'], // 选中行 / 幽灵按钮悬停
  purpleSoft: ['--c-purple-soft', '--c-bg'], // AI 标签与徽章
  successSoft: ['rgba(34, 197, 94, 0.15)', '--c-bg'], // 完成 / 成功状态徽章
  successStrong: ['rgba(34, 197, 94, 0.35)', '--c-panel'], // 会话种类计数徽章
  warningSoft: ['rgba(245, 158, 11, 0.15)', '--c-bg'], // 进行中 / 暂停状态徽章
  errorSoft: ['rgba(239, 68, 68, 0.12)', '--c-bg'], // 失败 / 取消状态徽章
  infoSoft: ['rgba(59, 130, 246, 0.15)', '--c-bg'], // 运行中徽章 / vendor 标识
}

/** Token name → its light value; anything else is already a literal colour. */
function value(nameOrLiteral: string): string {
  return light[nameOrLiteral] ?? nameOrLiteral
}

function surface(name: string) {
  const overlay = OVERLAYS[name]
  if (overlay) {
    const [front, under] = overlay
    return flatten(value(front), flatten(value(under), WHITE))
  }
  const token = SURFACES[name]
  if (!token) throw new Error(`unknown surface: ${name}`)
  return flatten(value(token), WHITE)
}

const AUDIT: { token: string; level: 'body' | 'secondary'; on: string[] }[] = [
  // 基础层级
  { token: '--c-text', level: 'body', on: [...Object.keys(SURFACES), ...Object.keys(OVERLAYS)] },
  {
    token: '--c-text-muted',
    level: 'body',
    on: [...Object.keys(SURFACES), ...Object.keys(OVERLAYS)],
  },
  // 禁用文字与代码注释：辅助层级，另有透明度 / 控件状态作为区分线索
  {
    token: '--c-text-disabled',
    level: 'secondary',
    on: ['bg', 'panel', 'card', 'input', 'code', 'hover'],
  },
  // 有色文字
  { token: '--c-primary-text', level: 'body', on: ['bg', 'panel', 'card', 'primarySoft'] },
  { token: '--c-primary-2-text', level: 'body', on: ['bg', 'panel', 'card', 'code'] },
  {
    token: '--c-success-text',
    level: 'body',
    on: ['bg', 'panel', 'card', 'successSoft', 'successStrong'],
  },
  { token: '--c-warning-text', level: 'body', on: ['bg', 'panel', 'card', 'warningSoft'] },
  { token: '--c-error-text', level: 'body', on: ['bg', 'panel', 'card', 'errorSoft'] },
  { token: '--c-info', level: 'body', on: ['bg', 'panel', 'card', 'infoSoft'] },
  { token: '--c-purple-text', level: 'body', on: ['bg', 'card', 'purpleSoft'] },
]

describe('light theme text contrast', () => {
  for (const { token, level, on } of AUDIT) {
    const floor = level === 'body' ? CONTRAST_BODY : CONTRAST_SECONDARY
    for (const name of on) {
      it(`${token} on ${name} reaches ${floor}:1`, () => {
        const ratio = contrastRatio(flatten(light[token]!, WHITE), surface(name))
        expect(ratio, `${light[token]} on ${name}`).toBeGreaterThanOrEqual(floor)
      })
    }
  }

  it('keeps the three text levels visually ordered, not just compliant', () => {
    const onBg = (token: string) => contrastRatio(flatten(light[token]!, WHITE), surface('bg'))
    expect(onBg('--c-text')).toBeGreaterThan(onBg('--c-text-muted'))
    expect(onBg('--c-text-muted')).toBeGreaterThan(onBg('--c-text-disabled'))
  })

  it('carries white and dark ink on the coloured fills that host them', () => {
    // Destructive confirm and "approve spec" fill with the deeper variant precisely
    // so their white label clears the body floor; the manual-continue pill keeps the
    // bright warning fill and puts dark ink on it instead.
    for (const token of ['--c-error-text', '--c-success-text']) {
      const fill = flatten(light[token]!, WHITE)
      expect(contrastRatio(WHITE, fill), token).toBeGreaterThanOrEqual(CONTRAST_BODY)
    }
    const warningFill = flatten(light['--c-warning']!, WHITE)
    expect(contrastRatio(parseColor('#18181b'), warningFill)).toBeGreaterThanOrEqual(CONTRAST_BODY)
    expect(contrastRatio(WHITE, warningFill)).toBeLessThan(CONTRAST_SECONDARY)
  })

  it('rejects the greys and fills that used to stand in for light text colours', () => {
    // Samples that must stay failing: the previous disabled grey, and the status
    // base colours — bright enough to read on the dark canvas, far too light to be
    // text on a white one. This is what the `-text` variants exist for.
    const fails = ['#a1a1aa', dark['--c-success']!, dark['--c-warning']!, dark['--c-error']!]
    for (const value of fails) {
      expect(contrastRatio(parseColor(value), WHITE), value).toBeLessThan(CONTRAST_BODY)
    }
    expect(contrastRatio(parseColor('#a1a1aa'), WHITE)).toBeLessThan(CONTRAST_SECONDARY)
  })
})

describe('dark theme is untouched by the light-theme fix', () => {
  it('gives every -text variant the same value as its base colour', () => {
    expect(dark['--c-primary-text']).toBe(dark['--c-primary'])
    expect(dark['--c-primary-2-text']).toBe(dark['--c-primary-2'])
    expect(dark['--c-success-text']).toBe(dark['--c-success'])
    expect(dark['--c-warning-text']).toBe(dark['--c-warning'])
    expect(dark['--c-error-text']).toBe(dark['--c-error'])
  })

  it('leaves the dark palette on its original values', () => {
    expect(dark['--c-bg']).toBe('#18181b')
    expect(dark['--c-text']).toBe('#e4e4e7')
    expect(dark['--c-text-muted']).toBe('#a1a1aa')
    expect(dark['--c-text-disabled']).toBe('#6b6b75')
    expect(dark['--c-purple-text']).toBe('#c084fc')
  })

  it('still clears the text floors on the dark canvas', () => {
    const canvas = parseColor(dark['--c-bg']!)
    expect(contrastRatio(parseColor(dark['--c-text']!), canvas)).toBeGreaterThanOrEqual(
      CONTRAST_BODY,
    )
    expect(contrastRatio(parseColor(dark['--c-text-muted']!), canvas)).toBeGreaterThanOrEqual(
      CONTRAST_BODY,
    )
    expect(contrastRatio(parseColor(dark['--c-text-disabled']!), canvas)).toBeGreaterThanOrEqual(
      CONTRAST_SECONDARY,
    )
  })

  it('defines a light override for every text token the light theme has to change', () => {
    for (const token of [
      '--c-text',
      '--c-text-muted',
      '--c-text-disabled',
      '--c-primary-text',
      '--c-primary-2-text',
      '--c-success-text',
      '--c-warning-text',
      '--c-error-text',
      '--c-info',
      '--c-purple-text',
    ]) {
      expect(light[token], token).toBeDefined()
      expect(dark[token], token).toBeDefined()
    }
  })
})

/**
 * Every text colour in the app, as written. A `color:` declaration is only allowed
 * to name a `--c-*` token — a literal is theme-blind and shows up as the wrong grey
 * the moment the canvas flips — so the exceptions are enumerated here rather than
 * left to a reviewer's eye.
 */
const LITERAL_TEXT_COLORS: Record<string, string> = {
  // 白字压主色 / 危险色 / 渐变实底：两个主题下底色相同，白字是唯一正确的前景。
  '#fff': 'white ink on a coloured fill',
  // 深墨压警告色实底：警告色在两个主题下同为亮琥珀，前景必须固定为深墨。
  '#18181b': 'dark ink on the warning fill',
  // 工作台事件徽章：前景与浅色底一并写死，成对出现，浅色主题下对比度达标；
  // 暗色主题里它们仍是一块浅底贴片，属于另行跟踪的暗色缺陷，不在本次取值修复内。
  '#92400e': 'workcenter badge pair',
  '#065f46': 'workcenter badge pair',
  '#374151': 'workcenter badge pair',
  '#3730a3': 'workcenter badge pair',
  '#991b1b': 'workcenter badge pair',
  inherit: 'inherits the surrounding text colour',
}

/** Undefined vars whose fallback is a hardcoded light pair — same category as above. */
const LEGACY_BADGE_VARS = ['--c-danger-text', '--c-info-text', '--c-muted-text']

function styleSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) return styleSources(path)
    return /\.(css|vue)$/.test(entry.name) ? [path] : []
  })
}

describe('text colours go through tokens', () => {
  const root = resolve(__dirname, '..')
  const declarations = styleSources(root).flatMap((path) =>
    [...readFileSync(path, 'utf8').matchAll(/(?:^|[^-\w])color:\s*([^;]+);/gm)].map((match) => ({
      file: path.slice(root.length + 1),
      value: match[1]!.trim(),
    })),
  )

  it('finds the text declarations to check in the first place', () => {
    expect(declarations.length).toBeGreaterThan(400)
  })

  it('names a --c-* token, or one of the enumerated theme-blind exceptions', () => {
    const allowed = ({ value }: { value: string }) => {
      if (/^var\(--c-[\w-]+(,\s*var\(--c-[\w-]+\))?\)$/.test(value)) return true // pure token
      if (LITERAL_TEXT_COLORS[value]) return true
      const legacy = /^var\((--c-[\w-]+),\s*#[0-9a-f]{3,6}\)$/i.exec(value)
      return legacy !== null && LEGACY_BADGE_VARS.includes(legacy[1]!)
    }
    const stray = declarations.filter((decl) => !allowed(decl))
    expect(stray.map(({ file, value }) => `${file}: ${value}`)).toEqual([])
  })

  it('leaves no text colour mixed towards a fixed white', () => {
    // `color-mix(… , white)` dims on a dark canvas and washes out on a light one;
    // the dimmer level is `--c-text-disabled`, which flips with the theme.
    for (const { file, value } of declarations) {
      expect(value, file).not.toMatch(/white/)
    }
  })
})
