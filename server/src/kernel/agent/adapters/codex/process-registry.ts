/**
 * Codex child-process registry and reclamation primitives (2026-09-29-004).
 *
 * c3 drives Codex as one `codex exec` child per turn. When a third-party provider
 * truncates a stream, Codex reports a stream error and exits — but the child can
 * survive, and a survivor keeps the thread's writer lock, so the next
 * `thread/resume` is refused with `already has an active writer` (-32600). This
 * module is the adapter's memory of what it spawned:
 *
 *  - `registerCodexChild` records the pid, the thread id and the process start time
 *    read from the host process table;
 *  - `escalateKill` is the single teardown helper (SIGTERM → poll → SIGKILL →
 *    verify) shared by the turn lifecycle and the resume reclaim path, so the two
 *    never diverge on grace period or outcome vocabulary;
 *  - `reclaimCodexOccupant` locates the process holding a thread's writer lock and
 *    terminates it ONLY when a settled registry record and a matching start time
 *    prove it is a c3 leftover. Anything less becomes a diagnostic, never a signal.
 *
 * The registry is process-local, bounded (oldest-evicted) and best-effort: a lost
 * record degrades to the unknown-owner diagnostic, never to an unsafe kill. The
 * process table and the signal primitives are injectable so tests need neither real
 * processes nor permission to run `ps` — where the table is unreadable c3 reports
 * instead of healing, by design.
 */
import { execFile } from 'node:child_process'

/** How a child that did not exit on its own was disposed of. */
export type CodexReclaimMethod = 'sigterm' | 'sigkill' | 'already-exited' | 'failed'

/** Terminal state of one spawned child: either an observed exit, or a reclamation. */
export interface CodexChildOutcome {
  pid: number
  /** Exit status when the child was observed to exit on its own, else `null`. */
  exitCode: number | null
  /** Terminating signal when the child was signalled, else `null`. */
  signal: NodeJS.Signals | null
  /** Set only when the child did not exit on its own. */
  reclaimedBy?: CodexReclaimMethod
  /** Grace milliseconds waited during escalation (escalation paths only). */
  waitedMs?: number
  /** Failure detail when `reclaimedBy === 'failed'`. */
  reason?: string
}

/** One spawned Codex turn child. `live` until it settles. */
export interface CodexChildRecord {
  pid: number
  /** The Codex thread the child serves; `null` until `thread.started` arrives. */
  threadId: string | null
  /** The c3 session the child serves — the same id as the thread, when known. */
  sessionId: string | null
  spawnedAt: number
  /** Process start time read from the host table; `null` when it could not be read. */
  startTimeMs: number | null
  /** True when the start time could not be captured; excludes the record from reclaim. */
  startTimeUnknown: boolean
  status: 'live' | 'settled'
  outcome?: CodexChildOutcome
}

/** The registry's capacity — oldest entries are evicted past this. */
const MAX_CODEX_CHILD_RECORDS = 256

/** pid → record, in insertion order (Map iteration order is the eviction order). */
const records = new Map<number, CodexChildRecord>()

export interface RegisterCodexChildInput {
  pid: number
  threadId?: string | null
  sessionId?: string | null
  spawnedAt?: number
  startTimeMs?: number | null
}

/** Record a freshly spawned Codex child. Returns the stored record. */
export function registerCodexChild(input: RegisterCodexChildInput): CodexChildRecord {
  const startTimeMs = input.startTimeMs ?? null
  const record: CodexChildRecord = {
    pid: input.pid,
    threadId: input.threadId ?? null,
    sessionId: input.sessionId ?? input.threadId ?? null,
    spawnedAt: input.spawnedAt ?? Date.now(),
    startTimeMs,
    startTimeUnknown: startTimeMs === null,
    status: 'live',
  }
  if (!records.has(record.pid) && records.size >= MAX_CODEX_CHILD_RECORDS) {
    const oldest = records.keys().next()
    if (!oldest.done) records.delete(oldest.value)
  }
  records.set(record.pid, record)
  return record
}

