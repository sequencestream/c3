#!/usr/bin/env node
/**
 * End-to-end test for the AUTOMATION QUEUE (deterministic scheduling kernel).
 *
 * Scenario: a throwaway workspace with four `automate` intents —
 *
 *   A  (independent, force-skipped)
 *   B  (independent, parked)
 *   C  (independent, force-skipped)
 *   D  (depends on B) ← must NEVER start while B is parked
 *
 * The test drives the real wire protocol end to end and asserts the properties
 * the queue exists to guarantee:
 *
 *  1. A parked intent does NOT stop the queue. The queue stays in a live state.
 *  2. A parked intent is NOT `done`. Its downstream stays blocked by the
 *     dependency gate (`blocked_dependency`) and is never launched — parking
 *     isolates a failure, it never opens a path around one.
 *  3. A blocked queue never reports `done`. Reporting success while a chain is
 *     stuck is a misleading success, which the kernel forbids.
 *  4. `force_skip` changes only this queue's selection: it never marks an intent
 *     `done` and never satisfies a dependency gate.
 *  5. `unpark` clears the park, and unparking something that is NOT parked is
 *     REPORTED (`queue.notParked`), never silently accepted.
 *  6. `pause` / `resume` are honoured, and pausing preserves the candidate set.
 *
 * NO AGENT TOKENS ARE SPENT. Every intent is deliberately held behind a gate for
 * the whole run (two force-skipped, one parked, one dependency-blocked), so the
 * queue never has an eligible candidate to launch. The controls are applied
 * BEFORE `start_workflow`, and the mutations that would make an intent eligible
 * again are applied while the queue is PAUSED, then re-armed before `resume` —
 * so no dev turn can start in any window.
 *
 * HOW THE FAILURE IS INJECTED — and what that does not cover.
 * The park is induced through `queue_control override_block`, the explicit human
 * ruling, which drives exactly the same park mechanism a repeated agent failure
 * does. A genuine agent crash cannot be provoked for ONE intent deterministically,
 * and reproducing it would cost three live dev turns plus ~90s of real backoff.
 * The genuine chain — `runDevTurn` REJECTS → one failed attempt → exponential
 * backoff → park on the third → unrelated intents still complete → downstream
 * still blocked — is covered by `server/src/features/intents/workflow.test.ts`
 * ("queue driver — failure isolation"), which injects a real launch rejection.
 *
 * Usage:
 *   pnpm build && node scripts/e2e/isolated-server.mjs --port 13000   # in another terminal
 *   node scripts/e2e/e2e-queue-test.mjs [ws-url]
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'

const URL = process.argv[2] || 'ws://localhost:13000/ws'
const TIMEOUT_MS = 60_000
const POLL_MS = 150
const POLL_TRIES = 40

// ---- Seed a throwaway git workspace under /tmp ----
const PROJECT_DIR = mkdtempSync('/tmp/c3-queue-')
writeFileSync(`${PROJECT_DIR}/README.md`, '# Queue e2e\n')
try {
  execFileSync('git', ['init', '-q'], { cwd: PROJECT_DIR })
  execFileSync('git', ['add', '.'], { cwd: PROJECT_DIR })
  execFileSync(
    'git',
    ['-c', 'user.email=e2e@c3', '-c', 'user.name=c3 e2e', 'commit', '-qm', 'init'],
    { cwd: PROJECT_DIR },
  )
} catch (err) {
  console.error('[e2e] git seed failed — SKIP:', err?.message ?? err)
  rmSync(PROJECT_DIR, { recursive: true, force: true })
  process.exit(5)
}

console.log(`[e2e] workspace: ${PROJECT_DIR}`)
console.log(`[e2e] connecting ${URL}`)

const ws = new WebSocket(URL)

// ---- State ----
let workspaceId = null
let phase = 'boot'
const ids = {}
let detail = null
const errors = []
const failures = []
let finished = false

const timeout = setTimeout(() => {
  failures.push(`TIMEOUT in phase "${phase}"`)
  finish()
}, TIMEOUT_MS)

const send = (msg) => ws.send(JSON.stringify(msg))
const check = (ok, label) => {
  console.log(`[e2e] ${ok ? 'ok  ' : 'FAIL'} — ${label}`)
  if (!ok) failures.push(label)
}
const itemOf = (label) => detail?.items?.find((i) => i.intentId === ids[label]) ?? null
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Re-request the projection until `predicate` holds. Every control also pushes a
 * `queue_detail`, and reconcile passes broadcast their own, so "the next frame"
 * is NOT a reliable correlation — polling on the assertion itself is.
 */
