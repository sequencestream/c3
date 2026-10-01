/**
 * Resident EventBus subscription that keeps the activity registry aligned with
 * run lifecycle. Session Runtime already writes start / transition / settle /
 * bind / remove; this subscription covers the same facts for publishers that
 * have no runtime yet, and attaches owner metadata once the projection row
 * exists.
 *
 * Automation `run:started` / `run:settled` carry the execution-log id, not the
 * vendor session id. Those ids must not become a second counted member — LLM
 * automations enter the registry when they register a Session Runtime.
 */
import type { EventBus, EventBusEvents } from '../kernel/events/event-bus.js'
import {
  activityRegistry,
  nextLeaseUntil,
  resolveActivityWorkspaceName,
  setActivityOwnerResolver,
  setActivityWorkspaceNameResolver,
} from '../kernel/activity/index.js'
import { lookupActivityOwner } from '../features/works/activity-rebuild.js'
import { pathToName } from '../state.js'

export function registerActivityRegistry(eventBus: EventBus<EventBusEvents>): void {
  setActivityWorkspaceNameResolver((workspacePath) => pathToName(workspacePath) ?? workspacePath)
  setActivityOwnerResolver(lookupActivityOwner)

  eventBus.subscribe('run:started', (e) => {
    if (e.sessionKind === 'automation') return
    const owner = lookupActivityOwner(e.sessionId)
    const existing = activityRegistry.getBySessionId(e.sessionId)
    if (!existing) {
      const at = Date.now()
      activityRegistry.start({
        activityId: e.sessionId,
        sessionId: e.sessionId,
        workspaceName: resolveActivityWorkspaceName(e.workspacePath),
        sessionKind: e.sessionKind,
        owner,
        state: 'running',
        at,
        leaseUntil: nextLeaseUntil(at, 'running'),
      })
      return
    }
    if (owner) activityRegistry.setOwner(e.sessionId, owner)
  })

  eventBus.subscribe('run:bound', (e) => {
    activityRegistry.bind(e.prevId, e.realId)
    const owner = lookupActivityOwner(e.realId) ?? lookupActivityOwner(e.prevId)
    if (owner) activityRegistry.setOwner(e.realId, owner)
  })

  eventBus.subscribe('run:settled', (e) => {
    if (e.sessionKind === 'automation') return
    activityRegistry.settle(e.sessionId)
  })
}
