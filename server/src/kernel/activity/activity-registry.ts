/**
 * In-process activity registry: the current-state counterpart of the event bus.
 *
 * The bus records what happened. This registry records which activities the
 * process currently recognizes, fenced by generation (which run) and sequence
 * (which update of that run). Callers that omit fencing operate on the live
 * generation and receive an auto-incremented sequence — that is the path
 * Session Runtime uses. Tests and later lease renewal pass explicit fencing
 * so late or replayed updates are ignored.
 *
 * The registry does not write persistent business state. Snapshot is a
 * read-only clone. Rebuild replaces the whole table from authority sources.
 */
import { randomUUID } from 'node:crypto'
import {
  isRunningActivityState,
  type ActivityApplyResult,
  type ActivityFact,
  type ActivityFencing,
  type ActivityMutation,
  type ActivityMutationListener,
  type ActivityOwner,
  type ActivityRegistryClock,
  type ActivityStartInput,
  type ActivityState,
} from './types.js'

function cloneFact(fact: ActivityFact): ActivityFact {
  return {
    ...fact,
    owner: fact.owner ? { ...fact.owner } : undefined,
  }
}

function defaultClock(): ActivityRegistryClock {
  return { now: () => Date.now(), generation: () => randomUUID() }
}

export class ActivityRegistry {
  private readonly facts = new Map<string, ActivityFact>()
  private readonly sessionIndex = new Map<string, string>()
  private readonly aliases = new Map<string, string>()
  private readonly listeners = new Set<ActivityMutationListener>()
  private readonly clock: ActivityRegistryClock

  constructor(clock?: Partial<ActivityRegistryClock>) {
    const fallback = defaultClock()
    this.clock = {
      now: clock?.now ?? fallback.now,
      generation: clock?.generation ?? fallback.generation,
    }
  }

  start(input: ActivityStartInput): ActivityApplyResult {
    const at = input.at ?? this.clock.now()
    const existing = this.lookup(input.activityId) ?? this.lookup(input.sessionId)
    let replaced: ActivityFact | undefined
    if (existing) {
      if (existing.state === 'stale') {
        if (input.generation !== undefined && input.generation === existing.generation) {
          this.logReject('stale_generation', existing.activityId)
          return { accepted: false, reason: 'stale_generation' }
        }
        this.erase(existing)
        replaced = existing
      } else {
        if (input.generation !== undefined && input.generation !== existing.generation) {
          this.logReject('stale_generation', existing.activityId)
          return { accepted: false, reason: 'stale_generation' }
        }
        if (input.owner && !existing.owner) {
          return this.setOwner(existing.activityId, input.owner, { at })
        }
        return { accepted: true, fact: cloneFact(existing) }
      }
    }

    const occupant = this.lookup(input.sessionId)
    if (occupant && occupant.activityId !== input.activityId) {
      return { accepted: false, reason: 'duplicate_session' }
    }

    const fact: ActivityFact = {
      activityId: input.activityId,
      generation: input.generation ?? this.clock.generation(),
      sequence: 1,
      sessionId: input.sessionId,
      workspaceName: input.workspaceName,
      sessionKind: input.sessionKind,
      owner: input.owner ? { ...input.owner } : undefined,
      state: input.state ?? 'running',
      updatedAt: at,
      leaseUntil: input.leaseUntil,
    }
    this.put(fact)
    this.emitChange(replaced, fact)
    return { accepted: true, fact: cloneFact(fact) }
  }

  bind(prevId: string, realId: string, fencing?: ActivityFencing): ActivityApplyResult {
    if (!prevId || !realId) return { accepted: false, reason: 'unknown_activity' }
    if (prevId === realId) {
      const same = this.lookup(prevId)
      return same
        ? { accepted: true, fact: cloneFact(same) }
        : { accepted: false, reason: 'unknown_activity' }
    }

    const pending = this.lookup(prevId)
    const real = this.lookup(realId)
    if (pending && real && pending.activityId !== real.activityId) {
      const gated = this.gate(pending, fencing)
      if (!gated.accepted) return gated
      this.erase(pending)
      this.aliases.set(prevId, real.activityId)
      this.emitChange(pending, undefined)
      return { accepted: true, fact: cloneFact(real) }
    }
    if (!pending && real) {
      this.aliases.set(prevId, real.activityId)
      return { accepted: true, fact: cloneFact(real) }
    }
    if (!pending) return { accepted: false, reason: 'unknown_activity' }

    const gated = this.gate(pending, fencing)
    if (!gated.accepted) return gated

    const at = fencing?.at ?? this.clock.now()
    const next: ActivityFact = {
      ...pending,
      activityId: realId,
      sessionId: realId,
      sequence: pending.sequence + 1,
      updatedAt: at,
    }
    this.erase(pending)
    this.put(next)
    this.aliases.set(prevId, realId)
    this.emitChange(pending, next)
    return { accepted: true, fact: cloneFact(next) }
  }

