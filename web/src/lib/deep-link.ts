/**
 * 最小 hash 深链解析:从 URL hash 提取会话/意图/讨论的定位目标。
 *
 * URL 契约(一次性、单向):
 *   #/session/<workspaceId>/<sessionId>
 *   #/intent/<workspaceId>/<intentId>
 *   #/discussion/<workspaceId>/<discussionId>
 *
 * 合法 hash 返回对应结构;缺段、多段、未知 kind 或空 hash 返回 null。
 */

/** 支持的深链 kind(白名单,与意图 What 的三类一致)。 */
export const DEEP_LINK_KINDS = ['session', 'intent', 'discussion'] as const
export type DeepLinkKind = (typeof DEEP_LINK_KINDS)[number]

/** 解析后的深链目标。 */
export interface DeepLinkTarget {
  kind: DeepLinkKind
  workspaceId: string
  id: string
}

/**
 * 从 `location.hash` 解析出深链目标,校验段数与 kind 白名单。
 * 输入不含前导 `#`(调用方负责剥离);空串或非法格式一律返回 null。
 *
 * @param hash - hash 字符串(不带前导 `#`,如 `/session/ws1/sid1`)。
 *        `location.hash` 自带前导 `#`,调用前需用 `.slice(1)` 剥离。
 */
export function parseDeepLink(hash: string): DeepLinkTarget | null {
  if (!hash) return null

  // 首段是路径,以 `/` 开头时去之
  const trimmed = hash.startsWith('/') ? hash.slice(1) : hash
  const parts = trimmed.split('/')

  // 必须恰好三段:kind / workspaceId / id
  if (parts.length !== 3) return null
  const [kind, workspaceId, id] = parts
  if (!kind || !workspaceId || !id) return null

  // kind 必须命中白名单
  if (!(DEEP_LINK_KINDS as readonly string[]).includes(kind)) return null

  // workspaceId 与 id 非空已在上面检查
  return { kind: kind as DeepLinkKind, workspaceId, id }
}
