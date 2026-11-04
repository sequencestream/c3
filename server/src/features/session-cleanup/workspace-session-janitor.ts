import { readdir } from 'node:fs/promises'
import { rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { deleteSessionAgentId, loadWorkspaceSetting } from '../../kernel/config/index.js'
import {
  hostClaudeConfigDir,
  hostCodexHome,
  relayCodexHome,
} from '../../kernel/config/workspace-path.js'
import { listWorkspaceRows } from '../../kernel/config/workspace-store.js'
import {
  deleteByVendorId,
  getByC3Id,
  listAll,
  type SessionMetadataRow,
} from '../sessions/session-metadata-store.js'
import { deleteChatSession, deleteToolSessionRecord } from '../intents/store.js'
import { listActiveSessionsForWorkspace } from '../works/active-workspace-sessions.js'
import { isRunning, removeRuntime, sessionLastActivityAt } from '../../runs.js'
import {
  deleteSessionCodexPolicy,
  deleteSessionMode,
  getActiveSessionId,
  setActiveSessionId,
} from '../../state.js'

const DAY_MS = 86_400_000
const INITIAL_DELAY_MS = 60_000

interface Candidate {
  row: SessionMetadataRow
  files: string[]
}

/** Scan only transcript trees; symlinks and all unrelated vendor data are ignored. */
async function collectFiles(
  dir: string,
  candidates: Map<string, Candidate>,
  vendor: 'claude' | 'codex',
  owner?: Candidate,
): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      // Claude stores subagent transcripts in a directory named for the parent.
      await collectFiles(
        path,
        candidates,
        vendor,
        owner ?? (vendor === 'claude' ? candidates.get(entry.name) : undefined),
      )
    } else if (entry.isFile()) {
      const id =
        vendor === 'claude'
          ? entry.name.replace(/\.jsonl$/, '')
          : entry.name.match(/^rollout-.*-([0-9a-f-]{36})\.jsonl$/i)?.[1]
      const candidate =
        owner ?? (entry.name.endsWith('.jsonl') && id ? candidates.get(id) : undefined)
      candidate?.files.push(path)
    }
  }
}

function lastActivity(row: SessionMetadataRow): number {
  return Math.max(
    row.lastModified ?? row.stateUpdatedAt,
    (row.vendorSessionId ? sessionLastActivityAt(row.vendorSessionId) : null) ?? 0,
  )
}

/** Delete expired, bound c3 sessions. Native sessions outside c3 are never selected. */
export async function runWorkspaceSessionPruneOnce(opts: { now?: number } = {}): Promise<number> {
  const now = opts.now ?? Date.now()
  let removed = 0
  try {
    const workspaces = new Map(listWorkspaceRows().map((ws) => [ws.path, ws]))
    const candidates = { claude: new Map<string, Candidate>(), codex: new Map<string, Candidate>() }
    for (const row of listAll()) {
      if (!row.bound || !row.vendorSessionId || !workspaces.has(row.workspacePath)) continue
      if (row.vendor !== 'claude' && row.vendor !== 'codex') continue
      const days = loadWorkspaceSetting(row.workspacePath).sessionRetentionDays ?? 15
      if (isRunning(row.vendorSessionId) || lastActivity(row) >= now - days * DAY_MS) continue
      candidates[row.vendor].set(row.vendorSessionId, { row, files: [] })
    }
    for (const vendor of ['claude', 'codex'] as const) {
      if (!candidates[vendor].size) continue
      try {
        const roots =
          vendor === 'claude'
            ? [join(hostClaudeConfigDir(), 'projects')]
            : [...new Set([hostCodexHome(), relayCodexHome()])].map((root) =>
                join(root, 'sessions'),
              )
        for (const root of roots) await collectFiles(root, candidates[vendor], vendor)
      } catch (err) {
        console.warn(`[c3:workspace-session-cleanup] ${vendor} scan failed:`, err)
        continue
      }
      const active = new Set(
        [...workspaces.keys()].flatMap((path) =>
          listActiveSessionsForWorkspace(path).map((session) => session.sessionId),
        ),
      )
      for (const { row, files } of candidates[vendor].values()) {
        try {
          // Re-read after asynchronous scanning: a session may have resumed or
          // its workspace's retention may have changed while the scan yielded.
          const sessionId = row.vendorSessionId
          if (!sessionId || active.has(sessionId)) continue
          const current = getByC3Id(row.c3Id)
          if (!current?.bound || isRunning(sessionId)) continue
          const days = loadWorkspaceSetting(row.workspacePath).sessionRetentionDays ?? 15
          const cutoff = now - days * DAY_MS
          if (lastActivity(current) >= cutoff) continue
          // Native writes outside c3 also extend retention. No await between
          // this guard and deletion, so c3 cannot start a run in that gap.
          if (files.some((file) => statSync(file).mtimeMs >= cutoff)) continue
          for (const file of files) rmSync(file, { force: true })
          deleteChatSession(row.workspacePath, sessionId)
          deleteToolSessionRecord(sessionId)
          deleteSessionMode(sessionId)
          deleteSessionCodexPolicy(sessionId)
          deleteSessionAgentId(sessionId)
          deleteByVendorId(vendor, sessionId)
          removeRuntime(sessionId)
          if (getActiveSessionId() === row.vendorSessionId) setActiveSessionId(null)
          removed++
        } catch (err) {
          console.warn(`[c3:workspace-session-cleanup] skipped ${row.c3Id}:`, err)
        }
      }
    }
  } catch (err) {
    console.warn('[c3:workspace-session-cleanup] sweep failed:', err)
  }
  if (removed) console.log(`[c3:workspace-session-cleanup] removed ${removed} expired session(s)`)
  return removed
}

let timer: ReturnType<typeof setTimeout> | undefined
let generation = 0

/** A delayed startup sweep, then one sweep daily, without overlapping runs. */
export function startWorkspaceSessionJanitor(): void {
  stopWorkspaceSessionJanitor()
  const current = generation
  const tick = async (): Promise<void> => {
    await runWorkspaceSessionPruneOnce()
    if (current !== generation) return
    timer = setTimeout(() => void tick(), DAY_MS)
    timer.unref?.()
  }
  timer = setTimeout(() => void tick(), INITIAL_DELAY_MS)
  timer.unref?.()
}

export function stopWorkspaceSessionJanitor(): void {
  generation++
  if (timer) clearTimeout(timer)
  timer = undefined
}
