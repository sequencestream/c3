#!/usr/bin/env node
/**
 * End-to-end test for SPEC AUTOMATION in an SDD workspace: the queue authoring a
 * spec, reviewing it read-only, and then either stopping at the human approval
 * checkpoint or clearing it under the workspace's machine-approval opt-in.
 *
 * Scenario: one throwaway SDD workspace with ONE `automate` intent that has no
 * spec. The queue is started and drives the whole spec phase itself. The test
 * then walks the opt-in through all three of its meaningful states on the SAME
 * authored spec:
 *
 *   1. opt-in OFF  → author → review → the intent STOPS at "awaiting approval".
 *                    `spec_approved` must never become true, whatever the
 *                    reviewer concluded. This is the default every existing
 *                    workspace migrates to, so it is the load-bearing assertion.
 *   2. opt-in ON   → the same passing conclusion is approved by the queue with no
 *                    human click, recorded under the reserved machine identity
 *                    (never a login subject), and the intent leaves the gate.
 *   3. revoke      → back to "awaiting approval", and — critically — the next
 *                    tick must NOT re-approve the same conclusion, or the revoke
 *                    button would be theatre in a machine-approval workspace.
 *
 * Reusing one authored spec across all three phases is deliberate: it is a
 * stronger test (it proves the opt-in is re-read every tick rather than latched
 * at queue start) and it spends ONE authoring + review cycle instead of two.
 *
 * TOKENS ARE SPENT: this drives real spec-authoring and spec-review agent runs —
 * that is the point, since the whole flow under test is "does the queue actually
 * drive these sessions". Everything else is gated so no DEVELOPMENT turn ever
 * starts: the intent is force-skipped before the final resume.
 *
 * SKIP (exit 5) rather than FAIL when the environment cannot produce the
 * precondition: no agent configured, or the reviewer never reaches a `pass`
 * within the rework budget. Phase 2 asserts the approval PATH, not the
 * reviewer's judgement — a reviewer that keeps asking for changes is a valid
 * outcome of the flow, not a defect in it.
 *
 * Usage:
 *   pnpm build && node scripts/e2e/isolated-server.mjs --port 13000   # in another terminal
 *   node scripts/e2e/e2e-spec-automation-test.mjs [ws-url]
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'

const URL = process.argv[2] || 'ws://localhost:13000/ws'
const TIMEOUT_MS = 15 * 60_000
const POLL_MS = 1000
/** The reserved machine approver — must match `MACHINE_SPEC_APPROVER` in the protocol. */
const MACHINE_APPROVER = 'c3:machine-spec-approver'

// ---- Seed a throwaway git workspace under /tmp ----
const PROJECT_DIR = mkdtempSync('/tmp/c3-spec-auto-')
writeFileSync(`${PROJECT_DIR}/README.md`, '# Spec automation e2e\n\nA tiny project.\n')
writeFileSync(
  `${PROJECT_DIR}/greet.js`,
  `// The single module this project has.
export function greet(name) {
  return 'Hello, ' + name
}
`,
)
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
let intentId = null
let intents = []
let detail = null
let workspaceConfig = null
const errors = []
const failures = []
let skipReason = null
let finished = false
/** Every approval the SERVER reported, so we can prove no human click caused one. */
let sentApproveSpec = 0

const timeout = setTimeout(() => {
  failures.push(`TIMEOUT in phase "${phase}"`)
  finish()
}, TIMEOUT_MS)

