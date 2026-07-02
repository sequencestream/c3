/**
 * 分享链接文本生成:把「类型 + 标题 + 深链 URL」拼成一段可复制的分享文本。
 *
 * 与 `deep-link.ts` 的 `parseDeepLink` 单向对齐 —— 这里只负责生成、不参与解析。
 * URL 契约:`<baseUrl>/#/<kind>/<workspaceId>/<id>`(与 parseDeepLink 的三段式一致)。
 */
import type { DeepLinkKind } from './deep-link'

/** 分享目标:一次分享所需的全部数据(typeLabel 由调用方本地化后传入)。 */
export interface ShareTarget {
  kind: DeepLinkKind
  workspaceId: string
  id: string
  title: string
  /** 已本地化的类型标签,如 `Session` / `会话`;拼进 `[类型]` 前缀。 */
  typeLabel: string
}

/**
 * 拼出分享文本:`[<typeLabel>] <title>\n<baseUrl>/#/<kind>/<workspaceId>/<id>`。
 *
 * `baseUrl` 经 trim + 去尾斜杠后为空(未配置)时返回 null,调用方据此走「未配置」分支
 * (提示去系统设置填写、且不写剪贴板)。
 */
export function buildShareText(
  input: ShareTarget & { baseUrl: string | null | undefined },
): string | null {
  const base = (input.baseUrl ?? '').trim().replace(/\/+$/, '')
  if (!base) return null
  const url = `${base}/#/${input.kind}/${input.workspaceId}/${input.id}`
  return `[${input.typeLabel}] ${input.title}\n${url}`
}
