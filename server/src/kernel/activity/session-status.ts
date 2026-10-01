import type { SessionStatus } from '@ccc/shared/protocol'
import type { ActivityState } from './types.js'

/**
 * Map a Session Runtime status onto an activity state.
 * `reconnecting` stays `running` so a brief disconnect does not drop the badge.
 * `idle` is the settle signal, not a retained activity.
 */
export function mapSessionStatusToActivityState(status: SessionStatus): ActivityState {
  switch (status) {
    case 'idle':
      return 'idle'
    case 'awaiting_permission':
      return 'awaiting_user'
    case 'team':
      return 'parked'
    case 'running':
    case 'reconnecting':
      return 'running'
  }
}