async function waitFor(predicate, label) {
  for (let i = 0; i < POLL_TRIES; i++) {
    send({ type: 'get_queue_detail', workspaceId })
    await sleep(POLL_MS)
    if (detail && predicate()) return true
  }
  console.log(`[e2e] gave up waiting for: ${label}`)
  return false
}

ws.addEventListener('open', () => console.log('[e2e] open'))

ws.addEventListener('message', (evt) => {
  let msg
  try {
    msg = JSON.parse(typeof evt.data === 'string' ? evt.data : String(evt.data))
  } catch {
    return
  }

  switch (msg.type) {
    case 'ready':
      phase = 'add-workspace'
      send({ type: 'add_workspace', path: PROJECT_DIR })
      break

    case 'workspaces': {
      if (workspaceId) break
      const name = PROJECT_DIR.split('/').pop()
      workspaceId =
        (msg.workspaces?.find((w) => w.name === name) ?? msg.workspaces?.[0])?.id ?? null
      if (!workspaceId) {
        failures.push('no workspaceId after add_workspace')
        finish()
        return
      }
      phase = 'seed-intents'
      seedNextIntent()
      break
    }

    case 'create_intent_result': {
      const label = LABELS[created]
      ids[label] = msg.intent.id
      created += 1
      send({
        type: 'update_intent_content',
        intentId: msg.intent.id,
        content: `queue e2e ${label}`,
      })
      send({ type: 'update_intent_status', intentId: msg.intent.id, status: 'todo' })
      send({ type: 'set_intent_automate', intentId: msg.intent.id, automate: true })
      seedNextIntent()
      break
    }

    case 'queue_detail':
      detail = msg.detail
      break

    case 'error':
      errors.push(msg.error?.code ?? '?')
      break
  }
})

// ---- Intent setup ----
const LABELS = ['A', 'B', 'C', 'D']
let created = 0

function seedNextIntent() {
  if (created < LABELS.length) {
    send({ type: 'create_intent', workspaceId })
    return
  }
  // D depends on B — the gate the parked intent must keep shut.
  send({
    type: 'update_intent_deps',
    intentId: ids.D,
    deps: [{ dependsOnId: ids.B, depType: 'blocks' }],
  })
  // Arm every gate BEFORE the queue starts, so no dev turn can ever be launched.
  send({ type: 'queue_control', workspaceId, action: 'force_skip', intentId: ids.A })
  send({ type: 'queue_control', workspaceId, action: 'force_skip', intentId: ids.C })
  send({ type: 'queue_control', workspaceId, action: 'override_block', intentId: ids.B })
  send({ type: 'start_workflow', workspaceId })
  void runAssertions()
}

// ---- Assertions ----

