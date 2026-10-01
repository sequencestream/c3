/**
 * Incremental badge projection over activity facts and attention member sets.
 *
 * Indexes store member sets, never independent counters. Aggregation is Set
 * size. A revision advances only when a workspace summary actually changes.
 *
 * Attention is three independent collections: still-answerable permission
 * requests, wait-user todos, and deliveries the delivery domain already judged
 * actionable. They are never summed into one number.
 *
 * Activity rebuild replaces running/owner indexes only. Attention is replaced
 * by its own sources. The projection is not a second source of truth: rebuild
 * from facts plus attention sets must match any legal incremental sequence.
 */
import type { SessionKind, SessionOwnerKind } from '@ccc/shared/protocol'
import {
  isRunningActivityState,
  type ActivityFact,
  type ActivityMutation,
  type AttentionKind,
  type BadgeProjectionSnapshot,
  type WorkspaceActivitySummary,
} from './types.js'

const SEP = '\0'

function emptySummary(): WorkspaceActivitySummary {
  return {
    runningSessions: 0,
    runningSessionsByKind: {},
    activeOwners: { intents: 0, discussions: 0, automations: 0 },
    attention: { awaitingPermission: 0, pendingUserTasks: 0, actionableDeliveries: 0 },
  }
}

function kindKey(workspaceName: string, kind: SessionKind): string {
  return `${workspaceName}${SEP}${kind}`
}

function ownerMemberKey(workspaceName: string, kind: SessionOwnerKind, id: string): string {
  return `${workspaceName}${SEP}${kind}${SEP}${id}`
}

function ownerKindKey(workspaceName: string, kind: SessionOwnerKind): string {
  return `${workspaceName}${SEP}${kind}`
}

function addMember(map: Map<string, Set<string>>, key: string, value: string): void {
  let set = map.get(key)
  if (!set) {
    set = new Set()
    map.set(key, set)
  }
  set.add(value)
}

function removeMember(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key)
  if (!set) return
  set.delete(value)
  if (set.size === 0) map.delete(key)
}

function summariesEqual(a: WorkspaceActivitySummary, b: WorkspaceActivitySummary): boolean {
  if (a.runningSessions !== b.runningSessions) return false
  if (a.activeOwners.intents !== b.activeOwners.intents) return false
  if (a.activeOwners.discussions !== b.activeOwners.discussions) return false
  if (a.activeOwners.automations !== b.activeOwners.automations) return false
  if (a.attention.awaitingPermission !== b.attention.awaitingPermission) return false
  if (a.attention.pendingUserTasks !== b.attention.pendingUserTasks) return false
  if (a.attention.actionableDeliveries !== b.attention.actionableDeliveries) return false
  const kinds = new Set<string>([
    ...Object.keys(a.runningSessionsByKind),
    ...Object.keys(b.runningSessionsByKind),
  ])
  for (const kind of kinds) {
    const left = a.runningSessionsByKind[kind as SessionKind] ?? 0
    const right = b.runningSessionsByKind[kind as SessionKind] ?? 0
    if (left !== right) return false
  }
  return true
}

function isEmptySummary(summary: WorkspaceActivitySummary): boolean {
  return summariesEqual(summary, emptySummary())
}

function sameIdSet(current: Set<string> | undefined, ids: readonly string[]): boolean {
  if ((current?.size ?? 0) !== ids.length) return false
  if (!current) return ids.length === 0
  return ids.every((id) => current.has(id))
}

export class BadgeProjection {
  private revision = 0
  private readonly sessionsByWorkspace = new Map<string, Set<string>>()
  private readonly sessionsByKind = new Map<string, Set<string>>()
  private readonly sessionsByOwner = new Map<string, Set<string>>()
  private readonly ownersByKind = new Map<string, Set<string>>()
  private readonly permissionsByWorkspace = new Map<string, Set<string>>()
  private readonly todosByWorkspace = new Map<string, Set<string>>()
  private readonly deliveriesByWorkspace = new Map<string, Set<string>>()

  getRevision(): number {
    return this.revision
  }

  snapshot(): BadgeProjectionSnapshot {
    const workspaces: Record<string, WorkspaceActivitySummary> = {}
    for (const workspaceName of this.indexedWorkspaces()) {
      const summary = this.summaryFor(workspaceName)
      if (isEmptySummary(summary)) continue
      workspaces[workspaceName] = summary
    }
    return { revision: this.revision, workspaces }
  }

