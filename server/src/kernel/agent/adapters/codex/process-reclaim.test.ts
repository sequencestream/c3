/**
 * Codex child observability, guaranteed teardown and resume self-healing
 * (2026-09-29-004).
 *
 * These describe blocks are deliberately separate from the fake-client suite: the
 * registry, the escalation helper, the process-table scan and the resume reclaim
 * are all driven through injected seams, so no real process is spawned and no
 * permission to run `ps` is required. The fake `CodexClient` never spawns either —
 * the recovery tests seed the registry directly, which is exactly the state a
 * previous c3 turn leaves behind.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ThreadEvent } from '@openai/codex-sdk'
import type { CanonicalMessage, DriverStartOptions } from '../types.js'
import {
  CodexDriver,
  isActiveWriterRejection,
  type CodexClient,
  type CodexThread,
} from './driver.js'
import {
  CODEX_KILL_GRACE_MS,
  describeCodexChildOutcome,
  escalateKill,
  findCodexChildrenByThread,
  formatCodexChildSettled,
  formatCodexChildSpawn,
  isCodexResumeCommand,
  logCodexChildSettled,
  logCodexChildSpawn,
  logCodexSessionChildren,
  parseProcessTable,
  registerCodexChild,
  resetCodexProcessRegistryForTests,
  setCodexProcessSignalsForTests,
  setCodexProcessTableForTests,
  settleCodexChild,
  type CodexChildOutcome,
  type CodexProcessSignals,
  type ProcessTableEntry,
} from './process-registry.js'

const THREAD = 'thread_z'
/** A fixed process start time so identity matching is deterministic. */
const START_MS = Date.parse('Wed Sep 30 08:00:00 2026')

/** A signal recorder: `alive` decides who survives which signal. */
function fakeSignals(options: {
  alive?: number[]
  /** Signals that actually remove the pid; anything else is ignored (unresponsive). */
  diesOn?: NodeJS.Signals[]
}) {
  const alive = new Set(options.alive ?? [])
  const diesOn = new Set(options.diesOn ?? ['SIGTERM'])
  const kills: Array<{ pid: number; signal: NodeJS.Signals }> = []
  const sleeps: number[] = []
  const signals: CodexProcessSignals = {
    kill: (pid, signal) => {
      kills.push({ pid, signal })
      if (diesOn.has(signal)) alive.delete(pid)
    },
    isAlive: (pid) => alive.has(pid),
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  }
  return { signals, kills, sleeps, alive }
}

function table(entries: ProcessTableEntry[]): () => Promise<ProcessTableEntry[]> {
  return async () => entries
}

function resumeEntry(
  pid: number,
  threadId: string,
  startTimeMs: number | null,
  ppid = 1,
): ProcessTableEntry {
  return {
    pid,
    ppid,
    startTimeMs,
    command: `/usr/local/bin/codex exec --experimental-json --sandbox workspace-write resume ${threadId}`,
  }
}

/**
 * The sandbox shape: c3 spawned the wrapper, the wrapper handed off to arapuca,
 * and the vendor CLI it supervises holds the writer lock. The registered pid and
 * the lock holder are therefore different processes.
 */
function sandboxedResumeEntries(
  wrapperPid: number,
  childPid: number,
  threadId: string,
  wrapperStartTimeMs: number | null,
  childStartTimeMs: number | null = wrapperStartTimeMs,
): ProcessTableEntry[] {
  return [
    {
      pid: wrapperPid,
      ppid: 1,
      startTimeMs: wrapperStartTimeMs,
      command: `/usr/bin/arapuca run --seccomp baseline -- /opt/codex/bin/codex exec --experimental-json resume ${threadId}`,
    },
    resumeEntry(childPid, threadId, childStartTimeMs, wrapperPid),
  ]
}

/** An async generator over a fixed script of events. */
async function* scriptEvents(events: ThreadEvent[]): AsyncGenerator<ThreadEvent> {
  yield* events
}

