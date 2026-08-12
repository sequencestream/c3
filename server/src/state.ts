/**
 * Persisted c3 state — the bits the Agent SDK does NOT track for us:
 *   1. the workspace registry (which directories the user added) + recent-access order,
 *   2. each session's permission mode,
 *   3. the last active session (so the UI can restore its view on boot),
 *   4. the skill-mount index and its one-time acks.
 *
 * Sessions themselves (existence, history, titles) live in the SDK's transcript
 * store and are read via `sessions.ts`; we never duplicate them here.
 *
 * Stored in `c3.db`: workspaces in their own table (the id a workspace's whole
 * configuration hangs off), per-session values in `session_configs`, and the global
 * remainder under the `state.*` namespace of `system_configs`. Formerly
 * `${CLAUDE_CONFIG_DIR:-~/.claude}/c3/state.json`, imported once on first boot.
 * On any read error we fall back to empty state — c3 must still boot.
 */

import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { CodexPolicy, ModeToken, VendorId, WorkspaceInfo } from '@ccc/shared/protocol'
import type { SkillSupportReport } from './kernel/agent/adapters/types.js'
import { fromEntries, toEntries } from './kernel/config/config-codec.js'
import { SESSION_KEYS, STATE_KEYS, SYSTEM_RULES } from './kernel/config/config-schema.js'
import { deleteKeys, readAllScopes, readScope, writeScope } from './kernel/config/config-store.js'
import {
  listWorkspaceRows,
  registerWorkspace,
  touchWorkspaceRow,
  unregisterWorkspace,
  findWorkspaceById,
  findWorkspaceByPath,
} from './kernel/config/workspace-store.js'

/**
 * One built skill mount (mount layer 2/3). Keyed in {@link PersistedState.skillLinkIndex}
 * by the idempotency key `${projectDir}:${vendor}:${id}` — one config fans out to one
 * record per build-link-capable vendor, which a bare `id` key could not hold (spec D2).
 * `ref` is the resolved SHA at mount time, compared against `lsRemote` on a later
 * session to detect a content change (cache invalidation → relink).
 */
export interface SkillLinkRecord {
  id: string
  projectDir: string
  vendor: VendorId
  linkPath: string
  target: string
  ref: string
  createdAt: number
}

/**
 * A persisted human ack for a skill-load gate (mount layer 2/3). Stored in
 * {@link PersistedState.skillAcks} keyed by `projectDir`: the `.gitignore` ack
 * (one append per project, then silent) is the only remaining gate now that
 * external skills mount silently.
 */
export interface SkillAckRecord {
  gitignore?: boolean
}

/** The permission mode a session falls back to when none was ever persisted. */
const DEFAULT_MODE: ModeToken = 'default'

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

/** The global remainder of the old state file, kept under `state.*` in system config. */
interface GlobalState {
  activeSessionId: string | null
  skillSupport: Record<string, SkillSupportReport>
  skillLinkIndex: Record<string, SkillLinkRecord>
  skillAcks: Record<string, SkillAckRecord>
}

let globalCache: GlobalState | null = null
/** sessionId → its own `session_configs` values, by key. `null` until first read. */
let sessionCache: Map<string, Record<string, string | null>> | null = null

function globals(): GlobalState {
  if (globalCache) return globalCache
  const rows = readScope({ kind: 'system' }).filter((e) => e.key.startsWith('state.'))
  const decoded = fromEntries(rows, SYSTEM_RULES) as { state?: Partial<GlobalState> }
  const state = decoded.state ?? {}
  globalCache = {
    activeSessionId: typeof state.activeSessionId === 'string' ? state.activeSessionId : null,
    skillSupport: state.skillSupport ?? {},
    skillLinkIndex: state.skillLinkIndex ?? {},
    skillAcks: state.skillAcks ?? {},
  }
  return globalCache
}