  summaryFor(workspaceName: string): WorkspaceActivitySummary {
    const sessions = this.sessionsByWorkspace.get(workspaceName)
    const runningSessionsByKind: Partial<Record<SessionKind, number>> = {}
    if (sessions) {
      for (const [key, set] of this.sessionsByKind) {
        if (!key.startsWith(`${workspaceName}${SEP}`)) continue
        const kind = key.slice(workspaceName.length + 1) as SessionKind
        if (set.size > 0) runningSessionsByKind[kind] = set.size
      }
    }
    return {
      runningSessions: sessions?.size ?? 0,
      runningSessionsByKind,
      activeOwners: {
        intents: this.ownersByKind.get(ownerKindKey(workspaceName, 'intent'))?.size ?? 0,
        discussions: this.ownersByKind.get(ownerKindKey(workspaceName, 'discussion'))?.size ?? 0,
        automations: this.ownersByKind.get(ownerKindKey(workspaceName, 'automation'))?.size ?? 0,
      },
      attention: {
        awaitingPermission: this.permissionsByWorkspace.get(workspaceName)?.size ?? 0,
        pendingUserTasks: this.todosByWorkspace.get(workspaceName)?.size ?? 0,
        actionableDeliveries: this.deliveriesByWorkspace.get(workspaceName)?.size ?? 0,
      },
    }
  }

  apply(mutation: ActivityMutation): void {
    if (mutation.type === 'reset') {
      this.clearAll()
      this.revision = 0
      return
    }
    if (mutation.type === 'rebuild') {
      this.rebuild(mutation.facts)
      return
    }
    if (mutation.type === 'clear_workspace') {
      this.removeWorkspace(mutation.workspaceName)
      return
    }
    this.applyChange(mutation.prev, mutation.next)
  }

  rebuild(facts: readonly ActivityFact[]): void {
    const before = this.snapshotSummaries()
    this.clearActivityIndexes()
    for (const fact of facts) this.index(fact)
    this.bumpIfChanged(before)
  }

  reset(): void {
    this.clearAll()
    this.revision = 0
  }

  setAttentionMembers(kind: AttentionKind, workspaceName: string, ids: readonly string[]): void {
    const current = this.attentionMap(kind).get(workspaceName)
    if (sameIdSet(current, ids)) return
    const before = this.summaryFor(workspaceName)
    this.writeAttentionSet(kind, workspaceName, ids)
    if (!summariesEqual(before, this.summaryFor(workspaceName))) this.revision += 1
  }

  replaceAttentionKind(
    kind: AttentionKind,
    byWorkspace: ReadonlyMap<string, readonly string[]>,
  ): void {
    const map = this.attentionMap(kind)
    const affected = new Set<string>([...map.keys(), ...byWorkspace.keys()])
    const before = new Map<string, WorkspaceActivitySummary>()
    for (const ws of affected) before.set(ws, this.summaryFor(ws))
    map.clear()
    for (const [workspaceName, ids] of byWorkspace) {
      this.writeAttentionSet(kind, workspaceName, ids)
    }
    let changed = false
    for (const ws of affected) {
      if (!summariesEqual(before.get(ws) ?? emptySummary(), this.summaryFor(ws))) changed = true
    }
    if (changed) this.revision += 1
  }

  private applyChange(prev: ActivityFact | undefined, next: ActivityFact | undefined): void {
    const affected = new Set<string>()
    if (prev) affected.add(prev.workspaceName)
    if (next) affected.add(next.workspaceName)
    const before = new Map<string, WorkspaceActivitySummary>()
    for (const ws of affected) before.set(ws, this.summaryFor(ws))
    this.unindex(prev)
    this.index(next)
    let changed = false
    for (const ws of affected) {
      if (!summariesEqual(before.get(ws) ?? emptySummary(), this.summaryFor(ws))) changed = true
    }
    if (changed) this.revision += 1
  }

  private removeWorkspace(workspaceName: string): void {
    const before = this.summaryFor(workspaceName)
    this.dropWorkspaceKeys(workspaceName)
    if (!isEmptySummary(before)) this.revision += 1
  }

