#!/usr/bin/env node
/**
 * Cursor SDK capability probe — the evidence source for Cursor's capability
 * ledger (see
 * `doc/domains/core/agent-session/features/agent-session-cursor.md`).
 *
 * Drives `@cursor/sdk`'s local runtime exactly as c3's driver does — `Agent.create`
 * → `send` → iterate `Run.stream()` → settle on `Run.wait()` — inside a throwaway
 * workspace, and reports what the runtime actually delivers rather than what its
 * types promise.
 *
 * Two gates are BLOCKING, because c3's session model cannot be honest without them:
 *   G1 resume — a second turn through `Agent.resume(agentId)` remembers a secret
 *      established in the first. Without it `sessions.resume` cannot be `full`.
 *   G2 resume-after-cancel — a turn killed mid-flight with `Run.cancel()` still
 *      leaves a resumable agent. Without it an interrupted session is lost.
 *
 * The remaining checks are informational: they record the native tool names, the
 * stability of a tool `call_id` across its running/completed frames, whether the
 * plan conversation mode is accepted, and the shape of the terminal result.
 *
 * Needs a real `CURSOR_API_KEY` and outbound network (spends a small amount of
 * real quota), so it is NOT CI-safe and NOT part of `pnpm e2e`. No key ⇒ the gates
 * report SKIP (exit 5).
 *
 * Usage:
 *   node scripts/e2e/cursor-sdk-probe.mjs [--gates-only] [--json] [--keep]
 * Exit codes: 0 = GO (both gates pass), 1 = NO-GO, 5 = SKIP (unauthenticated).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = new Set(process.argv.slice(2))
const GATES_ONLY = args.has('--gates-only')
const JSON_OUT = args.has('--json')
const KEEP = args.has('--keep')

const log = (s) => !JSON_OUT && console.log(`[cursor-probe] ${s}`)
const findings = []
const record = (name, ok, detail) => {
  findings.push({ name, ok, detail })
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

function skip(reason) {
  if (JSON_OUT) console.log(JSON.stringify({ verdict: 'SKIP', reason, findings }, null, 2))
  else console.log(`[cursor-probe] SKIP: ${reason}`)
  process.exit(5)
}

const API_KEY = (process.env.CURSOR_API_KEY ?? '').trim()
if (!API_KEY) {
  skip('CURSOR_API_KEY is not set — the SDK authenticates with an API key only')
}

let Agent
try {
  ;({ Agent } = await import('@cursor/sdk'))
} catch (err) {
  skip(`@cursor/sdk could not be loaded: ${err?.message ?? err}`)
}

// ─── Throwaway workspace ─────────────────────────────────────────────────────
const WORK = mkdtempSync(join(tmpdir(), 'c3-cursor-probe-'))
writeFileSync(join(WORK, 'README.md'), '# cursor probe\n')
writeFileSync(join(WORK, 'marker.txt'), 'probe-marker\n')

function cleanup() {
  if (KEEP) {
    log(`kept workspace: ${WORK}`)
    return
  }
  rmSync(WORK, { recursive: true, force: true })
}

const baseOptions = {
  model: { id: 'auto' },
  apiKey: API_KEY,
  local: { cwd: WORK, autoReview: false, settingSources: ['project', 'user'] },
}

/** Run one turn, collecting the frames the driver's translator would consume. */
async function turn(agent, text, sendOptions = {}) {
  const frames = []
  const run = await agent.send({ text }, { model: { id: 'auto' }, ...sendOptions })
  for await (const message of run.stream()) frames.push(message)
  const result = await run.wait()
  return { frames, result, run }
}

