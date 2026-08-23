/**
 * A robot's launch profile: the lock a robot turn runs under.
 *
 * Resolved per turn from the robot's stored configuration, because that
 * configuration is the whole of what constrains an externally-driven run. The
 * launcher refuses to start a robot runtime without this (ADR-0046), so a
 * missing or unreadable robot must produce the NARROWEST profile rather than a
 * permissive default — the failure mode of a lookup miss has to be "can do
 * nothing", never "can do anything".
 *
 * `disallowedTools` cuts the write and execution tools at the SDK level, and the
 * gate refuses them again. The allowlist re-admits exactly what an administrator
 * listed, so widening is one deliberate act rather than a mode.
 *
 * The allowlist is split into three surfaces at profile time (spec: 机器人回合在
 * 启动画像解析阶段把当前 `toolAllowlist` 分成 SDK 工具、c3 MCP 工具和 `network-access`
 * 伪条目):
 *  - **SDK + c3 MCP tool names** → `allowedTools`, the frozen set the `robot` gate
 *    checks. The `network-access` pseudo-entry never lands here.
 *  - **c3 MCP tools the robot ticked** → handed to the per-turn MCP binder, which
 *    registers exactly that subset over the loopback HTTP MCP route.
 *  - **`network-access`** → a boolean opt-in, effective only when the driver path
 *    later confirms Codex `workspace-write`. Absent means offline.
 */
import type { RobotProfile } from '../../kernel/run/run-via-driver.js'
import { NETWORK_ACCESS_TOOL } from '@ccc/shared/protocol'
import { selectedRobotC3McpToolNames, selectsLocalWriteTool } from '../tool-manifest/index.js'
import { getRobot } from './robot-store.js'

/**
 * Cut at the SDK level as a first line of defence; the `robot` gate is the
 * second. A tool the robot was widened to is removed from this list, otherwise
 * the allowlist could never take effect.
 */
const ROBOT_BASE_DISALLOWED_TOOLS = [
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'BashOutput',
  'KillShell',
  'Task',
  'SlashCommand',
]

function systemPrompt(robotName: string): string {
  return [
    `你是通过 IM 群聊接入的助手「${robotName}」,运行在 c3 中。`,
    '',
    '你的回答会被原样发回聊天窗口,因此:',
    '- 直接给结论,不要复述问题,不要解释你将要做什么。',
    '- 保持简短。聊天窗口不适合长篇输出,必要时给要点。',
    '- 你无法向提问者追问 —— 群里没有人能回答工具授权。信息不足时,直接说明缺什么。',
    '- 调用 save_intents 前必须先完整列出本轮全部意图及有效 status/automate；若会改变状态或自动执行,必须明确列出旧值→新值,并等用户以文字明确确认。修改意见、反对或含糊答复都不是确认。管理员勾选工具只授予调用能力,不能替代这次确认。',
    '',
    '只有你最后一段回复会被发出去,中间过程不会。',
  ].join('\n')
}

/**
 * The binder factory the composition root supplies. `bindC3Tools` returns the
 * per-turn MCP binder for exactly the c3 tools the robot's allowlist selected,
 * or `undefined` when nothing was selected (the route is then simply not bound).
 */
export interface RobotMcpBinder {
  bindC3Tools: (selected: readonly string[]) => RobotProfile['bindMcp'] | undefined
}

/**
 * The profile for one robot. Unknown robot ⇒ a read-only, offline profile with
 * no widening, which is the safe direction for a lookup that failed.
 */
export function robotLaunchProfile(robotId: string, mcp: RobotMcpBinder): RobotProfile {
  const robot = getRobot(robotId)
  // `network-access` is a pseudo-entry: it records a network opt-in and never
  // reaches the gate / allowlist (spec: 伪条目本身永不进入 `allowedTools` 或工具 gate).
  const allowlist = robot?.toolAllowlist ?? []
  const real = allowlist.filter((t) => t !== NETWORK_ACCESS_TOOL)
  const allowed = new Set(real)
  const selected = selectedRobotC3McpToolNames(real)
  return {
    appendSystemPrompt: systemPrompt(robot?.name ?? 'robot'),
    disallowedTools: ROBOT_BASE_DISALLOWED_TOOLS.filter((t) => !allowed.has(t)),
    gate: 'robot',
    allowedTools: allowed,
    // Only a selected LOCAL write/exec tool of the robot's own vendor may open a
    // writable native sandbox — c3 MCP write tools and `network-access` never do.
    writeEnabled: selectsLocalWriteTool(robot?.vendor ?? '', real),
    // The operator's opt-in; the driver path re-checks vendor + Codex action mode
    // before it means anything, so a stale marker in an inapplicable env is inert.
    networkAccess: allowlist.includes(NETWORK_ACCESS_TOOL),
    bindMcp: selected.length > 0 ? mcp.bindC3Tools(selected) : undefined,
  }
}