  private index(fact: ActivityFact | undefined): void {
    if (!fact || !isRunningActivityState(fact.state)) return
    addMember(this.sessionsByWorkspace, fact.workspaceName, fact.sessionId)
    addMember(this.sessionsByKind, kindKey(fact.workspaceName, fact.sessionKind), fact.sessionId)
    if (!fact.owner) return
    addMember(
      this.sessionsByOwner,
      ownerMemberKey(fact.workspaceName, fact.owner.kind, fact.owner.id),
      fact.sessionId,
    )
    addMember(this.ownersByKind, ownerKindKey(fact.workspaceName, fact.owner.kind), fact.owner.id)
  }

  private unindex(fact: ActivityFact | undefined): void {
    if (!fact || !isRunningActivityState(fact.state)) return
    removeMember(this.sessionsByWorkspace, fact.workspaceName, fact.sessionId)
    removeMember(this.sessionsByKind, kindKey(fact.workspaceName, fact.sessionKind), fact.sessionId)
    if (!fact.owner) return
    const memberKey = ownerMemberKey(fact.workspaceName, fact.owner.kind, fact.owner.id)
    removeMember(this.sessionsByOwner, memberKey, fact.sessionId)
    if (!this.sessionsByOwner.has(memberKey)) {
      removeMember(
        this.ownersByKind,
        ownerKindKey(fact.workspaceName, fact.owner.kind),
        fact.owner.id,
      )
    }
  }

  private attentionMap(kind: AttentionKind): Map<string, Set<string>> {
    if (kind === 'permission') return this.permissionsByWorkspace
    if (kind === 'todo') return this.todosByWorkspace
    return this.deliveriesByWorkspace
  }

  private writeAttentionSet(
    kind: AttentionKind,
    workspaceName: string,
    ids: readonly string[],
  ): void {
    const map = this.attentionMap(kind)
    if (ids.length === 0) {
      map.delete(workspaceName)
      return
    }
    map.set(workspaceName, new Set(ids))
  }

  private dropWorkspaceKeys(workspaceName: string): void {
    this.sessionsByWorkspace.delete(workspaceName)
    const prefix = `${workspaceName}${SEP}`
    for (const key of [...this.sessionsByKind.keys()]) {
      if (key.startsWith(prefix)) this.sessionsByKind.delete(key)
    }
    for (const key of [...this.sessionsByOwner.keys()]) {
      if (key.startsWith(prefix)) this.sessionsByOwner.delete(key)
    }
    for (const key of [...this.ownersByKind.keys()]) {
      if (key.startsWith(prefix)) this.ownersByKind.delete(key)
    }
    this.permissionsByWorkspace.delete(workspaceName)
    this.todosByWorkspace.delete(workspaceName)
    this.deliveriesByWorkspace.delete(workspaceName)
  }

  private indexedWorkspaces(): Set<string> {
    const names = new Set<string>(this.sessionsByWorkspace.keys())
    for (const key of this.ownersByKind.keys()) {
      const sep = key.indexOf(SEP)
      if (sep > 0) names.add(key.slice(0, sep))
    }
    for (const ws of this.permissionsByWorkspace.keys()) names.add(ws)
    for (const ws of this.todosByWorkspace.keys()) names.add(ws)
    for (const ws of this.deliveriesByWorkspace.keys()) names.add(ws)
    return names
  }

  private snapshotSummaries(): Map<string, WorkspaceActivitySummary> {
    const out = new Map<string, WorkspaceActivitySummary>()
    for (const ws of this.indexedWorkspaces()) out.set(ws, this.summaryFor(ws))
    return out
  }

  private bumpIfChanged(before: Map<string, WorkspaceActivitySummary>): void {
    const after = this.snapshotSummaries()
    const affected = new Set<string>([...before.keys(), ...after.keys()])
    let changed = false
    for (const ws of affected) {
      if (!summariesEqual(before.get(ws) ?? emptySummary(), after.get(ws) ?? emptySummary())) {
        changed = true
      }
    }
    if (changed) this.revision += 1
  }

  private clearActivityIndexes(): void {
    this.sessionsByWorkspace.clear()
    this.sessionsByKind.clear()
    this.sessionsByOwner.clear()
    this.ownersByKind.clear()
  }

  private clearAttentionIndexes(): void {
    this.permissionsByWorkspace.clear()
    this.todosByWorkspace.clear()
    this.deliveriesByWorkspace.clear()
  }

  private clearAll(): void {
    this.clearActivityIndexes()
    this.clearAttentionIndexes()
  }
}