  transition(
    activityId: string,
    state: Exclude<ActivityState, 'idle'>,
    fencing?: ActivityFencing,
  ): ActivityApplyResult {
    const current = this.lookup(activityId)
    if (!current) return { accepted: false, reason: 'unknown_activity' }
    const gated = this.gate(current, fencing)
    if (!gated.accepted) return gated
    if (current.state === state && fencing?.sequence === undefined) {
      return { accepted: true, fact: cloneFact(current) }
    }
    return this.commit(current, { state, updatedAt: fencing?.at ?? this.clock.now() })
  }

  renew(activityId: string, leaseUntil: number, fencing?: ActivityFencing): ActivityApplyResult {
    const current = this.lookup(activityId)
    if (!current) return { accepted: false, reason: 'unknown_activity' }
    const gated = this.gate(current, fencing)
    if (!gated.accepted) return gated
    return this.commit(current, {
      leaseUntil,
      updatedAt: fencing?.at ?? this.clock.now(),
    })
  }

  settle(activityId: string, fencing?: ActivityFencing): ActivityApplyResult {
    const current = this.lookup(activityId)
    if (!current) return { accepted: false, reason: 'settled' }
    const gated = this.gate(current, fencing)
    if (!gated.accepted) return gated
    const settled: ActivityFact = {
      ...current,
      state: 'idle',
      sequence: current.sequence + 1,
      updatedAt: fencing?.at ?? this.clock.now(),
    }
    this.erase(current)
    this.emitChange(current, undefined)
    return { accepted: true, fact: cloneFact(settled) }
  }

  expire(activityId: string, fencing?: ActivityFencing): ActivityApplyResult {
    const current = this.lookup(activityId)
    if (!current) return { accepted: false, reason: 'unknown_activity' }
    const gated = this.gate(current, fencing)
    if (!gated.accepted) return gated
    if (
      current.state === 'awaiting_user' ||
      current.state === 'parked' ||
      current.state === 'paused'
    ) {
      return { accepted: true, fact: cloneFact(current) }
    }
    if (current.state === 'stale') return { accepted: true, fact: cloneFact(current) }
    return this.commit(current, {
      state: 'stale',
      updatedAt: fencing?.at ?? this.clock.now(),
    })
  }

  setOwner(
    activityId: string,
    owner: ActivityOwner | undefined,
    fencing?: ActivityFencing,
  ): ActivityApplyResult {
    const current = this.lookup(activityId)
    if (!current) return { accepted: false, reason: 'unknown_activity' }
    const gated = this.gate(current, fencing)
    if (!gated.accepted) return gated
    const same =
      (current.owner === undefined && owner === undefined) ||
      (current.owner !== undefined &&
        owner !== undefined &&
        current.owner.kind === owner.kind &&
        current.owner.id === owner.id)
    if (same && fencing?.sequence === undefined) {
      return { accepted: true, fact: cloneFact(current) }
    }
    return this.commit(current, {
      owner: owner ? { ...owner } : undefined,
      updatedAt: fencing?.at ?? this.clock.now(),
    })
  }

  remove(activityId: string): boolean {
    const current = this.lookup(activityId)
    if (!current) return false
    this.erase(current)
    this.emitChange(current, undefined)
    return true
  }

  removeByWorkspace(workspaceName: string): void {
    for (const fact of [...this.facts.values()]) {
      if (fact.workspaceName === workspaceName) {
        this.erase(fact)
        this.emitChange(fact, undefined)
      }
    }
    this.notify({ type: 'clear_workspace', workspaceName })
  }

