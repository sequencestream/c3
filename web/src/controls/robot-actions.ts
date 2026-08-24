import type { ImPlatform, RobotConfigInput, VendorId } from '@ccc/shared/protocol'
import { idleFeishuAppRegistration, isFeishuRegistrationActive } from './state'
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
    ctx.imIdentityBindings.value = []
    ctx.imGroupWorkspaceScopes.value = []
    ctx.imGroupScopeChatId.value = ''
    if (robotId) {
      send({ type: 'list_robot_turns', robotId })
      const robot = ctx.robots.value.find((r) => r.id === robotId)
      if (robot && ctx.auth.isAdmin.value) {
        send({
          type: 'list_im_identity_bindings',
          accountNamespace: `${robot.platform}:${robot.appId}`,
        })
      }
    }
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

  /**
   * Start a one-click app registration on `platform`. The requestId is generated
   * here and echoed on every server frame for this attempt; the form only sees
   * the derived state. No-op while a request is already active — the server
   * refuses a duplicate anyway, but the client must not even mint a second
   * requestId.
   */
  ctx.startFeishuAppRegistration = (platform: ImPlatform): void => {
    const current = ctx.feishuAppRegistration.value
    if (isFeishuRegistrationActive(current)) return
    const requestId = crypto.randomUUID()
    ctx.feishuAppRegistration.value = {
      ...idleFeishuAppRegistration(),
      requestId,
      phase: 'starting',
    }
    send({ type: 'start_app_registration', requestId, platform })
  }

  /** Cancel the active request and clear the QR/status immediately. */
  ctx.cancelFeishuAppRegistration = (): void => {
    const current = ctx.feishuAppRegistration.value
    if (current.requestId) {
      send({ type: 'cancel_app_registration', requestId: current.requestId })
    }
    ctx.feishuAppRegistration.value = idleFeishuAppRegistration()
  }

  /** Drop the registration view state locally (no wire message). */
  ctx.clearFeishuAppRegistration = (): void => {
    ctx.feishuAppRegistration.value = idleFeishuAppRegistration()
  }

  // Enabling is refused until this is recorded, so the two are sent together
  // once the operator confirms the dialog.
  ctx.acknowledgeAndEnableRobot = (robotId: string): void => {
    send({ type: 'acknowledge_robot_outbound', robotId })
    send({ type: 'set_robot_enabled', robotId, enabled: true })
  }

  ctx.acknowledgeRobotWriteGrant = (
    robotId: string,
    capability: import('@ccc/shared/protocol').RobotWritableCapability,
  ): void => {
    send({ type: 'acknowledge_robot_write_capability', robotId, capability })
  }

  ctx.setRobotWriteGrantEnabled = (
    robotId: string,
    capability: import('@ccc/shared/protocol').RobotWritableCapability,
    enabled: boolean,
  ): void => {
    send({ type: 'set_robot_write_grant_enabled', robotId, capability, enabled })
  }

  ctx.fetchImIdentityBindings = (accountNamespace: string): void => {
    send({ type: 'list_im_identity_bindings', accountNamespace })
  }

  ctx.adminRevokeImIdentity = (bindingId: string): void => {
    send({ type: 'admin_revoke_im_identity', bindingId })
  }

  ctx.fetchImGroupWorkspaceScopes = (
    platform: ImPlatform,
    providerAccountKey: string,
    chatId: string,
  ): void => {
    ctx.imGroupScopeChatId.value = chatId
    send({ type: 'list_im_group_workspace_scopes', platform, providerAccountKey, chatId })
  }

  ctx.setImGroupWorkspaceScopes = (
    platform: ImPlatform,
    providerAccountKey: string,
    chatId: string,
    workspaceNames: string[],
  ): void => {
    send({
      type: 'set_im_group_workspace_scopes',
      platform,
      providerAccountKey,
      chatId,
      workspaceNames,
    })
  }
}
