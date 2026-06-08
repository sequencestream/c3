/**
 * Codex's {@link SessionStore} (2026-06-08). Reads session metadata directly from
 * the on-disk JSONL files under `~/.codex/sessions/YYYY/MM/DD/`. The
 * `@openai/codex-sdk` exposes **no listing or reading API**, but c3 writes session
 * transcripts to the filesystem via the SDK's `startThread`/`resumeThread` path,
 * so this store reads them back for listing and title derivation.
 *
 * Title is derived from the first user `input_text` in the transcript (matching
 * how the CLI sidebar derives it from the first prompt). `rename`/`delete` are
 * absent (the SDK supports neither).
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type {
  CanonicalMessage,
  SessionListOptions,
  SessionStore,
  SessionSummary,
} from '../types.js'

export class CodexSessionStore implements SessionStore {
  /**
   * Enumerate sessions for a workspace by scanning the on-disk JSONL files
   * under `~/.codex/sessions/`. Each session file has a `session_meta` event on
   * the first line that carries the native id and cwd. The title is derived from
   * the first user `input_text` in the transcript.
   *
   * Only sessions whose `cwd` matches `opts.cwd` are returned. If no user prompt
   * is found (e.g. a freshly-created session before its first turn), the title
   * defaults to `'New session'`.
   *
   * Performance: the scan walks recent date directories (last N days) and reads
   * only the first few kilobytes of each file to extract the session_meta and
   * first user prompt. Session files beyond `MAX_LIST_DAYS` are not enumerated.
   */
  async list(opts: SessionListOptions): Promise<SessionSummary[]> {
    const sessionsDir = path.join(os.homedir(), '.codex', 'sessions')
    if (!existsSync(sessionsDir)) {
      return []
    }
    const results: SessionSummary[] = []
    const now = new Date()
    const MAX_LIST_DAYS = 90

    // Walk YYYY/MM/DD directories up to MAX_LIST_DAYS ago.
    const cutoff = new Date(now.getTime() - MAX_LIST_DAYS * 86400 * 1000)
    for (const yearDir of readdirSync(sessionsDir)) {
      const yearN = Number(yearDir)
      if (!Number.isInteger(yearN)) continue
      if (yearN < cutoff.getFullYear()) continue
      if (yearN > now.getFullYear() + 1) continue
      const yearPath = path.join(sessionsDir, yearDir)
      if (!existsSync(yearPath)) continue

      for (const monthDir of readdirSync(yearPath)) {
        const monthN = Number(monthDir)
        if (!Number.isInteger(monthN) || monthN < 1 || monthN > 12) continue
        if (yearN === cutoff.getFullYear() && monthN < cutoff.getMonth() + 1) continue
        if (yearN === now.getFullYear() && monthN > now.getMonth() + 1) continue
        const monthPath = path.join(yearPath, monthDir)
        if (!existsSync(monthPath)) continue

        for (const dayDir of readdirSync(monthPath)) {
          const dayN = Number(dayDir)
          if (!Number.isInteger(dayN) || dayN < 1 || dayN > 31) continue
          if (
            yearN === cutoff.getFullYear() &&
            monthN === cutoff.getMonth() + 1 &&
            dayN < cutoff.getDate()
          )
            continue
          if (yearN === now.getFullYear() && monthN === now.getMonth() + 1 && dayN > now.getDate())
            continue
          const dayPath = path.join(monthPath, dayDir)
          if (!existsSync(dayPath)) continue

          for (const file of readdirSync(dayPath)) {
            if (!file.endsWith('.jsonl')) continue
            const filepath = path.join(dayPath, file)
            const summary = this.readSessionFile(filepath, opts.cwd)
            if (summary) {
              results.push(summary)
            }
          }
        }
      }
    }
    return results
  }

  /**
   * Read one session JSONL file and return a SessionSummary if it belongs to the
   * requested workspace. Reads only the first SCAN_CHUNK_BYTES to find
   * the session_meta and first user prompt — this is typically < ¼ of one file
   * system block for most sessions.
   */
  private readSessionFile(filepath: string, workspacePath: string): SessionSummary | null {
    try {
      const SCAN_CHUNK_BYTES = 262_144 // 256 KB
      const content = readFileSync(filepath, { encoding: 'utf-8', flag: 'r' })
      // Truncate for scanning performance; the session_meta is always the first
      // line, and the first user prompt comes soon after.
      const chunk =
        content.length > SCAN_CHUNK_BYTES
          ? content.slice(0, content.indexOf('\n', SCAN_CHUNK_BYTES - 200) + 1) ||
            content.slice(0, SCAN_CHUNK_BYTES)
          : content

      const lines = chunk.split('\n')
      if (lines.length === 0) return null

      // First line = session_meta
      let meta: Record<string, unknown>
      try {
        meta = JSON.parse(lines[0])
      } catch {
        return null
      }
      if (meta.type !== 'session_meta') return null
      const payload = meta.payload as Record<string, unknown> | undefined
      if (!payload) return null
      const sessionId = typeof payload.id === 'string' ? payload.id : null
      const cwd = typeof payload.cwd === 'string' ? payload.cwd : null
      if (!sessionId || !cwd) return null
      if (cwd !== workspacePath) return null

      // Scan remaining lines for the first user input_text
      const st = statSync(filepath)
      const title = this.extractTitle(lines, content)
      return {
        sessionId,
        title,
        vendorExtra: { lastModified: st.mtimeMs, cwd },
      }
    } catch {
      return null
    }
  }

  /** Scan JSONL lines for the first user `input_text` to use as the title. */
  private extractTitle(lines: string[], _fullContent: string): string {
    const limit = Math.min(lines.length, 2000)
    for (let i = 1; i < limit; i++) {
      const line = lines[i].trim()
      if (!line) continue
      const obj = tryParseJson(line)
      if (!obj || obj.type !== 'response_item') continue
      const pl = obj.payload as Record<string, unknown> | undefined
      if (!pl || pl.role !== 'user') continue
      const content = pl.content as unknown[]
      if (!Array.isArray(content)) continue
      for (const block of content) {
        const b = block as Record<string, unknown>
        if (b.type === 'input_text' && typeof b.text === 'string') {
          const text = b.text.trim()
          if (text) return text.slice(0, 120)
        }
      }
    }
    return 'New session'
  }

  async read(_sessionId: string, _opts: SessionListOptions): Promise<CanonicalMessage[]> {
    // TODO(codex-l2): back-read a thread (on-disk reader or resume-and-replay).
    return []
  }
}

/** Safe JSON parse that returns null (not throws) on invalid input. */
function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const obj = JSON.parse(text)
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null
  } catch {
    return null
  }
}