  subscribe(listener: ActivityMutationListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getByActivityId(activityId: string): ActivityFact | undefined {
    const fact = this.lookup(activityId)
    return fact ? cloneFact(fact) : undefined
  }

  getBySessionId(sessionId: string): ActivityFact | undefined {
    return this.getByActivityId(sessionId)
  }

  snapshot(): ActivityFact[] {
    return [...this.facts.values()].map(cloneFact)
  }

  snapshotRunning(): ActivityFact[] {
    return this.snapshot().filter((fact) => isRunningActivityState(fact.state))
  }

  replaceAll(facts: readonly ActivityFact[]): void {
    this.clearTables()
    for (const fact of facts) this.put(cloneFact(fact))
    this.notify({ type: 'rebuild', facts: this.snapshot() })
  }

  reset(): void {
    this.clearTables()
    this.notify({ type: 'reset' })
  }

  private lookup(id: string): ActivityFact | undefined {
    const direct = this.facts.get(id)
    if (direct) return direct
    const bySession = this.sessionIndex.get(id)
    if (bySession) return this.facts.get(bySession)
    const aliased = this.aliases.get(id)
    if (aliased) return this.facts.get(aliased)
    return undefined
  }

  private gate(current: ActivityFact, fencing?: ActivityFencing): ActivityApplyResult {
    if (fencing?.generation !== undefined && fencing.generation !== current.generation) {
      this.logReject('stale_generation', current.activityId)
      return { accepted: false, reason: 'stale_generation' }
    }
    if (fencing?.sequence !== undefined && fencing.sequence <= current.sequence) {
      this.logReject('stale_sequence', current.activityId)
      return { accepted: false, reason: 'stale_sequence' }
    }
    return { accepted: true, fact: current }
  }

  private commit(current: ActivityFact, patch: Partial<ActivityFact>): ActivityApplyResult {
    const prev = cloneFact(current)
    const next: ActivityFact = {
      ...current,
      ...patch,
      sequence: current.sequence + 1,
    }
    this.put(next)
    this.emitChange(prev, next)
    return { accepted: true, fact: cloneFact(next) }
  }

  private emitChange(prev: ActivityFact | undefined, next: ActivityFact | undefined): void {
    this.notify({
      type: 'change',
      prev: prev ? cloneFact(prev) : undefined,
      next: next ? cloneFact(next) : undefined,
    })
  }

  private notify(mutation: ActivityMutation): void {
    for (const listener of this.listeners) listener(mutation)
  }

  private clearTables(): void {
    this.facts.clear()
    this.sessionIndex.clear()
    this.aliases.clear()
  }

  private put(fact: ActivityFact): void {
    this.facts.set(fact.activityId, fact)
    this.sessionIndex.set(fact.sessionId, fact.activityId)
    if (fact.sessionId !== fact.activityId) {
      this.sessionIndex.set(fact.activityId, fact.activityId)
    }
  }

  private erase(fact: ActivityFact): void {
    this.facts.delete(fact.activityId)
    this.sessionIndex.delete(fact.sessionId)
    this.sessionIndex.delete(fact.activityId)
    for (const [alias, activityId] of this.aliases) {
      if (activityId === fact.activityId) this.aliases.delete(alias)
    }
  }

  private logReject(reason: 'stale_generation' | 'stale_sequence', activityId: string): void {
    console.log('[c3:activity] rejected %s activity=%s', reason, activityId)
  }
}

let workspaceNameOf = (workspacePath: string): string => workspacePath
let ownerOf = (_sessionId: string): ActivityOwner | undefined => undefined

export function setActivityWorkspaceNameResolver(
  fn: ((workspacePath: string) => string) | null,
): void {
  workspaceNameOf = fn ?? ((workspacePath) => workspacePath)
}

export function resolveActivityWorkspaceName(workspacePath: string): string {
  return workspaceNameOf(workspacePath)
}

export function setActivityOwnerResolver(
  fn: ((sessionId: string) => ActivityOwner | undefined) | null,
): void {
  ownerOf = fn ?? (() => undefined)
}

export function resolveActivityOwner(sessionId: string): ActivityOwner | undefined {
  return ownerOf(sessionId)
}

export const activityRegistry = new ActivityRegistry()

export function resetActivityRegistryForTests(): void {
  activityRegistry.reset()
  setActivityWorkspaceNameResolver(null)
  setActivityOwnerResolver(null)
}
