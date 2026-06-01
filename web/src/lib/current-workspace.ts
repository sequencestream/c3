/*
 * current-workspace.ts — 「当前工作区」解析(纯逻辑,DOM-free)。
 *
 * 全局唯一的当前工作区:优先沿用持久化的选择(只要它仍在工作区列表中),
 * 否则回落到最近访问的工作区(列表首项,服务端按 recent-access 排序),空列表时为 null。
 */
import type { WorkspaceInfo } from '@ccc/shared/protocol'

/**
 * 解析当前工作区路径。
 * @param stored 上次持久化的工作区路径(localStorage),无则传 null。
 * @param workspaces 服务端给出的工作区列表(recent-access 排序)。
 */
export function resolveCurrentWorkspace(
  stored: string | null,
  workspaces: WorkspaceInfo[],
): string | null {
  if (stored && workspaces.some((w) => w.path === stored)) return stored
  return workspaces[0]?.path ?? null
}