/** Write one `state.*` value (a whole subtree for the map-shaped ones). */
function persistGlobal(key: string, value: unknown): void {
  try {
    writeScope({ kind: 'system' }, toEntries(value, SYSTEM_RULES, key), { replace: false })
  } catch (err) {
    console.error('[c3] failed to persist state:', err)
  }
}

function sessions(): Map<string, Record<string, string | null>> {
  if (sessionCache) return sessionCache
  const map = new Map<string, Record<string, string | null>>()
  for (const [sessionId, entries] of readAllScopes('session')) {
    map.set(sessionId, Object.fromEntries(entries.map((e) => [e.key, e.value])))
  }
  sessionCache = map
  return sessionCache
}

function sessionValue(sessionId: string, key: string): string | null {
  return sessions().get(sessionId)?.[key] ?? null
}

/** Set (or, with null, clear) one of a session's own values. */
function setSessionValue(sessionId: string, key: string, value: string | null): void {
  const map = sessions()
  const row = map.get(sessionId) ?? {}
  if (value === null) delete row[key]
  else row[key] = value
  if (Object.keys(row).length === 0) map.delete(sessionId)
  else map.set(sessionId, row)
  try {
    const scope = { kind: 'session' as const, owner: sessionId }
    if (value === null) deleteKeys(scope, [key])
    else writeScope(scope, [{ key, value, type: 'string' }], { replace: false })
  } catch (err) {
    console.error('[c3] failed to persist session state:', err)
  }
}

/** True if `path` is an existing directory. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Workspace registry
// ---------------------------------------------------------------------------

/** Workspaces sorted by most-recently-accessed first. */
export function listWorkspaces(): WorkspaceInfo[] {
  return listWorkspaceRows()
    .sort((a, b) => b.lastAccessed - a.lastAccessed)
    .map((w) => ({ id: w.id, name: w.name, path: w.path, lastAccessed: w.lastAccessed }))
}

export function hasWorkspace(path: string): boolean {
  return findWorkspaceByPath(path)?.registered === true
}

export function hasWorkspaceId(id: string): boolean {
  return findWorkspaceById(id)?.registered === true
}

/**
 * Resolve an opaque workspace id to its resolved absolute path on disk.
 * Returns null when the id is unknown (not registered or forged).
 * This is the SINGLE entry point for all feature handlers to get the
 * filesystem root from a wire-level workspaceId.
 */
export function resolveWorkspaceRoot(id: string): string | null {
  const row = findWorkspaceById(id)
  return row?.registered ? row.path : null
}

/**
 * Reverse lookup: given an absolute path, return its opaque workspace id.
 * Returns null when the path is not a registered workspace.
 */
export function pathToId(path: string): string | null {
  const row = findWorkspaceByPath(path)
  return row?.registered ? row.id : null
}

/**
 * Register a directory as a workspace (idempotent). Reuses the id the directory
 * already had — including one it kept while unregistered — so its configuration comes
 * back with it. Returns the absolute path, or null if it is not an existing directory.
 */
export function addWorkspace(path: string, now: number): string | null {
  const abs = resolve(path)
  if (!isDirectory(abs)) return null
  registerWorkspace(abs, now)
  return abs
}

/**
 * Remove a workspace from the list. Its id and configuration are kept (the row is
 * only unregistered), so re-adding the directory restores the settings it had.
 */
export function removeWorkspace(path: string): void {
  unregisterWorkspace(path)
}

/** Bump a workspace's recent-access timestamp (re-sorts the sidebar). */
export function touchWorkspace(path: string, now: number): void {
  touchWorkspaceRow(path, now)
}

// ---------------------------------------------------------------------------
// Per-session values
// ---------------------------------------------------------------------------

/**
 * The stored permission mode for a session, or `fallback` when none was ever
 * persisted (2026-06-07-017). Without an explicit fallback, returns the built-in
 * `'default'` — callers that know the session's vendor should pass the per-vendor
 * project default (see `getDefaultMode` in config/index.ts).
 */
export function getSessionMode(sessionId: string, fallback?: ModeToken): ModeToken {
  return sessionValue(sessionId, SESSION_KEYS.mode) ?? fallback ?? DEFAULT_MODE
}

