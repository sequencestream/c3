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
 */
import type { RobotProfile } from '../../kernel/run/run-via-driver.js'
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
    '',
    '只有你最后一段回复会被发出去,中间过程不会。',
  ].join('\n')
}

/**
 * The profile for one robot. Unknown robot ⇒ a read-only profile with no
 * widening, which is the safe direction for a lookup that failed.
 */
export function robotLaunchProfile(robotId: string): RobotProfile {
  const robot = getRobot(robotId)
  const allowed = new Set(robot?.toolAllowlist ?? [])
  return {
    appendSystemPrompt: systemPrompt(robot?.name ?? 'robot'),
    disallowedTools: ROBOT_BASE_DISALLOWED_TOOLS.filter((t) => !allowed.has(t)),
    gate: 'robot',
    allowedTools: allowed,
  }
}