/** Attach the thread id a new child only learns from `thread.started`. */
export function bindCodexChildThread(
  pid: number,
  threadId: string,
  sessionId: string = threadId,
): CodexChildRecord | undefined {
  const record = records.get(pid)
  if (!record) return undefined
  record.threadId = threadId
  record.sessionId = sessionId
  return record
}

/** Mark a child settled with its terminal outcome. Returns the updated record. */
export function settleCodexChild(
  pid: number,
  outcome: CodexChildOutcome,
): CodexChildRecord | undefined {
  const record = records.get(pid)
  if (!record) return undefined
  record.status = 'settled'
  record.outcome = outcome
  return record
}

/** Every record for a thread (or c3 session) id, newest last. */
export function findCodexChildrenByThread(threadId: string): CodexChildRecord[] {
  const out: CodexChildRecord[] = []
  for (const record of records.values()) {
    if (record.threadId === threadId || record.sessionId === threadId) out.push(record)
  }
  return out
}

export function findCodexChildByPid(pid: number): CodexChildRecord | undefined {
  return records.get(pid)
}

/** All records, for a session-detail / log reconstruction of a c3 instance's turns. */
export function listCodexChildren(): CodexChildRecord[] {
  return [...records.values()]
}

/** Test hook: drop every record so cases do not leak into one another. */
export function resetCodexProcessRegistryForTests(): void {
  records.clear()
}

// ---------------------------------------------------------------------------
// Signal primitives (injectable)
// ---------------------------------------------------------------------------

/** The three host operations the escalation helper needs; injected in tests. */
export interface CodexProcessSignals {
  kill: (pid: number, signal: NodeJS.Signals) => void
  isAlive: (pid: number) => boolean
  sleep: (ms: number) => Promise<void>
}

const defaultSignals: CodexProcessSignals = {
  kill: (pid, signal) => {
    process.kill(pid, signal)
  },
  isAlive: (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (err) {
      // EPERM means the process exists but is not ours to signal — still alive.
      return (err as NodeJS.ErrnoException).code === 'EPERM'
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

let signals: CodexProcessSignals = defaultSignals

export function getCodexProcessSignals(): CodexProcessSignals {
  return signals
}

/** Test hook: swap the signal primitives (pass `null` to restore the defaults). */
export function setCodexProcessSignalsForTests(next: CodexProcessSignals | null): void {
  signals = next ?? defaultSignals
}

/** Grace period between SIGTERM and SIGKILL — mirrors the daemon restart sequence. */
export const CODEX_KILL_GRACE_MS = 3000
/** Poll interval while waiting for a signalled process to exit. */
export const CODEX_KILL_POLL_MS = 100

export interface CodexKillEscalation {
  method: CodexReclaimMethod
  waitedMs: number
  reason?: string
}

export interface CodexKillOptions {
  signals?: CodexProcessSignals
  graceMs?: number
  pollMs?: number
}

/**
 * Terminate `pid` deterministically: SIGTERM, poll for the grace period, then
 * SIGKILL, then verify. A no-op when the process is already gone. Shared by the
 * turn teardown and the resume reclaim so the two always agree.
 */
export async function escalateKill(
  pid: number,
  opts: CodexKillOptions = {},
): Promise<CodexKillEscalation> {
  const sig = opts.signals ?? signals
  const graceMs = opts.graceMs ?? CODEX_KILL_GRACE_MS
  const pollMs = opts.pollMs ?? CODEX_KILL_POLL_MS

  if (!sig.isAlive(pid)) return { method: 'already-exited', waitedMs: 0 }

  try {
    sig.kill(pid, 'SIGTERM')
  } catch (err) {
    if (!sig.isAlive(pid)) return { method: 'already-exited', waitedMs: 0 }
    return { method: 'failed', waitedMs: 0, reason: `SIGTERM failed: ${errorText(err)}` }
  }

  let waitedMs = 0
  while (waitedMs < graceMs) {
    await sig.sleep(pollMs)
    waitedMs += pollMs
    if (!sig.isAlive(pid)) return { method: 'sigterm', waitedMs }
  }

  try {
    sig.kill(pid, 'SIGKILL')
  } catch (err) {
    if (!sig.isAlive(pid)) return { method: 'sigterm', waitedMs }
    return { method: 'failed', waitedMs, reason: `SIGKILL failed: ${errorText(err)}` }
  }

  for (let i = 0; i < 20; i++) {
    await sig.sleep(pollMs)
    if (!sig.isAlive(pid)) return { method: 'sigkill', waitedMs: waitedMs + (i + 1) * pollMs }
  }
  return { method: 'failed', waitedMs, reason: 'process still alive after SIGKILL' }
}

// ---------------------------------------------------------------------------
// Host process table (injectable)
// ---------------------------------------------------------------------------

/** One live host process: its pid, start time and full command line. */
export interface ProcessTableEntry {
  pid: number
  /** `null` when the table was readable but this entry's start time was not. */
  startTimeMs: number | null
  command: string
}

/** Reads the host process table, or `null` when it cannot be read at all. */
export type ProcessTableReader = () => Promise<ProcessTableEntry[] | null>

const PS_LINE_RE =
  /^\s*(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/

/** Parse `ps -eo pid=,lstart=,command=` output (C locale). Malformed lines are skipped. */
export function parseProcessTable(stdout: string): ProcessTableEntry[] {
  const out: ProcessTableEntry[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const match = PS_LINE_RE.exec(line)
    if (!match) continue
    const parsed = Date.parse(match[2])
    out.push({
      pid: Number(match[1]),
      startTimeMs: Number.isNaN(parsed) ? null : parsed,
      command: match[3].trim(),
    })
  }
  return out
}

/** The production reader: `ps` in the C locale, `null` when unavailable or denied. */
export function defaultProcessTableReader(): Promise<ProcessTableEntry[] | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        'ps',
        ['-eo', 'pid=,lstart=,command='],
        { env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout) => {
          if (err) {
            resolve(null)
            return
          }
          resolve(parseProcessTable(stdout))
        },
      )
    } catch {
      resolve(null)
    }
  })
}