async function runAssertions() {
  phase = 'assert-parked'
  await waitFor(
    () => itemOf('B')?.parked === true && itemOf('D')?.blockedReason === 'blocked_dependency',
    'B parked and D dependency-blocked',
  )
  console.log(`[e2e] queue state=${detail?.state} items=${detail?.items?.length ?? 0}`)

  const b = itemOf('B')
  const d = itemOf('D')
  check(b?.parked === true, 'B is parked')
  check(b?.blockedReason === 'blocked_parked', 'B reports blocked_parked')

  // The core guarantee: parking isolates, it never opens a path around.
  check(d?.parked === false, 'D is not itself parked')
  check(
    d?.blockedReason === 'blocked_dependency',
    'D stays blocked by the dependency gate (never skipped, never released)',
  )
  check(d?.lastAction !== 'launch', 'D was never launched')

  // A blocked queue must never claim success, nor die.
  check(detail?.state !== 'done', 'queue does not report `done` while a chain is blocked')
  check(detail?.state !== 'idle', 'queue is still live (a parked intent did not stop it)')

  // Every item carries the three things the queue page must show.
  const projected = (detail?.items ?? []).every(
    (i) =>
      typeof i.blockedReason === 'string' &&
      typeof i.lastAction === 'string' &&
      (i.nextWakeupAt === null || typeof i.nextWakeupAt === 'number'),
  )
  check(projected, 'every item projects blocking reason, last decision and next wake-up')

  // ---- force_skip must not complete anything nor satisfy a dependency ----
  phase = 'assert-force-skip'
  const c = itemOf('C')
  check(c?.forceSkipped === true, 'C is force-skipped')
  check(
    c?.blockedReason === 'blocked_force_skipped',
    'C reports blocked_force_skipped (skipping is not completing)',
  )
  check(!!c, 'a force-skipped intent stays a candidate rather than being completed')

  // ---- pause: honoured, and the candidate set is preserved ----
  phase = 'pause'
  send({ type: 'queue_control', workspaceId, action: 'pause' })
  await waitFor(() => detail?.state === 'paused', 'queue paused')
  check(detail?.state === 'paused', 'pause is honoured and projected')
  check(
    (detail?.items ?? []).length >= LABELS.length,
    'pausing preserves the candidate set (facts are not discarded)',
  )

  // ---- unskip / unpark, applied while paused so nothing can launch ----
  phase = 'unskip'
  send({ type: 'queue_control', workspaceId, action: 'unskip', intentId: ids.C })
  await waitFor(() => itemOf('C')?.forceSkipped === false, 'C unskipped')
  check(itemOf('C')?.forceSkipped === false, 'unskip restores C to the selection')

  phase = 'unpark'
  const errorsBefore = errors.length
  send({ type: 'queue_control', workspaceId, action: 'unpark', intentId: ids.B })
  await waitFor(() => itemOf('B')?.parked === false, 'B unparked')
  check(itemOf('B')?.parked === false, 'unpark clears the park mark on B')
  check(errors.length === errorsBefore, 'a valid unpark reports no error')

  phase = 'unpark-invalid'
  send({ type: 'queue_control', workspaceId, action: 'unpark', intentId: ids.B })
  await waitFor(() => errors.includes('queue.notParked'), 'refusal for a non-parked unpark')
  check(
    errors.includes('queue.notParked'),
    'unparking a non-parked intent is refused with a visible reason',
  )

  // ---- re-arm every gate, THEN resume: no candidate may become eligible ----
  phase = 'resume'
  send({ type: 'queue_control', workspaceId, action: 'force_skip', intentId: ids.C })
  send({ type: 'queue_control', workspaceId, action: 'override_block', intentId: ids.B })
  send({ type: 'queue_control', workspaceId, action: 'resume' })
  await waitFor(() => detail?.state !== 'paused', 'queue resumed')
  check(detail?.state !== 'paused', 'resume leaves the paused state')
  check(
    (detail?.items ?? []).every((i) => i.lastAction !== 'launch'),
    'no intent was ever launched (every candidate stayed behind a gate)',
  )

  phase = 'stop'
  send({ type: 'stop_workflow', workspaceId })
  await sleep(300)
  finish()
}

function finish() {
  if (finished) return
  finished = true
  clearTimeout(timeout)
  try {
    ws.close()
  } catch {
    /* already closed */
  }
  rmSync(PROJECT_DIR, { recursive: true, force: true })

  if (failures.length === 0) {
    console.log('\nRESULT: PASS')
    process.exit(0)
  }
  console.error(`\n[e2e] ${failures.length} assertion(s) failed:`)
  for (const f of failures) console.error(`  - ${f}`)
  console.error('RESULT: FAIL')
  process.exit(1)
}

ws.addEventListener('error', (e) => {
  failures.push(`websocket error: ${e?.message ?? 'unknown'}`)
  finish()
})
ws.addEventListener('close', () => {
  if (!finished) {
    failures.push(`connection closed in phase "${phase}"`)
    finish()
  }
})