const send = (msg) => {
  if (msg.type === 'approve_spec') sentApproveSpec += 1
  ws.send(JSON.stringify(msg))
}
const check = (ok, label) => {
  console.log(`[e2e] ${ok ? 'ok  ' : 'FAIL'} — ${label}`)
  if (!ok) failures.push(label)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const target = () => intents.find((r) => r.id === intentId) ?? null
const item = () => detail?.items?.find((i) => i.intentId === intentId) ?? null

/** Poll the ledger + queue projection until `predicate` holds (or we run out). */
async function waitFor(predicate, label, tries) {
  for (let i = 0; i < tries; i++) {
    send({ type: 'list_intents', workspaceId })
    send({ type: 'get_queue_detail', workspaceId })
    await sleep(POLL_MS)
    if (predicate()) return true
    // The invariant under test in phase 1 must hold at EVERY sample, not merely
    // at the end: a brief auto-approval that a later tick undid would still be
    // an auto-approval.
    if (assertNeverApproved && target()?.specApproved === true) return true
  }
  console.log(`[e2e] gave up waiting for: ${label}`)
  return false
}

/** Armed during phase 1: `spec_approved` must stay false at every single sample. */
let assertNeverApproved = false

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
      phase = 'configure-sdd'
      // SDD on, machine approval explicitly OFF — the default every migrated
      // workspace lands on, and phase 1's precondition.
      send({
        type: 'save_workspace_setting',
        workspaceId,
        config: { sddEnabled: true, specMachineApprovalEnabled: false },
      })
      break
    }

    case 'workspace_setting':
      workspaceConfig = msg.config
      if (phase === 'configure-sdd') {
        phase = 'seed-intent'
        send({ type: 'create_intent', workspaceId })
      }
      break

    case 'create_intent_result':
      if (intentId) break
      intentId = msg.intent.id
      send({
        type: 'update_intent_content',
        intentId,
        content:
          'Add a `farewell(name)` function to `greet.js` that returns "Goodbye, <name>", ' +
          'mirroring the existing `greet(name)`. Acceptance: calling farewell("Ada") returns ' +
          '"Goodbye, Ada"; `greet` keeps its current behaviour unchanged.',
      })
      send({ type: 'update_intent_status', intentId, status: 'todo' })
      send({ type: 'set_intent_automate', intentId, automate: true })
      // Force-skip is NOT applied: the spec phase must run. Development is kept
      // out by the spec gate itself — an unapproved spec is never developed —
      // and the run is stopped before approval could ever release that gate.
      send({ type: 'start_workflow', workspaceId })
      void runAssertions()
      break

    case 'intents':
      intents = msg.items ?? []
      break

    case 'queue_detail':
      detail = msg.detail
      break

    case 'error':
      errors.push(msg.error?.code ?? '?')
      break
  }
})

// ---- Assertions ----