interface ScriptedAttempt {
  events: ThreadEvent[] | (() => AsyncGenerator<ThreadEvent>)
  outcome?: CodexChildOutcome | null
}

/** A fake client that hands out one scripted thread per resume/start call. */
function scriptedClient(attempts: ScriptedAttempt[]) {
  const calls: Array<{ kind: 'start' | 'resume'; id?: string }> = []
  let index = 0
  const nextThread = (): CodexThread => {
    const attempt = attempts[Math.min(index, attempts.length - 1)]
    index += 1
    const events =
      typeof attempt.events === 'function' ? attempt.events() : scriptEvents(attempt.events)
    return {
      id: THREAD,
      runStreamed: async () => ({ events }),
      lastChildOutcome: () => attempt.outcome ?? null,
    }
  }
  const client: CodexClient = {
    startThread: () => {
      calls.push({ kind: 'start' })
      return nextThread()
    },
    resumeThread: (id) => {
      calls.push({ kind: 'resume', id })
      return nextThread()
    },
  }
  return { client, calls }
}

function startOpts(over: Partial<DriverStartOptions> = {}): DriverStartOptions {
  return {
    prompt: 'continue the thing',
    cwd: '/work',
    signal: new AbortController().signal,
    actionMode: 'build',
    toolGate: 'on-sensitive',
    resume: THREAD,
    ...over,
  }
}

