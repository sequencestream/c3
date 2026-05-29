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

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { PermissionMode, WorkspaceInfo } from '@ccc/shared/protocol'

interface PersistedState {
  version: 1
  workspaces: WorkspaceInfo[]
  sessionModes: Record<string, PermissionMode>
  activeSessionId: string | null
}

const DEFAULT_MODE: PermissionMode = 'default'

function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR
    ? resolve(process.env.CLAUDE_CONFIG_DIR)
    : join(homedir(), '.claude')
}

function stateFile(): string {
  return join(configDir(), 'c3', 'state.json')
}

function emptyState(): PersistedState {
  return { version: 1, workspaces: [], sessionModes: {}, activeSessionId: null }
}

let cache: PersistedState | null = null

function load(): PersistedState {
  if (cache) return cache
  try {
    const raw = readFileSync(stateFile(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<PersistedState>
    cache = {
      version: 1,
      workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces : [],
      sessionModes:
        parsed.sessionModes && typeof parsed.sessionModes === 'object' ? parsed.sessionModes : {},
      activeSessionId: typeof parsed.activeSessionId === 'string' ? parsed.activeSessionId : null,
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
  return [...load().workspaces].sort((a, b) => b.lastAccessed - a.lastAccessed)
}

export function hasWorkspace(path: string): boolean {
  return load().workspaces.some((w) => w.path === resolve(path))
}

/**
 * Register a directory as a workspace (idempotent). Returns the absolute path,
 * or null if it is not an existing directory.
 */
export function addWorkspace(path: string, now: number): string | null {
  const abs = resolve(path)
  if (!isDirectory(abs)) return null
  const state = load()
  const existing = state.workspaces.find((w) => w.path === abs)
  if (existing) {
    existing.lastAccessed = now
  } else {
    state.workspaces.push({ path: abs, name: basename(abs) || abs, lastAccessed: now })
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

export function getSessionMode(sessionId: string): PermissionMode {
  return load().sessionModes[sessionId] ?? DEFAULT_MODE
}

export function setSessionMode(sessionId: string, mode: PermissionMode): void {
  load().sessionModes[sessionId] = mode
  persist()
}

export function deleteSessionMode(sessionId: string): void {
  delete load().sessionModes[sessionId]
  persist()
}

export function getActiveSessionId(): string | null {
  return load().activeSessionId
}

export function setActiveSessionId(sessionId: string | null): void {
  load().activeSessionId = sessionId
  persist()
}

/** Test-only: drop the in-memory cache so the next call re-reads from disk. */
export function resetStateCacheForTests(): void {
  cache = null
}