export function setSessionMode(sessionId: string, mode: ModeToken): void {
  setSessionValue(sessionId, SESSION_KEYS.mode, mode)
}

export function deleteSessionMode(sessionId: string): void {
  setSessionValue(sessionId, SESSION_KEYS.mode, null)
}

// ---- Codex dual-policy persistence (2026-06-08) ----

export function getSessionCodexPolicy(sessionId: string): CodexPolicy | undefined {
  const sandboxMode = sessionValue(sessionId, SESSION_KEYS.codexSandboxMode)
  const approvalPolicy = sessionValue(sessionId, SESSION_KEYS.codexApprovalPolicy)
  if (!sandboxMode || !approvalPolicy) return undefined
  return {
    sandboxMode: sandboxMode as CodexPolicy['sandboxMode'],
    approvalPolicy: approvalPolicy as CodexPolicy['approvalPolicy'],
  }
}

export function setSessionCodexPolicy(sessionId: string, policy: CodexPolicy): void {
  setSessionValue(sessionId, SESSION_KEYS.codexSandboxMode, policy.sandboxMode)
  setSessionValue(sessionId, SESSION_KEYS.codexApprovalPolicy, policy.approvalPolicy)
}

export function deleteSessionCodexPolicy(sessionId: string): void {
  setSessionValue(sessionId, SESSION_KEYS.codexSandboxMode, null)
  setSessionValue(sessionId, SESSION_KEYS.codexApprovalPolicy, null)
}

export function getActiveSessionId(): string | null {
  return globals().activeSessionId
}

export function setActiveSessionId(sessionId: string | null): void {
  const state = globals()
  state.activeSessionId = sessionId
  if (sessionId === null) {
    try {
      deleteKeys({ kind: 'system' }, [STATE_KEYS.activeSessionId])
    } catch (err) {
      console.error('[c3] failed to persist state:', err)
    }
    return
  }
  persistGlobal(STATE_KEYS.activeSessionId, sessionId)
}

// ---------------------------------------------------------------------------
// Skill mount state (mount layer 2/3, ADR-0016/0017)
// ---------------------------------------------------------------------------

/** The idempotency / mount key for a `(projectDir, vendor, id)` triple. */
export function skillLinkKey(projectDir: string, vendor: VendorId, id: string): string {
  return `${resolve(projectDir)}:${vendor}:${id}`
}

export function getSkillSupport(vendor: VendorId): SkillSupportReport | undefined {
  return globals().skillSupport[vendor]
}

export function setSkillSupport(vendor: VendorId, report: SkillSupportReport): void {
  const state = globals()
  state.skillSupport[vendor] = report
  // One row per vendor: a probe for one vendor never rewrites another's report.
  persistGlobal(`${STATE_KEYS.skillSupport}.${vendor}`, report)
}

export function getSkillLink(key: string): SkillLinkRecord | undefined {
  return globals().skillLinkIndex[key]
}

export function setSkillLink(key: string, record: SkillLinkRecord): void {
  const state = globals()
  state.skillLinkIndex[key] = record
  // Stored as one JSON row: the map is keyed by `<projectDir>:<vendor>:<id>`, a path
  // rather than a field name, so expanding it would produce unaddressable keys.
  persistGlobal(STATE_KEYS.skillLink, state.skillLinkIndex)
}

export function getSkillAck(key: string): SkillAckRecord | undefined {
  return globals().skillAcks[key]
}

/** Merge-write a skill ack (partial fields preserved). */
export function setSkillAck(key: string, patch: SkillAckRecord): void {
  const state = globals()
  state.skillAcks[key] = { ...state.skillAcks[key], ...patch }
  persistGlobal(STATE_KEYS.skillAcks, state.skillAcks)
}

/** Test-only: drop the in-memory caches so the next call re-reads from the db. */
export function resetStateCacheForTests(): void {
  globalCache = null
  sessionCache = null
}