async function collect(stream: AsyncIterable<CanonicalMessage>): Promise<CanonicalMessage[]> {
  const out: CanonicalMessage[] = []
  for await (const m of stream) out.push(m)
  return out
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

const ACTIVE_WRITER_EVENT: ThreadEvent = {
  type: 'error',
  message: `thread ${THREAD} already has an active writer (code -32600)`,
}

beforeEach(() => {
  resetCodexProcessRegistryForTests()
})

afterEach(() => {
  resetCodexProcessRegistryForTests()
  setCodexProcessSignalsForTests(null)
  setCodexProcessTableForTests(null)
  vi.restoreAllMocks()
})

describe('escalateKill (guaranteed child teardown)', () => {
  it('SIGTERMs an unresponsive child, escalates to SIGKILL, and records sigkill', async () => {
    const { signals, kills } = fakeSignals({ alive: [4321], diesOn: ['SIGKILL'] })
    const result = await escalateKill(4321, { signals, graceMs: 300, pollMs: 100 })

    expect(kills).toEqual([
      { pid: 4321, signal: 'SIGTERM' },
      { pid: 4321, signal: 'SIGKILL' },
    ])
    expect(result.method).toBe('sigkill')
    // The grace period was actually spent before escalating.
    expect(result.waitedMs).toBeGreaterThanOrEqual(300)
  })

  it('records sigterm when the child honours SIGTERM', async () => {
    const { signals, kills } = fakeSignals({ alive: [4322], diesOn: ['SIGTERM'] })
    const result = await escalateKill(4322, { signals, graceMs: 300, pollMs: 100 })

    expect(kills).toEqual([{ pid: 4322, signal: 'SIGTERM' }])
    expect(result.method).toBe('sigterm')
    expect(result.waitedMs).toBeLessThanOrEqual(CODEX_KILL_GRACE_MS)
  })

  it('is a no-op when the child already exited', async () => {
    const { signals, kills } = fakeSignals({ alive: [] })
    const result = await escalateKill(4323, { signals })

    expect(kills).toEqual([])
    expect(result.method).toBe('already-exited')
  })

  it('reports failure instead of claiming success when the signal is rejected', async () => {
    const signals: CodexProcessSignals = {
      kill: () => {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
      },
      isAlive: () => true,
      sleep: async () => {},
    }
    const result = await escalateKill(4324, { signals })

    expect(result.method).toBe('failed')
    expect(result.reason).toContain('operation not permitted')
  })
})

describe('Codex driver teardown of a real lingering child', () => {
  it('reclaims the spawned child after a stream error, escalating to SIGKILL when SIGTERM is ignored', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'c3-codex-zombie-'))
    const fakeCodex = join(dir, 'codex')
    writeFileSync(
      fakeCodex,
      [
        '#!/bin/sh',
        `trap '' TERM`,
        'cat >/dev/null',
        `printf '%s\n' '{"type":"thread.started","thread_id":"thread_zombie"}'`,
        `printf '%s\n' '{"type":"error","message":"openrouter:web_search upstream returned 502"}'`,
        // The survivor: the turn is over from c3's point of view but this process
        // lives on, exactly as in the reported incident.
        'sleep 30',
      ].join('\n'),
    )
    chmodSync(fakeCodex, 0o755)
    try {
      const driver = new CodexDriver()
      const run = await driver.start(
        startOpts({ resume: undefined, sandboxWrapperPath: fakeCodex }),
      )

      const failure = await collect(run.messages()).then(
        () => null,
        (err: unknown) => err as Error,
      )
      expect(failure?.message).toContain('openrouter:web_search upstream returned 502')
      expect(failure?.message).toMatch(/pid \d+ terminated \(SIGKILL after \d+s\)/)

      // The pid really is gone — no zombie is left behind.
      const pid = Number(/pid (\d+)/.exec(failure!.message)![1])
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it('replays the incident: 502 stream error, lingering child reclaimed, then resume succeeds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'c3-codex-replay-'))
    const fakeCodex = join(dir, 'codex')
    const lockFile = join(dir, `${THREAD}.lock`)
    // A fake CLI that models the writer lock the way Codex does: the lock is a bare
    // pid placeholder, so a resume decides liveness from the process itself — the
    // same reason c3 must reclaim the survivor before it can resume.
    writeFileSync(
      fakeCodex,
      [
        '#!/bin/sh',
        `LOCK=${shQuote(lockFile)}`,
        'tid=""',
        'prev=""',
        'for a in "$@"; do',
        '  if [ "$prev" = "resume" ]; then tid="$a"; fi',
        '  prev="$a"',
        'done',
        'if [ -n "$tid" ]; then',
        '  if [ -f "$LOCK" ]; then',
        '    holder=$(cat "$LOCK" 2>/dev/null)',
        '    if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then',
        `      printf '%s\\n' "{\\"type\\":\\"error\\",\\"message\\":\\"thread $tid already has an active writer (code -32600)\\"}"`,
        '      exit 1',
        '    fi',
        '  fi',
        '  cat >/dev/null',
        '  echo $$ > "$LOCK"',
        `  printf '%s\\n' "{\\"type\\":\\"thread.started\\",\\"thread_id\\":\\"$tid\\"}"`,
        `  printf '%s\\n' '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"healed"}}'`,
        '  rm -f "$LOCK"',
        '  exit 0',
        'fi',
        // First turn: take the lock, report the provider 502, then linger — the
        // process survives the turn, which is what used to lock the thread.
        'echo $$ > "$LOCK"',
        `trap '' TERM`,
        'cat >/dev/null',
        `printf '%s\\n' '{"type":"thread.started","thread_id":"${THREAD}"}'`,
        `printf '%s\\n' '{"type":"error","message":"openrouter:web_search upstream returned 502"}'`,
        'sleep 30',
      ].join('\n'),
    )
    chmodSync(fakeCodex, 0o755)
    try {
      const driver = new CodexDriver()

      // Turn 1 — the provider hiccup. The turn fails and c3 must not leave the
      // child holding the thread's writer lock.
      const first = await driver.start(
        startOpts({ resume: undefined, sandboxWrapperPath: fakeCodex }),
      )
      const failure = await collect(first.messages()).then(
        () => null,
        (err: unknown) => err as Error,
      )
      expect(failure?.message).toContain('openrouter:web_search upstream returned 502')
      expect(failure?.message).toMatch(/pid \d+ terminated \(SIGKILL after \d+s\)/)

      // The lock placeholder is left behind, but the process it names is dead.
      expect(existsSync(lockFile)).toBe(true)
      const holder = Number(readFileSync(lockFile, 'utf-8').trim())
      expect(() => process.kill(holder, 0)).toThrow()

      // Turn 2 — the user continues the chat. Resume succeeds instead of reporting
      // "already has an active writer".
      const second = await driver.start(startOpts({ sandboxWrapperPath: fakeCodex }))
      const messages = await collect(second.messages())
      expect(messages).toHaveLength(1)
      expect(messages[0].blocks).toMatchObject([{ type: 'text', text: 'healed' }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('Codex driver teardown outcome (stream error / non-zero exit)', () => {
  it('surfaces one error carrying the pid and the teardown outcome', async () => {
    const outcome: CodexChildOutcome = {
      pid: 43210,
      exitCode: 1,
      signal: null,
      reclaimedBy: 'already-exited',
    }
    const { client } = scriptedClient([
      {
        events: () =>
          (async function* () {
            // The exact 502 shape from the original report: a stream error event …
            yield {
              type: 'error',
              message: 'openrouter:web_search upstream returned 502',
            } as ThreadEvent
            // … followed by the CLI's non-zero exit, thrown out of the generator.
            throw new Error('Codex Exec exited with code 1: ')
          })(),
        outcome,
      },
    ])
    const driver = new CodexDriver(() => client)
    const run = await driver.start(startOpts({ resume: undefined }))

    const failure = await collect(run.messages()).then(
      () => null,
      (err: unknown) => err as Error,
    )
    expect(failure).toBeInstanceOf(Error)
    expect(failure?.message).toContain('codex stream error:')
    expect(failure?.message).toContain('openrouter:web_search upstream returned 502')
    expect(failure?.message).toContain('pid 43210')
    expect(failure?.message).toContain('exited code=1')
  })

  it('describes a SIGKILL reclamation in the session-visible outcome vocabulary', () => {
    expect(
      describeCodexChildOutcome({
        pid: 77,
        exitCode: null,
        signal: null,
        reclaimedBy: 'sigkill',
        waitedMs: 3000,
      }),
    ).toBe('pid 77 terminated (SIGKILL after 3s)')
  })
})

describe('resume self-healing on an active-writer rejection', () => {
  function seedSettledZombie(pid: number, startTimeMs: number | null): void {
    registerCodexChild({ pid, threadId: THREAD, startTimeMs })
    settleCodexChild(pid, {
      pid,
      exitCode: null,
      signal: null,
      reclaimedBy: 'failed',
      reason: 'teardown lost the race',
    })
  }

  it('reclaims a settled c3 leftover (event shape) and retries resume exactly once', async () => {
    seedSettledZombie(4242, START_MS)
    const { signals, kills } = fakeSignals({ alive: [4242], diesOn: ['SIGTERM'] })
    setCodexProcessSignalsForTests(signals)
    setCodexProcessTableForTests(table([resumeEntry(4242, THREAD, START_MS)]))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const { client, calls } = scriptedClient([
      { events: [ACTIVE_WRITER_EVENT] },
      {
        events: [
          {
            type: 'item.completed',
            item: { id: 'i1', type: 'agent_message', text: 'healed' },
          } as ThreadEvent,
        ],
      },
    ])
    const driver = new CodexDriver(() => client)
    const run = await driver.start(startOpts())

    // ONE for-await over the run's single async-iterable — no error in between.
    const messages = await collect(run.messages())
    expect(messages).toHaveLength(1)
    expect(messages[0].blocks).toMatchObject([{ type: 'text', text: 'healed' }])
    expect(calls.filter((c) => c.kind === 'resume')).toHaveLength(2)
    expect(calls).toEqual([
      { kind: 'resume', id: THREAD },
      { kind: 'resume', id: THREAD },
    ])

    expect(kills).toEqual([{ pid: 4242, signal: 'SIGTERM' }])
    expect(findCodexChildrenByThread(THREAD)[0]).toMatchObject({
      status: 'settled',
      outcome: { reclaimedBy: 'sigterm' },
    })
    expect(warn.mock.calls.flat().join('\n')).toContain('reclaimed stale child')
    expect(warn.mock.calls.flat().join('\n')).toContain('pid=4242')
    // The session's own record of its children is emitted at turn end.
    const log = logSpy.mock.calls.flat().join('\n')
    expect(log).toContain('[codex] session children')
    expect(log).toContain(`session=${THREAD}`)
    expect(log).toContain('pid 4242 terminated (SIGTERM after')
  })

  it('reclaims a settled c3 leftover (throw shape) and retries resume exactly once', async () => {
    seedSettledZombie(4310, START_MS)
    const { signals, kills } = fakeSignals({ alive: [4310], diesOn: ['SIGKILL'] })
    setCodexProcessSignalsForTests(signals)
    setCodexProcessTableForTests(table([resumeEntry(4310, THREAD, START_MS)]))

    const { client, calls } = scriptedClient([
      {
        events: () =>
          // eslint-disable-next-line require-yield -- models a generator that rejects before yielding
          (async function* () {
            throw new Error(`thread ${THREAD} already has an active writer`)
          })(),
      },
      {
        events: [
          {
            type: 'item.completed',
            item: { id: 'i1', type: 'agent_message', text: 'ok' },
          } as ThreadEvent,
        ],
      },
    ])
    const driver = new CodexDriver(() => client)
    const run = await driver.start(startOpts())

    const messages = await collect(run.messages())
    expect(messages).toHaveLength(1)
    expect(calls).toHaveLength(2)
    expect(kills.map((k) => k.signal)).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('does not loop: a second active-writer rejection on the retry fails the turn', async () => {
    seedSettledZombie(4400, START_MS)
    const { signals, kills } = fakeSignals({ alive: [4400], diesOn: ['SIGTERM'] })
    setCodexProcessSignalsForTests(signals)
    setCodexProcessTableForTests(table([resumeEntry(4400, THREAD, START_MS)]))

    const { client, calls } = scriptedClient([
      { events: [ACTIVE_WRITER_EVENT] },
      { events: [ACTIVE_WRITER_EVENT] },
    ])
    const driver = new CodexDriver(() => client)
    const run = await driver.start(startOpts())

    await expect(collect(run.messages())).rejects.toThrow(/already has an active writer/)
    // Budget is one: the original attempt plus exactly one retry.
    expect(calls).toHaveLength(2)
    expect(kills).toHaveLength(1)
  })

  it('reclaims the lock holder inside a sandbox wrapper, where the pids differ', async () => {
    seedSettledZombie(9100, START_MS)
    const { signals, kills } = fakeSignals({ alive: [9101], diesOn: ['SIGTERM'] })
    setCodexProcessSignalsForTests(signals)
    setCodexProcessTableForTests(table(sandboxedResumeEntries(9100, 9101, THREAD, START_MS)))

    const { client, calls } = scriptedClient([
      { events: [ACTIVE_WRITER_EVENT] },
      {
        events: [
          {
            type: 'item.completed',
            item: { id: 'i1', type: 'agent_message', text: 'sandbox healed' },
          } as ThreadEvent,
        ],
      },
    ])
    const driver = new CodexDriver(() => client)
    const run = await driver.start(startOpts())

    const messages = await collect(run.messages())
    expect(messages[0].blocks).toMatchObject([{ type: 'text', text: 'sandbox healed' }])
    expect(calls).toHaveLength(2)
    // The descendant that actually held the lock is the one reclaimed.
    expect(kills).toEqual([{ pid: 9101, signal: 'SIGTERM' }])
    expect(findCodexChildrenByThread(THREAD).map((r) => r.pid)).toContain(9101)
    expect(findCodexChildrenByThread(THREAD).find((r) => r.pid === 9101)?.outcome).toMatchObject({
      reclaimedBy: 'sigterm',
    })
  })

  it('does not kill a sandbox descendant whose wrapper start time no longer matches', async () => {
    seedSettledZombie(9200, START_MS)
    const { signals, kills } = fakeSignals({ alive: [9201] })
    setCodexProcessSignalsForTests(signals)
    setCodexProcessTableForTests(
      table(sandboxedResumeEntries(9200, 9201, THREAD, START_MS + 60_000)),
    )

    const { client } = scriptedClient([{ events: [ACTIVE_WRITER_EVENT] }])
    const driver = new CodexDriver(() => client)
    const run = await driver.start(startOpts())

    const failure = await collect(run.messages()).then(
      () => null,
      (err: unknown) => err as Error,
    )
    expect(failure?.message).toContain('pid 9200')
    expect(failure?.message).toContain('pid reuse')
    expect(kills).toEqual([])
  })

  it('does not scan, kill or retry when a resume fails for a non-lock -32600', async () => {
    const { signals, kills } = fakeSignals({ alive: [] })
    setCodexProcessSignalsForTests(signals)
    let scanned = false
    setCodexProcessTableForTests(async () => {
      scanned = true
      return []
    })

    const { client, calls } = scriptedClient([
      {
        events: [
          {
            type: 'error',
            message: 'invalid request: unknown method (code -32600)',
          } as ThreadEvent,
        ],
      },
    ])
    const driver = new CodexDriver(() => client)
    const run = await driver.start(startOpts())

    const failure = await collect(run.messages()).then(
      () => null,
      (err: unknown) => err as Error,
    )
    expect(failure?.message).toContain('invalid request')
    expect(calls).toHaveLength(1) // no retry
    expect(kills).toEqual([])
    expect(scanned).toBe(false) // no process-table scan
  })

  it('does not reclaim (or retry) when the occupant has no c3 record', async () => {
    const { signals, kills } = fakeSignals({ alive: [6001] })
    setCodexProcessSignalsForTests(signals)
    setCodexProcessTableForTests(table([resumeEntry(6001, THREAD, START_MS)]))

    const { client, calls } = scriptedClient([{ events: [ACTIVE_WRITER_EVENT] }])
    const driver = new CodexDriver(() => client)
    const run = await driver.start(startOpts())

    const failure = await collect(run.messages()).then(
      () => null,
      (err: unknown) => err as Error,
    )
    expect(failure?.message).toContain('pid 6001')
    expect(failure?.message).toContain(new Date(START_MS).toISOString())
    expect(failure?.message).toContain('not a c3-spawned turn')
    expect(kills).toEqual([])
    expect(calls).toHaveLength(1) // no retry
  })

  it('does not kill a live c3 turn for the thread', async () => {
    registerCodexChild({ pid: 6002, threadId: THREAD, startTimeMs: START_MS })
    const { signals, kills } = fakeSignals({ alive: [6002] })
    setCodexProcessSignalsForTests(signals)
    setCodexProcessTableForTests(table([resumeEntry(6002, THREAD, START_MS)]))

    const { client, calls } = scriptedClient([{ events: [ACTIVE_WRITER_EVENT] }])
    const driver = new CodexDriver(() => client)
    const run = await driver.start(startOpts())

    const failure = await collect(run.messages()).then(
      () => null,
      (err: unknown) => err as Error,
    )
    expect(failure?.message).toContain('pid 6002')
    expect(failure?.message).toContain('live c3 turn')
    expect(kills).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it('does not kill when the start time no longer matches (pid reuse)', async () => {
    seedSettledZombie(6003, START_MS)
    const { signals, kills } = fakeSignals({ alive: [6003] })
    setCodexProcessSignalsForTests(signals)
    setCodexProcessTableForTests(table([resumeEntry(6003, THREAD, START_MS + 60_000)]))

    const { client } = scriptedClient([{ events: [ACTIVE_WRITER_EVENT] }])
    const driver = new CodexDriver(() => client)
    const run = await driver.start(startOpts())

    const failure = await collect(run.messages()).then(
      () => null,
      (err: unknown) => err as Error,
    )
    expect(failure?.message).toContain('pid 6003')
    expect(failure?.message).toContain('pid reuse')
    expect(kills).toEqual([])
  })

  it('reports an unidentified holder (no pid) when the start time was never captured', async () => {
    seedSettledZombie(6004, null)
    const { signals, kills } = fakeSignals({ alive: [6004] })
    setCodexProcessSignalsForTests(signals)
    setCodexProcessTableForTests(table([resumeEntry(6004, THREAD, START_MS)]))

    const { client } = scriptedClient([{ events: [ACTIVE_WRITER_EVENT] }])
    const driver = new CodexDriver(() => client)
    const run = await driver.start(startOpts())

    const failure = await collect(run.messages()).then(
      () => null,
      (err: unknown) => err as Error,
    )
    expect(failure?.message).toContain('could not be identified')
    expect(failure?.message).not.toContain('6004')
    expect(kills).toEqual([])
  })

  it('reports an unidentified holder when several candidates match', async () => {
    seedSettledZombie(6005, START_MS)
    const { signals, kills } = fakeSignals({ alive: [6005, 6006] })
    setCodexProcessSignalsForTests(signals)
    setCodexProcessTableForTests(
      table([resumeEntry(6005, THREAD, START_MS), resumeEntry(6006, THREAD, START_MS)]),
    )

    const { client } = scriptedClient([{ events: [ACTIVE_WRITER_EVENT] }])
    const driver = new CodexDriver(() => client)
    const run = await driver.start(startOpts())

    const failure = await collect(run.messages()).then(
      () => null,
      (err: unknown) => err as Error,
    )
    expect(failure?.message).toContain('could not be identified')
    expect(failure?.message).not.toMatch(/\b600[56]\b/)
    expect(kills).toEqual([])
  })

  it('reports an unidentified holder when the process table is unreadable', async () => {
    seedSettledZombie(6007, START_MS)
    const { signals, kills } = fakeSignals({ alive: [6007] })
    setCodexProcessSignalsForTests(signals)
    setCodexProcessTableForTests(async () => null)

    const { client } = scriptedClient([{ events: [ACTIVE_WRITER_EVENT] }])
    const driver = new CodexDriver(() => client)
    const run = await driver.start(startOpts())

    const failure = await collect(run.messages()).then(
      () => null,
      (err: unknown) => err as Error,
    )
    expect(failure?.message).toContain('could not be identified')
    expect(failure?.message).not.toContain('6007')
    expect(kills).toEqual([])
  })
})

describe('process registry and structured log lines', () => {
  it('looks a child up by thread id with its pid and terminal outcome', () => {
    const record = registerCodexChild({ pid: 7001, threadId: 'thread_log', startTimeMs: START_MS })
    settleCodexChild(7001, { pid: 7001, exitCode: 1, signal: null, reclaimedBy: 'already-exited' })

    expect(findCodexChildrenByThread('thread_log')).toMatchObject([
      { pid: 7001, status: 'settled', outcome: { exitCode: 1 } },
    ])
    expect(formatCodexChildSpawn(record)).toContain('pid=7001')
    expect(formatCodexChildSpawn(record)).toContain('thread=thread_log')
    expect(formatCodexChildSettled(record)).toContain('pid 7001 exited code=1')
  })

  it('emits spawn/settle log lines carrying the pid', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const record = registerCodexChild({ pid: 7002, threadId: 'thread_log2', startTimeMs: null })
    logCodexChildSpawn(record)
    settleCodexChild(7002, {
      pid: 7002,
      exitCode: null,
      signal: null,
      reclaimedBy: 'sigkill',
      waitedMs: 3000,
    })
    logCodexChildSettled(record)

    const lines = log.mock.calls.flat().join('\n')
    expect(lines).toContain('[codex] child spawned')
    expect(lines).toContain('pid=7002')
    expect(lines).toContain('[codex] child settled')
    expect(lines).toContain('terminated (SIGKILL after 3s)')
    expect(lines).toContain('start-time=unknown')
  })
})

it('emits one per-session line listing the children and their outcomes', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  registerCodexChild({ pid: 7301, threadId: 'thread_sum', startTimeMs: START_MS })
  settleCodexChild(7301, {
    pid: 7301,
    exitCode: 1,
    signal: null,
    reclaimedBy: 'already-exited',
  })

  logCodexSessionChildren('thread_sum', findCodexChildrenByThread('thread_sum'))

  const line = log.mock.calls.flat().join('\n')
  expect(line).toContain('[codex] session children')
  expect(line).toContain('session=thread_sum')
  expect(line).toContain('count=1')
  expect(line).toContain('pid 7301 exited code=1')
})

describe('process-table parsing and the resume marker', () => {
  it('parses `ps -eo pid=,ppid=,lstart=,command=` output, single-digit days included', () => {
    const stdout = [
      '    1     0 Wed Sep 23 08:48:58 2026     /sbin/launchd',
      ' 4242     1 Thu Sep  1 09:00:00 2026 /opt/codex/bin/codex exec resume thread_z',
      '',
      'not a ps line',
    ].join('\n')

    expect(parseProcessTable(stdout)).toEqual([
      {
        pid: 1,
        ppid: 0,
        startTimeMs: Date.parse('Wed Sep 23 08:48:58 2026'),
        command: '/sbin/launchd',
      },
      {
        pid: 4242,
        ppid: 1,
        startTimeMs: Date.parse('Thu Sep  1 09:00:00 2026'),
        command: '/opt/codex/bin/codex exec resume thread_z',
      },
    ])
  })

  it('matches the codex CLI process resuming the exact thread, not its supervisor', () => {
    const cmd = (s: string): string => `/opt/codex exec --experimental-json resume ${s}`
    expect(isCodexResumeCommand(cmd('thread_z'), 'thread_z')).toBe(true)
    expect(isCodexResumeCommand(cmd('thread_z'), 'thread_z2')).toBe(false)
    expect(isCodexResumeCommand(cmd('thread_z2'), 'thread_z')).toBe(false)
    expect(isCodexResumeCommand(`${cmd('thread_z')} extra`, 'thread_z')).toBe(true)
    expect(isCodexResumeCommand(`/usr/bin/node server.js resume thread_z`, 'thread_z')).toBe(false)
    // The sandbox supervisor lists the wrapped CLI in its own argv — it is not the
    // holder, and counting it would make every sandboxed resume ambiguous.
    expect(
      isCodexResumeCommand(
        `/usr/bin/arapuca run -- /opt/codex/bin/codex exec resume thread_z`,
        'thread_z',
      ),
    ).toBe(false)
  })

  it('classifies the active-writer rejection by its message alone', () => {
    expect(isActiveWriterRejection(new Error('Thread X already has an active writer'))).toBe(true)
    expect(isActiveWriterRejection({ message: 'thread t already has an active writer' })).toBe(true)
    // -32600 is a generic "invalid request"; it is NOT lock-specific, so a
    // code-only match must not trigger a scan-and-resend.
    expect(isActiveWriterRejection({ code: -32600, message: 'invalid request' })).toBe(false)
    expect(isActiveWriterRejection(new Error('invalid request (code -32600)'))).toBe(false)
    expect(isActiveWriterRejection(new Error('upstream returned 502'))).toBe(false)
    expect(isActiveWriterRejection(undefined)).toBe(false)
  })
})
