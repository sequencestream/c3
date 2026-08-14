/**
 * The read side of the local park-recovery observation.
 *
 * One handler, one reply, no writes. It answers only for a workspace the
 * connection can already resolve — the request names an immutable workspace name and
 * the server turns it into a path through the same registry every other feature
 * uses, so a client cannot read a workspace it has no access to.
 *
 * The reply carries counts and a nullable ratio, nothing else: no event rows, no
 * intent ids, no reason codes, no text. A failed read is reported as an error so
 * the panel can say "unavailable" instead of showing a fabricated 0%.
 */
import type { Handler } from '../../transport/handler-registry.js'
import { resolveWorkspaceRoot } from '../../state.js'
import { parkRecoveryFigures } from './funnel-store.js'

export const getParkRecoveryStatsHandler: Handler<'get_park_recovery_stats'> = (
  _ctx,
  conn,
  msg,
) => {
  const proj = resolveWorkspaceRoot(msg.workspaceName)
  if (!proj) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { workspaceName: msg.workspaceName } },
    })
    return
  }
  try {
    const figures = parkRecoveryFigures(proj, Date.now())
    conn.send({ type: 'park_recovery_stats', workspaceName: msg.workspaceName, stats: figures })
  } catch (err) {
    console.error('[c3:funnel] 读取 park 恢复统计失败:', err)
    conn.send({
      type: 'park_recovery_stats',
      workspaceName: msg.workspaceName,
      error: { code: 'intent.parkStatsUnavailable' },
    })
  }
}