let processTable: ProcessTableReader = defaultProcessTableReader

/** Test hook: swap the process-table reader (pass `null` to restore the default). */
export function setCodexProcessTableForTests(next: ProcessTableReader | null): void {
  processTable = next ?? defaultProcessTableReader
}

/** Read the start time of one pid; `null` when the table or the entry is unavailable. */
export async function readProcessStartTime(pid: number): Promise<number | null> {
  const table = await processTable()
  if (!table) return null
  const entry = table.find((e) => e.pid === pid)
  return entry ? entry.startTimeMs : null
}

// ---------------------------------------------------------------------------
// Writer-lock occupant scan and reclaim
// ---------------------------------------------------------------------------

/** Why c3 declined to reclaim an identified or unidentifiable occupant. */
export type CodexRefusalReason =
  | 'no-candidate'
  | 'ambiguous'
  | 'table-unreadable'
  | 'start-time-unknown'
  | 'no-record'
  | 'record-live'
  | 'start-time-mismatch'

export type CodexOccupantScan =
  | { kind: 'candidate'; pid: number; startTimeMs: number | null }
  | { kind: 'ambiguous' }
  | { kind: 'none' }
  | { kind: 'unreadable' }

export type CodexReclaimResult =
  | { kind: 'reclaimed'; pid: number; method: 'sigterm' | 'sigkill'; waitedMs: number }
  | { kind: 'already-exited'; pid: number }
  | { kind: 'failed'; pid: number; reason: string }
  | {
      kind: 'refused'
      reason: CodexRefusalReason
      /** Present only for reasons that name an identified occupant. */
      pid?: number
      startTimeMs?: number | null
    }

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Whether a command line is a Codex turn resuming `threadId`. c3 always passes
 * `resume <threadId>` as argv elements, and the arapuca wrapper forwards argv
 * verbatim, so the marker survives both run shapes.
 */
