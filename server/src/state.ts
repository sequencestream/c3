/**
 * Persisted c3 state — the bits the Agent SDK does NOT track for us:
 *   1. the workspace registry (which directories the user added) + recent-access order,
 *   2. each session's permission mode,
 *   3. the last active session (so the UI can restore its view on boot).
 *
 * Sessions themselves (existence, history, titles) live in the SDK's transcript
 * store and are read via `sessions.ts`; we never duplicate them here.
 *
 * Stored at `${CLAUDE_CONFIG_DIR:-~/.claude}/c3/state.json`, written atomically.
 * On any read/parse error we fall back to empty state — c3 must still boot.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { CodexPolicy, ModeToken, VendorId, WorkspaceInfo } from '@ccc/shared/protocol'
import type { SkillSupportReport } from './kernel/agent/adapters/types.js'

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

/**
 * Internal workspace record stored in state.json.
 * Carries both the opaque `id` (wire identity) and the absolute `path`
 * (filesystem location). The wire-facing {@link WorkspaceInfo} exposes
 * only `id` / `name` / `lastAccessed`.
 */
interface PersistedWorkspaceRecord {
  id: string
  path: string
  name: string
  lastAccessed: number
}

interface PersistedState {
  version: 2
  workspaces: PersistedWorkspaceRecord[]
  sessionModes: Record<string, ModeToken>
  /** Codex dual-policy config per session (2026-06-08). */
  sessionCodexPolicies: Record<string, CodexPolicy>
  activeSessionId: string | null
  /** Cached per-vendor SKILL-discovery support, invalidated on SDK-version change. */
  skillSupport: Record<string, SkillSupportReport>
  /** Built skill mounts, keyed by `${projectDir}:${vendor}:${id}` (the idempotency key). */
  skillLinkIndex: Record<string, SkillLinkRecord>
  /** Human acks for skill-load gates (the one-time `.gitignore` append, keyed by projectDir). */
  skillAcks: Record<string, SkillAckRecord>
}

const DEFAULT_MODE: ModeToken = 'default'

function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR
    ? resolve(process.env.CLAUDE_CONFIG_DIR)
    : join(homedir(), '.claude')
}

function stateFile(): string {
  return join(configDir(), 'c3', 'state.json')
}

function emptyState(): PersistedState {
  return {
    version: 2,
    workspaces: [],
    sessionModes: {},
    sessionCodexPolicies: {},
    activeSessionId: null,
    skillSupport: {},
    skillLinkIndex: {},
    skillAcks: {},
  }
}

let cache: PersistedState | null = null