/** All assistant text in a frame list, concatenated (the SDK streams deltas). */
function assistantText(frames) {
  return frames
    .filter((f) => f.type === 'assistant')
    .flatMap((f) => f.message?.content ?? [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('')
}

let gate1 = false
let gate2 = false

try {
  // ── G1: resume carries context ────────────────────────────────────────────
  const secret = `probe-${Math.floor(Date.now() / 1000)}`
  const first = await Agent.create(baseOptions)
  const agentId = first.agentId
  record('agent id minted up front', Boolean(agentId), agentId)

  const t1 = await turn(first, `Remember this token for later: ${secret}. Reply with exactly: ACK`)
  first.close()
  const t1Ok = t1.result.status === 'finished'
  record(
    'first turn completes',
    t1Ok,
    t1Ok ? undefined : `${t1.result.status}: ${t1.result.error?.message ?? 'no reason'}`,
  )
  if (!t1Ok && /api key/i.test(t1.result.error?.message ?? '')) {
    cleanup()
    skip(`the key was rejected: ${t1.result.error?.message}`)
  }

  const resumed = await Agent.resume(agentId, baseOptions)
  const t2 = await turn(resumed, 'What token did I ask you to remember? Reply with only the token.')
  resumed.close()
  gate1 = assistantText(t2.frames).includes(secret)
  record('G1 resume restores native context', gate1, gate1 ? undefined : 'token not recalled')

  // ── G2: an agent survives a cancelled turn ────────────────────────────────
  const cancelSecret = `cancel-${Math.floor(Date.now() / 1000)}`
  const c1 = await Agent.resume(agentId, baseOptions)
  const longRun = await c1.send(
    {
      text: `Remember this second token: ${cancelSecret}. Then count slowly from 1 to 200, one number per line.`,
    },
    { model: { id: 'auto' } },
  )
  // Let the turn get underway, then kill it the way c3's abort() does.
  const iterator = longRun.stream()[Symbol.asyncIterator]()
  await iterator.next()
  await longRun.cancel()
  try {
    // Drain whatever the runtime still emits so the handle settles.
    for (;;) {
      const next = await iterator.next()
      if (next.done) break
    }
  } catch {
    /* a cancelled stream may throw; that is the kill taking effect */
  }
  c1.close()

  const afterCancel = await Agent.resume(agentId, baseOptions)
  const t3 = await turn(afterCancel, 'Reply with exactly: STILL-HERE')
  afterCancel.close()
  gate2 = t3.result.status === 'finished' && assistantText(t3.frames).includes('STILL-HERE')
  record(
    'G2 agent is resumable after a cancelled turn',
    gate2,
    gate2 ? undefined : `status=${t3.result.status}`,
  )

  if (!GATES_ONLY) {
    // ── Informational: tools, call-id stability, plan mode ──────────────────
    const tooling = await Agent.create(baseOptions)
    const t4 = await turn(
      tooling,
      'List the files in this directory using a tool, then reply with exactly: TOOLS-DONE',
    )
    tooling.close()

    const toolFrames = t4.frames.filter((f) => f.type === 'tool_call')
    const names = [...new Set(toolFrames.map((f) => f.name))]
    record('native tool frames observed', toolFrames.length > 0, names.join(', ') || 'none')

    // A stable call_id across running → completed is what lets the translator
    // back-fill a result onto the block that opened the call.
    const byId = new Map()
    for (const frame of toolFrames) {
      const seen = byId.get(frame.call_id) ?? new Set()
      seen.add(frame.status)
      byId.set(frame.call_id, seen)
    }
    const paired = [...byId.values()].filter((s) => s.size > 1).length
    record(
      'tool call_id is stable across running/completed',
      byId.size > 0 && paired > 0,
      `${paired}/${byId.size} call ids saw more than one status`,
    )

    const planner = await Agent.create({ ...baseOptions, mode: 'plan' })
    const t5 = await turn(
      planner,
      'Outline how you would add a CHANGELOG entry. Do not edit files.',
      {
        mode: 'plan',
      },
    )
    planner.close()
    record(
      'plan conversation mode is accepted',
      t5.result.status === 'finished',
      `status=${t5.result.status}`,
    )

    const listed = await Agent.list({ runtime: 'local', cwd: WORK })
    const found = listed.items.some((a) => a.agentId === agentId)
    record('the SDK local store lists agents c3 created', found, `${listed.items.length} agent(s)`)
  }
} catch (err) {
  record('probe completed without throwing', false, err?.message ?? String(err))
} finally {
  cleanup()
}

const verdict = gate1 && gate2 ? 'GO' : 'NO-GO'
if (JSON_OUT) console.log(JSON.stringify({ verdict, findings }, null, 2))
else console.log(`[cursor-probe] VERDICT: ${verdict}`)
process.exit(verdict === 'GO' ? 0 : 1)