export function isCodexResumeCommand(command: string, threadId: string): boolean {
  if (!/\bcodex\b/.test(command)) return false
  return new RegExp(`(?:^|\\s)resume\\s+${escapeRegExp(threadId)}(?:\\s|$)`).test(command)
}

/** Find the live process holding `threadId`'s writer lock, by command line. */
export async function scanCodexResumeOccupants(threadId: string): Promise<CodexOccupantScan> {
  const table = await processTable()
  if (table === null) return { kind: 'unreadable' }
  const matches = table.filter((entry) => isCodexResumeCommand(entry.command, threadId))
  if (matches.length === 0) return { kind: 'none' }
  if (matches.length > 1) return { kind: 'ambiguous' }
  return { kind: 'candidate', pid: matches[0].pid, startTimeMs: matches[0].startTimeMs }
}

/**
 * Locate and, when ownership is provable, terminate the process holding a
 * thread's writer lock. Killing requires BOTH a settled registry record for this
 * thread/pid and a start time that still matches the recorded one; every other
 * outcome is a refusal the caller must surface rather than act on.
 */
export async function reclaimCodexOccupant(
  threadId: string,
  opts: CodexKillOptions = {},
): Promise<CodexReclaimResult> {
  const scan = await scanCodexResumeOccupants(threadId)
  if (scan.kind === 'unreadable') return { kind: 'refused', reason: 'table-unreadable' }
  if (scan.kind === 'none') return { kind: 'refused', reason: 'no-candidate' }
  if (scan.kind === 'ambiguous') return { kind: 'refused', reason: 'ambiguous' }

  const { pid, startTimeMs } = scan
  // The occupant's own start time must be readable before any identity claim.
  if (startTimeMs === null) return { kind: 'refused', reason: 'start-time-unknown' }

  const record = findCodexChildrenByThread(threadId).find((r) => r.pid === pid)
  if (!record) return { kind: 'refused', reason: 'no-record', pid, startTimeMs }
  if (record.status === 'live') return { kind: 'refused', reason: 'record-live', pid, startTimeMs }
  if (record.startTimeUnknown || record.startTimeMs === null) {
    return { kind: 'refused', reason: 'start-time-unknown', pid, startTimeMs }
  }
  if (record.startTimeMs !== startTimeMs) {
    return { kind: 'refused', reason: 'start-time-mismatch', pid, startTimeMs }
  }

  const escalation = await escalateKill(pid, opts)
  if (escalation.method === 'failed') {
    return { kind: 'failed', pid, reason: escalation.reason ?? 'unknown reason' }
  }
  const outcome: CodexChildOutcome = {
    pid,
    exitCode: null,
    signal: null,
    reclaimedBy: escalation.method,
    waitedMs: escalation.waitedMs,
  }
  settleCodexChild(pid, outcome)
  if (escalation.method === 'already-exited') return { kind: 'already-exited', pid }
  return { kind: 'reclaimed', pid, method: escalation.method, waitedMs: escalation.waitedMs }
}

// ---------------------------------------------------------------------------
// Human-readable outcome vocabulary (one source for logs and turn errors)
// ---------------------------------------------------------------------------

/** `pid 43210 exited code=1` / `pid 43210 terminated (SIGKILL after 3s)`. */
export function describeCodexChildOutcome(outcome: CodexChildOutcome): string {
  if (outcome.reclaimedBy === 'sigterm' || outcome.reclaimedBy === 'sigkill') {
    const seconds = Math.round((outcome.waitedMs ?? 0) / 1000)
    return `pid ${outcome.pid} terminated (${outcome.reclaimedBy.toUpperCase()} after ${seconds}s)`
  }
  if (outcome.reclaimedBy === 'failed') {
    return `pid ${outcome.pid} could not be reclaimed: ${outcome.reason ?? 'unknown reason'}`
  }
  if (outcome.signal) return `pid ${outcome.pid} exited signal ${outcome.signal}`
  if (outcome.exitCode !== null) return `pid ${outcome.pid} exited code=${outcome.exitCode}`
  return `pid ${outcome.pid} already exited`
}

