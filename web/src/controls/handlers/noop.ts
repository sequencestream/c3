import type { HandlerMap } from '../handler-registry'
import type { MessageHandlerLocals } from './context'
import type { AppCtx } from '../types'

export function buildNoopHandlers(
  _ctx: AppCtx,
  _locals: MessageHandlerLocals,
): Pick<
  HandlerMap,
  | 'pong'
  | 'runtime_log'
  | 'automation_execution_logs'
  | 'workspace_mcp_config'
  | 'timerange_stats'
  | 'mcp_api_keys'
> {
  return {
    pong: () => {},
    runtime_log: () => {},
    automation_execution_logs: () => {},
    workspace_mcp_config: () => {},
    timerange_stats: () => {},
    mcp_api_keys: () => {},
  }
}
