/*
 * workspace-list.ts — 工作区列表竖条的排序口径(纯逻辑,DOM-free)。
 *
 * 排序只有一条口径:`WorkspaceInfo.lastAccessed`(协议里就注明是 "Sort key (desc)")
 * 倒序。服务端 `listWorkspaces()` 已按它降序下发,所以前端拿到的数组**默认就是对的**;
 * 这里再排一次是防御性的 —— 让列表在别的调用路径(测试、非 listWorkspaces 的来源)
 * 喂进乱序时仍表现正确。排序不引入手动置顶、拖拽序或任何本地覆写的权重。
 *
 * 纯函数:入参与返回都是新数组,不改传入的数组本身,调用方按需整体替换 ref。
 */
import type { WorkspaceInfo } from '@ccc/shared/protocol'

/**
 * 按「最近访问」排序:时间新的在前;时间相同则按名称升序,保证同一批数据每次渲染
 * 顺序一致(不会因为 `Array#sort` 的稳定性实现差异而在两次渲染间跳动)。
 */
export function sortWorkspacesByRecency(workspaces: WorkspaceInfo[]): WorkspaceInfo[] {
  return [...workspaces].sort(
    (a, b) => b.lastAccessed - a.lastAccessed || a.name.localeCompare(b.name),
  )
}

/**
 * 记一次「刚刚访问过」并重排,返回新数组。
 *
 * 切换当前工作区后,服务端会更新该工作区的 `lastAccessed`,但这条路径(`open_intent_session`
 * → `touchWorkspace`)不会把新的 `workspaces` 列表推回来,列表顺序会滞后。这里在客户端
 * 侧补上这次时间戳:命中的那一项排到最前,其余项之间的相对顺序不变。
 *
 * 目标既可以是工作区名也可以是绝对路径 —— 与服务端 `resolveWorkspaceRoot` 的解析口径
 * 一致(切换动作两条形式都可能出现)。没命中(工作区已被移除)时原样返回排序后的列表。
 */
export function touchWorkspaceAccess(
  workspaces: WorkspaceInfo[],
  target: string,
  now: number = Date.now(),
): WorkspaceInfo[] {
  return sortWorkspacesByRecency(
    workspaces.map((w) =>
      w.name === target || w.path === target ? { ...w, lastAccessed: now } : w,
    ),
  )
}