function load(): PersistedState {
  if (cache) return cache
  try {
    const raw = readFileSync(stateFile(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<PersistedState> & { version?: number }
    const rawWorkspaces = Array.isArray(parsed.workspaces) ? parsed.workspaces : []

    // v1→v2 migration: assign a random id to any workspace that lacks one
    // while keeping the internal `path` field for lookups.
    const workspaces: PersistedWorkspaceRecord[] = rawWorkspaces.map((w) => {
      const rec = w as unknown as Partial<PersistedWorkspaceRecord>
      return {
        id: rec.id ?? randomUUID(),
        path: rec.path as string,
        name: rec.name as string,
        lastAccessed: rec.lastAccessed as number,
      }
    })

    cache = {
      version: 2,
      workspaces,
      sessionModes:
        parsed.sessionModes && typeof parsed.sessionModes === 'object' ? parsed.sessionModes : {},
      sessionCodexPolicies:
        parsed.sessionCodexPolicies && typeof parsed.sessionCodexPolicies === 'object'
          ? parsed.sessionCodexPolicies
          : {},
      activeSessionId: typeof parsed.activeSessionId === 'string' ? parsed.activeSessionId : null,
      // New skill-mount fields (mount layer 2/3); a pre-existing state.json lacks
      // them, so default to empty — version stays 1, no migration needed.
      skillSupport:
        parsed.skillSupport && typeof parsed.skillSupport === 'object' ? parsed.skillSupport : {},
      skillLinkIndex:
        parsed.skillLinkIndex && typeof parsed.skillLinkIndex === 'object'
          ? parsed.skillLinkIndex
          : {},
      skillAcks: parsed.skillAcks && typeof parsed.skillAcks === 'object' ? parsed.skillAcks : {},
    }
  } catch {
    // Missing or corrupt — start clean rather than crash.
    cache = emptyState()
  }
  return cache
}

function persist(): void {
  const file = stateFile()
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(load(), null, 2), 'utf-8')
    renameSync(tmp, file)
  } catch (err) {
    console.error('[c3] failed to persist state:', err)
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

/** Workspaces sorted by most-recently-accessed first. */
export function listWorkspaces(): WorkspaceInfo[] {
  return [...load().workspaces]
    .sort((a, b) => b.lastAccessed - a.lastAccessed)
    .map((w) => ({ id: w.id, name: w.name, lastAccessed: w.lastAccessed }))
}

export function hasWorkspace(path: string): boolean {
  return load().workspaces.some((w) => w.path === resolve(path))
}

export function hasWorkspaceId(id: string): boolean {
  return load().workspaces.some((w) => w.id === id)
}

/**
 * Resolve an opaque workspace id to its resolved absolute path on disk.
 * Returns null when the id is unknown (not registered or forged).
 * This is the SINGLE entry point for all feature handlers to get the
 * filesystem root from a wire-level workspaceId.
 */
export function resolveWorkspaceRoot(id: string): string | null {
  const w = load().workspaces.find((x) => x.id === id)
  return w ? w.path : null
}

/**
 * Reverse lookup: given an absolute path, return its opaque workspace id.
 * Returns null when the path is not a registered workspace.
 */
export function pathToId(path: string): string | null {
  const abs = resolve(path)
  const w = load().workspaces.find((x) => x.path === abs)
  return w ? w.id : null
}

/**
 * Register a directory as a workspace (idempotent). Assigns a random opaque
 * id on first registration. Returns the absolute path, or null if it is
 * not an existing directory.
 */
export function addWorkspace(path: string, now: number): string | null {
  const abs = resolve(path)
  if (!isDirectory(abs)) return null
  const state = load()
  const existing = state.workspaces.find((w) => w.path === abs)
  if (existing) {
    existing.lastAccessed = now
  } else {
    state.workspaces.push({
      id: randomUUID(),
      path: abs,
      name: basename(abs) || abs,
      lastAccessed: now,
    })
  }
  persist()
  return abs
}

export function removeWorkspace(path: string): void {
  const abs = resolve(path)
  const state = load()
  state.workspaces = state.workspaces.filter((w) => w.path !== abs)
  persist()
}

/** Bump a workspace's recent-access timestamp (re-sorts the sidebar). */
export function touchWorkspace(path: string, now: number): void {
  const abs = resolve(path)
  const w = load().workspaces.find((x) => x.path === abs)
  if (w) {
    w.lastAccessed = now
    persist()
  }
}

/**
 * The stored permission mode for a session, or `fallback` when none was ever
 * persisted (2026-06-07-017). Without an explicit fallback, returns the built-in
 * `'default'` — callers that know the session's vendor should pass the per-vendor
 * project default (see `getDefaultMode` in config/index.ts).
 */
export function getSessionMode(sessionId: string, fallback?: ModeToken): ModeToken {
  return load().sessionModes[sessionId] ?? fallback ?? DEFAULT_MODE
}

export function setSessionMode(sessionId: string, mode: ModeToken): void {
  load().sessionModes[sessionId] = mode
  persist()
}

export function deleteSessionMode(sessionId: string): void {
  delete load().sessionModes[sessionId]
  persist()
}

// ---- Codex dual-policy persistence (2026-06-08) ----

export function getSessionCodexPolicy(sessionId: string): CodexPolicy | undefined {
  return load().sessionCodexPolicies[sessionId]
}

export function setSessionCodexPolicy(sessionId: string, policy: CodexPolicy): void {
  load().sessionCodexPolicies[sessionId] = policy
  persist()
}

export function deleteSessionCodexPolicy(sessionId: string): void {
  delete load().sessionCodexPolicies[sessionId]
  persist()
}

export function getActiveSessionId(): string | null {
  return load().activeSessionId
}

export function setActiveSessionId(sessionId: string | null): void {
  load().activeSessionId = sessionId
  persist()
}

// ---------------------------------------------------------------------------
// Skill mount state (mount layer 2/3, ADR-0016/0017)
// ---------------------------------------------------------------------------

/** The idempotency / mount key for a `(projectDir, vendor, id)` triple. */
export function skillLinkKey(projectDir: string, vendor: VendorId, id: string): string {
  return `${resolve(projectDir)}:${vendor}:${id}`
}

export function getSkillSupport(vendor: VendorId): SkillSupportReport | undefined {
  return load().skillSupport[vendor]
}

export function setSkillSupport(vendor: VendorId, report: SkillSupportReport): void {
  load().skillSupport[vendor] = report
  persist()
}

export function getSkillLink(key: string): SkillLinkRecord | undefined {
  return load().skillLinkIndex[key]
}

export function setSkillLink(key: string, record: SkillLinkRecord): void {
  load().skillLinkIndex[key] = record
  persist()
}

export function getSkillAck(key: string): SkillAckRecord | undefined {
  return load().skillAcks[key]
}

/** Merge-write a skill ack (partial fields preserved). */
export function setSkillAck(key: string, patch: SkillAckRecord): void {
  const state = load()
  state.skillAcks[key] = { ...state.skillAcks[key], ...patch }
  persist()
}

/** Test-only: drop the in-memory cache so the next call re-reads from disk. */
export function resetStateCacheForTests(): void {
  cache = null
}
