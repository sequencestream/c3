/**
 * DSH {@link SessionStore} — enumerates the sessions its JSONL persistence
 * backend wrote under the workspace DSH_HOME.
 *
 * The backend roots at `$DSH_HOME/sessions` and lays each session out as
 * `<project key>/<escaped session id>/`. The log itself is compressed and
 * carries no display title; the accepted name lives in the projection cache
 * (`storages/session_projcache/sessions/<id>.json`). That name is a generated
 * summary when DSH has one, otherwise a shortened slice of the first user
 * message. Listing prefers the summary, and falls back to the first user
 * message when the stored name is only that slice. Read-back as canonical
 * messages is not implemented: live runs own the transcript fact source.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type {
  CanonicalMessage,
  SessionListOptions,
  SessionStore,
  SessionSummary,
} from '../types.js'
import { hostDshHome } from '../../../config/workspace-path.js'

/** Sidebar title cap, matching the other vendors' first-prompt titles. */
const DISPLAY_TITLE_LIMIT = 120

/** Projection placeholder. A session with no usable name stays on this. */
const PLACEHOLDER_TITLE = 'New session'

const PLACEHOLDER_TITLES = new Set([PLACEHOLDER_TITLE, 'Untitled session'])

/** Root the JSONL backend is configured with (`dshHomePath('sessions')`). */
function sessionRoot(dshHome: string): string {
  return join(dshHome, 'sessions')
}

/** Inverse of DSH's `~XXXX` path-segment escape. */
function decodeSegment(raw: string): string {
  return raw.replace(/~([0-9A-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}

/** Immediate subdirectory names of `dir`; an unreadable dir lists as empty. */
function subdirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function clampTitle(text: string): string {
  return text.length > DISPLAY_TITLE_LIMIT ? text.slice(0, DISPLAY_TITLE_LIMIT) : text
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function projectionRecord(cache: unknown): Record<string, unknown> | null {
  if (!isRecord(cache)) return null
  return isRecord(cache.record) ? cache.record : null
}

function projectionRows(cache: unknown): Record<string, unknown> | null {
  const record = projectionRecord(cache)
  if (!record || !isRecord(record.rows)) return null
  return record.rows
}

/** A projection cell's `val` when it is a non-empty string. */
function cellString(cell: unknown): string | null {
  if (!isRecord(cell) || typeof cell.val !== 'string') return null
  const text = flatten(cell.val)
  return text || null
}

/** `titleInput.val.first.text` — the first eligible human message. */
function firstUserText(cell: unknown): string | null {
  if (!isRecord(cell) || !isRecord(cell.val)) return null
  const first = cell.val.first
  if (!isRecord(first) || typeof first.text !== 'string') return null
  const text = flatten(first.text)
  return text || null
}

/**
 * The stored title is DSH's deterministic fallback when it is only a leading
 * slice of the first user message. A generated summary or an explicit rename
 * diverges from that message.
 */
function isLeadingSlice(message: string, title: string): boolean {
  return message === title || message.startsWith(title)
}

/**
 * Display title for one projection-cache document.
 *
 * Prefers the accepted title when it is a real summary or rename. When that
 * cell is missing, still a placeholder, or only the shortened first message,
 * the first user message is the name. Neither source yields a placeholder.
 */
export function dshSessionTitle(cache: unknown): string {
  const rows = projectionRows(cache)
  const acceptedRaw = cellString(rows?.title)
  const accepted = acceptedRaw && !PLACEHOLDER_TITLES.has(acceptedRaw) ? acceptedRaw : null
  const first = firstUserText(rows?.titleInput)
  if (accepted && !(first && isLeadingSlice(first, accepted))) return clampTitle(accepted)
  if (first) return clampTitle(first)
  return PLACEHOLDER_TITLE
}

function finiteMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null
}

/** Last activity time from the cache, else the session's creation time. */
function projectionActivityMs(cache: unknown): number | null {
  const rows = projectionRows(cache)
  const time = rows?.timeContext
  if (isRecord(time) && isRecord(time.val)) {
    const last = finiteMs(time.val.lastMessageTime)
    if (last !== null) return last
  }
  const identity = projectionRecord(cache)?.identity
  if (isRecord(identity)) {
    const created = finiteMs(identity.createdAt)
    if (created !== null) return created
  }
  return null
}

/** Cache files are named by the raw session id; refuse a path-shaped id. */
function projectionCachePath(dshHome: string, sessionId: string): string | null {
  if (
    !sessionId ||
    sessionId.includes('/') ||
    sessionId.includes('\\') ||
    sessionId.includes('..')
  ) {
    return null
  }
  return join(dshHome, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
}

function readProjectionCache(dshHome: string, sessionId: string): unknown {
  const path = projectionCachePath(dshHome, sessionId)
  if (!path || !existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return null
  }
}

function directoryMtime(dir: string): number {
  try {
    return Math.trunc(statSync(dir).mtimeMs)
  } catch {
    return 0
  }
}

export class DshSessionStore implements SessionStore {
  async list(opts: SessionListOptions): Promise<SessionSummary[]> {
    const dshHome = hostDshHome(opts.cwd)
    const root = sessionRoot(dshHome)
    if (!existsSync(root)) return []
    const out: SessionSummary[] = []
    for (const project of subdirectories(root)) {
      const projectDir = join(root, project)
      for (const segment of subdirectories(projectDir)) {
        const sessionId = decodeSegment(segment)
        const cache = readProjectionCache(dshHome, sessionId)
        out.push({
          sessionId,
          title: dshSessionTitle(cache),
          vendorExtra: {
            lastModified: projectionActivityMs(cache) ?? directoryMtime(join(projectDir, segment)),
            cwd: opts.cwd,
          },
        })
      }
    }
    return out
  }

  async read(_sessionId: string, _opts: SessionListOptions): Promise<CanonicalMessage[]> {
    return []
  }
}
