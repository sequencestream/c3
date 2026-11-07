/**
 * DSH {@link SessionStore} — reads persisted session headers under the workspace
 * DSH_HOME when the on-disk index is present; otherwise returns an empty list.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type {
  CanonicalMessage,
  SessionListOptions,
  SessionStore,
  SessionSummary,
} from '../types.js'
import { hostDshHome } from '../../../config/workspace-path.js'

function sessionIndexRoot(dshHome: string): string {
  return join(dshHome, 'var', 'persisted-sessions')
}

function tryReadTitle(dir: string, sessionId: string): string {
  try {
    const raw = readFileSync(join(dir, 'header.json'), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { title?: unknown }).title === 'string'
    ) {
      const title = (parsed as { title: string }).title.trim()
      if (title) return title
    }
  } catch {
    /* empty */
  }
  return sessionId
}

export class DshSessionStore implements SessionStore {
  async list(opts: SessionListOptions): Promise<SessionSummary[]> {
    const root = sessionIndexRoot(hostDshHome(opts.cwd))
    if (!existsSync(root)) return []
    const out: SessionSummary[] = []
    let entries: string[]
    try {
      entries = readdirSync(root)
    } catch {
      return []
    }
    for (const sessionId of entries) {
      const dir = join(root, sessionId)
      try {
        if (!statSync(dir).isDirectory()) continue
      } catch {
        continue
      }
      out.push({ sessionId, title: tryReadTitle(dir, sessionId) })
    }
    return out
  }

  async read(_sessionId: string, _opts: SessionListOptions): Promise<CanonicalMessage[]> {
    return []
  }
}