function formatStartTime(startTimeMs: number | null | undefined): string {
  if (startTimeMs === null || startTimeMs === undefined) return 'start time unknown'
  return `started ${new Date(startTimeMs).toISOString()}`
}

function manualStep(threadId: string): string {
  return `stop the other run (or find the process running codex exec … resume ${threadId})`
}

/**
 * The user-facing diagnostic for a refusal. Reasons that name an identified
 * occupant include the pid and start time; reasons where c3 cannot identify the
 * holder deliberately invent nothing — no pid appears.
 */
export function describeCodexOccupantRefusal(
  threadId: string,
  result: Extract<CodexReclaimResult, { kind: 'refused' }>,
): string {
  const manual = manualStep(threadId)
  switch (result.reason) {
    case 'no-record':
      return `stale process pid ${result.pid} (${formatStartTime(result.startTimeMs)}) holds the thread's writer lock but is not a c3-spawned turn; c3 will not kill it automatically — stop pid ${result.pid}, then resume again`
    case 'record-live':
      return `pid ${result.pid} (${formatStartTime(result.startTimeMs)}) is a live c3 turn for this thread; c3 will not kill a running turn — wait for it to finish or stop it, then resume again`
    case 'start-time-mismatch':
      return `pid ${result.pid} (${formatStartTime(result.startTimeMs)}) holds the thread's writer lock but its start time does not match the recorded c3 child (pid reuse); c3 will not kill it — inspect pid ${result.pid}, then resume again`
    case 'start-time-unknown':
      return `the thread's writer lock is held but the holder could not be identified as a c3 leftover (start time unavailable); c3 did not kill any process — ${manual}, then resume again`
    case 'ambiguous':
      return `the thread's writer lock is held and the holder could not be identified (more than one candidate process); c3 did not kill any process — ${manual}, then resume again`
    case 'table-unreadable':
      return `the thread's writer lock is held and the holder could not be identified (process table unreadable); c3 did not kill any process — ${manual}, then resume again`
    case 'no-candidate':
      return `the thread's writer lock is held and the holder could not be identified (no matching process found); c3 did not kill any process — ${manual}, then resume again`
  }
}

export function describeCodexReclaimFailure(
  result: Extract<CodexReclaimResult, { kind: 'failed' }>,
): string {
  return `stale c3 process pid ${result.pid} could not be reclaimed: ${result.reason}; stop it manually, then resume again`
}

// ---------------------------------------------------------------------------
// Structured log lines (identity style of the run log)
// ---------------------------------------------------------------------------

function childIdentity(record: CodexChildRecord): string {
  const session = record.sessionId ?? record.threadId ?? 'pending'
  const thread = record.threadId ?? 'pending'
  const start = record.startTimeUnknown ? ' start-time=unknown' : ''
  return `session=${session} vendor=codex pid=${record.pid} thread=${thread}${start}`
}

export function formatCodexChildSpawn(record: CodexChildRecord): string {
  return `[codex] child spawned ${childIdentity(record)}`
}

export function formatCodexChildSettled(record: CodexChildRecord): string {
  const outcome = record.outcome ? ` ${describeCodexChildOutcome(record.outcome)}` : ''
  return `[codex] child settled ${childIdentity(record)}${outcome}`
}

export function formatCodexReclaim(
  threadId: string,
  pid: number,
  method: CodexReclaimMethod,
): string {
  return `[codex] reclaimed stale child session=${threadId} vendor=codex pid=${pid} method=${method}`
}

export function logCodexChildSpawn(record: CodexChildRecord): void {
  console.log(formatCodexChildSpawn(record))
}

export function logCodexChildSettled(record: CodexChildRecord): void {
  console.log(formatCodexChildSettled(record))
}

export function logCodexReclaim(threadId: string, pid: number, method: CodexReclaimMethod): void {
  console.warn(formatCodexReclaim(threadId, pid, method))
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
