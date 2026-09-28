/*
 * workspace-color.ts — 由工作区名派生稳定配色(纯逻辑,DOM-free)。
 *
 * 工作区身份只有服务端分配的不透明名字,`WorkspaceInfo` 没有颜色字段。与其新增协议
 * 字段,不如在客户端由名字派生:同名恒定同色、跨刷新一致,零协议改动,展开/收缩两种
 * 竖条形态也能共用同一份函数。
 *
 * 取色不在运行时算 HSL,而是取一小组**按主题声明的 `--c-ws-*` 令牌**:每套主题各自
 * 取值,浅底自动下沉,对比度由 lib/contrast.test.ts 审计覆盖。这样竖条不携带任何
 * 主题敏感的硬编码色,主题切换也无需重算。每个槽位另有一个配套的 `--c-ws-ink-N`
 * 令牌 —— 同一填充上的文字色(白或近黑)随槽位不同而定,同样交给主题声明。
 */
import { readTokenBlock } from './contrast'

/**
 * 竖条可用的稳定色槽位数。槽位按色相铺开(蓝 / 紫 / 品红 / 琥珀 / 绿 / 青),
 * 保证相邻分到的工作区一眼可分;每个槽位在每套主题下都有独立取值。
 */
export const WORKSPACE_COLOR_SLOTS = 6

const SLOT_NAMES = ['1', '2', '3', '4', '5', '6'] as const

export interface WorkspaceFill {
  /** 徽标实底色,形如 `var(--c-ws-3)`。 */
  fill: string
  /** 徽标上文字色,形如 `var(--c-ws-ink-3)`。 */
  ink: string
}

/**
 * 由工作区名派生稳定配色。返回的取值是可直接塞进 `var()` 的变量名,主题一换就跟着
 * 换,调用方不需要知道当前主题。
 *
 * @param name 工作区名(服务端分配的不透明 id,展示上就是工作区名);空/缺省返回 null。
 */
export function workspaceColor(name: string | null | undefined): WorkspaceFill | null {
  if (!name?.trim()) return null
  const slot = SLOT_NAMES[hashName(name) % WORKSPACE_COLOR_SLOTS]!
  return { fill: `var(--c-ws-${slot})`, ink: `var(--c-ws-ink-${slot})` }
}

/** FNV-1a:同名恒定同值。 */
function hashName(name: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** 该工作区名字首字符(竖条徽标的文字);空名返回 null。 */
export function workspaceInitial(name: string | null | undefined): string | null {
  const trimmed = name?.trim() ?? ''
  if (!trimmed) return null
  return String.fromCodePoint(trimmed.codePointAt(0)!).toUpperCase()
}
