import type { ImPlatform, RobotConfigInput, VendorId } from '@ccc/shared/protocol'
import type { AppCtx } from './types'

/**
 * Chat-robot actions.
 *
 * Robots are global rather than per-workspace, so nothing here takes a
 * workspace. Every write is server-authoritative: the roster is re-read from the
 * reply instead of being predicted locally, because the server can refuse (an
 * unacknowledged robot cannot be enabled) and a client-side guess would show a
 * state that never happened.
 */
export function installRobotActions(ctx: AppCtx): void {
  const send = ctx.send

  ctx.loadRobots = (): void => {
    if (!ctx.client) return
    ctx.robotsLoading.value = true
    send({ type: 'list_robots' })
  }

  ctx.selectRobot = (robotId: string | null): void => {
    ctx.selectedRobotId.value = robotId
    ctx.robotTurns.value = []
    if (robotId) send({ type: 'list_robot_turns', robotId })
  }

  ctx.createRobot = (name: string, platform: ImPlatform, config: RobotConfigInput): void => {
    send({ type: 'create_robot', name, platform, config })
  }

  ctx.updateRobot = (robotId: string, config: RobotConfigInput): void => {
    send({ type: 'update_robot', robotId, config })
  }

  ctx.deleteRobot = (robotId: string): void => {
    send({ type: 'delete_robot', robotId })
    if (ctx.selectedRobotId.value === robotId) ctx.selectRobot(null)
  }

  ctx.setRobotEnabled = (robotId: string, enabled: boolean): void => {
    send({ type: 'set_robot_enabled', robotId, enabled })
  }

  // A robot has no workspace, so the manifest is the vendor's built-ins plus c3's
  // own MCP tools — request it without a `workspaceName`. Cached per vendor like
  // the automation form's; the reply routes by `scope: 'robot'`.
  ctx.onLoadRobotToolManifest = (vendor: string): void => {
    if (!vendor) return
    if (ctx.robotToolManifest.value[vendor]) {
      ctx.robotToolManifestLoading.value = false
      ctx.robotToolManifestError.value = null
      return
    }
    ctx.robotToolManifestLoading.value = true
    ctx.robotToolManifestError.value = null
    send({ type: 'get_tool_manifest', vendor: vendor as VendorId, scope: 'robot' })
  }

  // Enabling is refused until this is recorded, so the two are sent together
  // once the operator confirms the dialog.
  ctx.acknowledgeAndEnableRobot = (robotId: string): void => {
    send({ type: 'acknowledge_robot_outbound', robotId })
    send({ type: 'set_robot_enabled', robotId, enabled: true })
  }
}
