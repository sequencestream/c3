/**
 * DSH {@link SessionStore} — enumerates the sessions its JSONL persistence
 * backend wrote under the workspace DSH_HOME.
 *
 * The backend roots at `$DSH_HOME/sessions` and lays each session out as
 * `<project key>/<escaped session id>/`; the header line inside carries no
 * title (titles are a logged projection), so the id stands in for one. Read
 * back as canonical messages is not implemented: DSH's generations are
 * compressed, and live runs own the transcript fact source.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  CanonicalMessage,
  SessionListOptions,
  SessionStore,
  SessionSummary,
} from '../types.js'
import { hostDshHome } from '../../../config/workspace-path.js'

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

export class DshSessionStore implements SessionStore {
  async list(opts: SessionListOptions): Promise<SessionSummary[]> {
    const root = sessionRoot(hostDshHome(opts.cwd))
    if (!existsSync(root)) return []
    const out: SessionSummary[] = []
    for (const project of subdirectories(root)) {
      for (const segment of subdirectories(join(root, project))) {
        const sessionId = decodeSegment(segment)
        out.push({ sessionId, title: sessionId })
      }
    }
    return out
  }

  async read(_sessionId: string, _opts: SessionListOptions): Promise<CanonicalMessage[]> {
    return []
  }
}
