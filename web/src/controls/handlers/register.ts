import type { HandlerMap } from '../handler-registry'
import type { AppCtx } from '../types'
import { createMessageHandlerLocals, type MessageHandlerLocals } from './context'
import { buildAuthHandlers } from './auth'
import { buildSessionHandlers } from './session'
import { buildWorkspaceHandlers } from './workspace'
import { buildSettingsHandlers } from './settings'
import { buildIntentHandlers } from './intent'
import { buildDeliveryHandlers } from './delivery'
import { buildDiscussionHandlers } from './discussion'
import { buildAutomationHandlers } from './automation'
import { buildFilesHandlers } from './files'
import { buildRobotHandlers } from './robot'
import { buildErrorHandlers } from './error'
import { buildNoopHandlers } from './noop'

/** Assemble the exhaustive inbound handler map for one controller install. */
export function buildHandlerMap(ctx: AppCtx, locals: MessageHandlerLocals): HandlerMap {
  return {
    ...buildAuthHandlers(ctx, locals),
    ...buildSessionHandlers(ctx, locals),
    ...buildWorkspaceHandlers(ctx, locals),
    ...buildSettingsHandlers(ctx, locals),
    ...buildIntentHandlers(ctx, locals),
    ...buildDeliveryHandlers(ctx, locals),
    ...buildDiscussionHandlers(ctx, locals),
    ...buildAutomationHandlers(ctx, locals),
    ...buildFilesHandlers(ctx, locals),
    ...buildRobotHandlers(ctx, locals),
    ...buildErrorHandlers(ctx, locals),
    ...buildNoopHandlers(ctx, locals),
  }
}

export { createMessageHandlerLocals }