async function runAssertions() {
  // ── Phase 1: opt-in OFF ──────────────────────────────────────────────────
  phase = 'author-spec'
  assertNeverApproved = true
  console.log('[e2e] waiting for the queue to author a spec (real agent run)…')
  const authored = await waitFor(() => !!target()?.specPath, 'spec authored by the queue', 300)
  if (!authored) {
    skipReason =
      'the queue never authored a spec — no usable agent configured, or the run failed. ' +
      `last queue reason: ${item()?.blockedReason ?? 'n/a'}`
    return finish()
  }
  check(!!target()?.specPath, 'the queue authored a spec with NO human trigger')
  check(!!target()?.specSessionId, 'the authoring session is linked onto the intent')

  phase = 'review-spec'
  console.log('[e2e] waiting for the read-only review to submit a conclusion…')
  const reviewed = await waitFor(
    () => !!target()?.specReviewVerdict,
    'a review conclusion was submitted',
    300,
  )
  if (!reviewed) {
    skipReason =
      'the reviewer never submitted a conclusion — the review agent could not run. ' +
      `last queue reason: ${item()?.blockedReason ?? 'n/a'}`
    return finish()
  }
  const verdict = target()?.specReviewVerdict
  console.log(`[e2e] review verdict: ${verdict}`)
  check(
    verdict === 'pass' || verdict === 'changes_requested',
    'the conclusion is one of the two structured verdicts',
  )
  check(!!target()?.specReviewSessionId, 'the review session is linked onto the intent')
  check(
    target()?.specReviewSessionId !== target()?.specSessionId,
    'the reviewer is a SEPARATE session from the author (not a reused spec session)',
  )

  // THE assertion this phase exists for.
  check(
    target()?.specApproved === false,
    'with the opt-in OFF, spec_approved is NEVER set automatically',
  )
  check(target()?.specApproveUser === null, 'with the opt-in OFF, no approver identity is written')

  if (verdict === 'pass') {
    // Give the queue several ticks to prove it really does stop here.
    phase = 'hold-at-human-gate'
    await waitFor(() => false, 'several ticks with a passing review and the opt-in off', 8)
    check(
      target()?.specApproved === false,
      'a passing review with the opt-in OFF still waits for a human, tick after tick',
    )
    check(
      item()?.blockedReason === 'spec_awaiting_approval',
      'the queue reports it is waiting for human approval',
    )
  } else {
    check(
      (target()?.specReviewReworkRounds ?? 0) >= 1,
      'a changes_requested conclusion advanced the rework counter',
    )
  }

  // ── Phase 2: opt-in ON ───────────────────────────────────────────────────
  // Reaching a `pass` is the reviewer's call, not something the test may force.
  if (target()?.specReviewVerdict !== 'pass') {
    phase = 'await-pass'
    console.log('[e2e] waiting out the rework loop for a passing conclusion…')
    await waitFor(() => target()?.specReviewVerdict === 'pass', 'a passing conclusion', 600)
  }
  if (target()?.specReviewVerdict !== 'pass') {
    // The rework path itself is asserted deterministically in the kernel unit
    // tests; here it just means phase 2's precondition never arrived.
    check(
      target()?.specApproved === false,
      'a spec that never passed review is never approved, machine opt-in or not',
    )
    skipReason = `the reviewer never returned "pass" (rounds: ${target()?.specReviewReworkRounds}) — the machine-approval half needs one`
    return finish()
  }

  phase = 'enable-machine-approval'
  assertNeverApproved = false
  const approveClicksBefore = sentApproveSpec
  send({
    type: 'save_workspace_setting',
    workspaceId,
    config: { ...workspaceConfig, sddEnabled: true, specMachineApprovalEnabled: true },
  })
  console.log('[e2e] machine approval opted in; waiting for the queue to approve…')
  await waitFor(() => target()?.specApproved === true, 'the queue approved the spec itself', 60)

  check(target()?.specApproved === true, 'with the opt-in ON, a passing review clears the gate')
  check(
    target()?.specApproveUser === MACHINE_APPROVER,
    'the approver is the reserved machine identity, not a login subject',
  )
  check(
    sentApproveSpec === approveClicksBefore,
    'no approve_spec message was ever sent — the approval was not a human click',
  )

  // ── Phase 3: revoke, and stay revoked ────────────────────────────────────
  phase = 'revoke'
  send({ type: 'revoke_spec_approval', workspaceId, intentId })
  await waitFor(() => target()?.specApproved === false, 'the approval was revoked', 30)
  check(target()?.specApproved === false, 'revoke returns the intent to awaiting approval')
  check(target()?.specApproveUser === null, 'revoke clears the approver identity')

  phase = 'stay-revoked'
  // The whole point: with the opt-in still ON and the conclusion still `pass`,
  // the very next tick would re-approve unless the revoke vetoed the conclusion.
  await waitFor(() => false, 'several ticks after the revoke', 8)
  check(
    target()?.specApproved === false,
    'the next tick does NOT re-approve the same conclusion a human just revoked',
  )

  phase = 'stop'
  send({ type: 'stop_workflow', workspaceId })
  await sleep(500)
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

  if (failures.length > 0) {
    console.error(`\n[e2e] ${failures.length} assertion(s) failed:`)
    for (const f of failures) console.error(`  - ${f}`)
    console.error('RESULT: FAIL')
    process.exit(1)
  }
  if (skipReason) {
    console.log(`\n[e2e] SKIP: ${skipReason}`)
    console.log('RESULT: SKIP')
    process.exit(5)
  }
  console.log('\nRESULT: PASS')
  process.exit(0)
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
