#!/usr/bin/env node
/**
 * End-to-end test for the DELIVERY STATUS GUARD over the real wire protocol: a
 * transition the state machine refuses comes back as a structured
 * `delivery_transition_failed` frame, and the delivery does not move.
 *
 * Why this needs a wire test at all. `canTransitionDelivery` is exhaustively
 * unit-tested, but the property that matters to a client is the one only the
 * real transport can show: that a refusal arrives as a TYPED frame carrying the
 * gaps, the current status and the attempted target — not as a generic `error`,
 * and not as a silent no-op the page would render as success. The page builds its
 * segmented selector out of exactly these fields.
 *
 * Scenario — a throwaway git workspace (no remote), one fresh `planned` delivery
 * with no branch and no associated intents. Both refusals below need no forge and
 * no network, which is why this is the delivery case that CAN be driven honestly
 * end to end.
 *
 * PASS asserts:
 *
 *  1. An UNREACHABLE edge (`planned → delivered`, not in the graph at all) is
 *     refused with `delivery.invalidStatusTransition`, an empty gap list (there is
 *     no gap to close — the edge does not exist), and the frame echoes
 *     `currentStatus: planned` + `to: delivered`.
 *  2. A REACHABLE-but-BLOCKED edge (`planned → integrating` with no delivery
 *     branch) is refused with `delivery.transitionGuardFailed` and a STRUCTURED
 *     gap — `delivery.guard.branchNotReady` — so the page can tell the user what
 *     to fix rather than just that it failed. The two codes are distinct on
 *     purpose: "impossible" and "not yet" are different answers.
 *  3. The plan the page renders never OFFERS an illegal target: `planned` lists
 *     `integrating` and nothing further down the chain, so the refusals above are
 *     the backstop for a stale client, not the primary UI path.
 *  4. A SYSTEM-ONLY edge is not human-invokable: `verified → delivered` (which the
 *     forge's own merge drives) is refused for a human caller with the
 *     `delivery.guard.systemOnly` gap. Reaching `verified` needs facts no
 *     forge-free run can produce, so this section seeds the status straight into
 *     the ledger and is SKIPPED when `C3_DB_PATH` is absent.
 *  5. No refusal writes: the delivery is unchanged afterwards, and the
 *     server-computed `transitionPlan` keeps reporting the same blocked target
 *     with the same gap.
 *
 * NO AGENT TOKENS ARE SPENT: no session is ever started, no forge is contacted.
 *
 * Usage:
 *   pnpm build && node scripts/e2e/isolated-server.mjs --port 13000 --db /tmp/c3-e2e/c3.db   # in another terminal
 *   C3_DB_PATH=/tmp/c3-e2e/c3.db node scripts/e2e/e2e-delivery-transition-test.mjs [ws-url]
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'

const URL = process.argv[2] || 'ws://localhost:13000/ws'
const TIMEOUT_MS = 60_000
const POLL_MS = 150
const POLL_TRIES = 40
const DB_PATH = process.env.C3_DB_PATH

/** `node:sqlite`, when available — only the optional system-only section needs it. */
let DatabaseSync = null
try {
  ;({ DatabaseSync } = await import('node:sqlite'))
} catch {
  DatabaseSync = null
}

// ---- Seed a throwaway git workspace under /tmp (no remote, on purpose) ----
const PROJECT_DIR = mkdtempSync('/tmp/c3-delivery-transition-')
writeFileSync(`${PROJECT_DIR}/README.md`, '# Delivery transition e2e\n')
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
let workspaceName = null
let phase = 'boot'
let deliveryId = null
let detail = null
/** Every `delivery_transition_failed` frame this run received, in order. */
const refusals = []
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Poll the delivery detail until `predicate` holds against the freshest frame. */
async function waitForDetail(predicate, label) {
  for (let i = 0; i < POLL_TRIES; i++) {
    send({ type: 'get_delivery_detail', deliveryId })
    await sleep(POLL_MS)
    if (detail?.delivery?.id === deliveryId && predicate()) return true
  }
  console.log(`[e2e] gave up waiting for: ${label}`)
  return false
}

/**
 * Attempt one transition and return the refusal frame it produced (or `null`
 * when the server answered with something else — which is itself a failure the
 * caller asserts on).
 */
async function attempt(to, confirmVerified = false) {
  const before = refusals.length
  send({ type: 'transition_delivery', workspaceName, deliveryId, to, confirmVerified })
  for (let i = 0; i < POLL_TRIES && refusals.length === before; i++) await sleep(POLL_MS)
  return refusals[before] ?? null
}

/** The plan's entry for one target, as the server computed it. */
const targetFor = (to) => detail?.transitionPlan?.targets?.find((t) => t.to === to) ?? null

/**
 * Force the delivery's stored status, bypassing the state machine — the only way
 * to reach `verified` without a real branch, real associations and a real forge.
 * Used ONLY to set up the system-only refusal; the refusal itself still travels
 * the real wire and the real guard.
 */
function forceStatus(status) {
  const db = new DatabaseSync(DB_PATH)
  try {
    db.exec('PRAGMA busy_timeout=5000;')
    db.prepare('UPDATE deliveries SET status=?, branch_ready=1 WHERE id=?').run(status, deliveryId)
  } finally {
    db.close()
  }
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
      send({ type: 'add_workspace', name: PROJECT_DIR.split('/').pop(), path: PROJECT_DIR })
      break

    case 'workspaces': {
      if (workspaceName) break
      const name = PROJECT_DIR.split('/').pop()
      workspaceName =
        (msg.workspaces?.find((w) => w.name === name) ?? msg.workspaces?.[0])?.name ?? null
      if (!workspaceName) {
        failures.push('no workspaceName after add_workspace')
        finish()
        return
      }
      phase = 'create-delivery'
      send({ type: 'create_delivery', workspaceName, title: 'Delivery transition e2e' })
      void runAssertions()
      break
    }

    case 'create_delivery_result':
      if (!deliveryId) deliveryId = msg.delivery.id
      break

    case 'delivery_detail':
      detail = msg
      break

    case 'delivery_transition_failed':
      refusals.push(msg)
      break

    case 'error':
      errors.push(msg.error?.code ?? '?')
      break
  }
})

// ---- Assertions ----

async function runAssertions() {
  phase = 'await-delivery'
  for (let i = 0; i < POLL_TRIES && !deliveryId; i++) await sleep(POLL_MS)
  if (!deliveryId) {
    failures.push('delivery was never created')
    finish()
    return
  }
  await waitForDetail(() => detail?.delivery?.status === 'planned', 'the fresh delivery is planned')
  check(detail?.delivery?.status === 'planned', 'a fresh delivery starts at planned')
  check(detail?.delivery?.branchReady === false, 'it has no delivery branch yet')

  // ---- 1. an UNREACHABLE edge ----
  phase = 'unreachable-edge'
  const unreachable = await attempt('delivered')
  check(!!unreachable, 'an unreachable transition answers with a delivery_transition_failed frame')
  check(
    unreachable?.code === 'delivery.invalidStatusTransition',
    'planned → delivered is refused as invalidStatusTransition (the edge is not in the graph)',
  )
  check(
    (unreachable?.reasons ?? []).length === 0,
    'an unreachable edge carries NO guard gaps — there is nothing to close',
  )
  check(
    unreachable?.currentStatus === 'planned' && unreachable?.to === 'delivered',
    'the refusal echoes both the current status and the attempted target',
  )
  check(unreachable?.deliveryId === deliveryId, 'the refusal names the delivery it is about')

  // ---- 2. a REACHABLE but GUARD-BLOCKED edge ----
  phase = 'guard-blocked-edge'
  const blocked = await attempt('integrating')
  check(
    blocked?.code === 'delivery.transitionGuardFailed',
    'planned → integrating is refused as transitionGuardFailed (reachable, but blocked)',
  )
  check(
    (blocked?.reasons ?? []).some((r) => r.code === 'delivery.guard.branchNotReady'),
    'the refusal carries the STRUCTURED gap delivery.guard.branchNotReady',
  )
  check(
    blocked?.currentStatus === 'planned' && blocked?.to === 'integrating',
    'the blocked refusal echoes the current status and the attempted target too',
  )
  check(
    blocked?.code !== unreachable?.code,
    '「不可达」 and 「未满足」 are DIFFERENT codes — the page must not conflate them',
  )

  // ---- 3. the plan never OFFERS an illegal target ----
  phase = 'plan-shape'
  check(!!targetFor('integrating'), 'the plan offers the one legal progress target from planned')
  check(
    !targetFor('delivered') && !targetFor('verifying') && !targetFor('verified'),
    'the plan offers NO unreachable target — the refusals above are the backstop, not the UI path',
  )
  const blockedTarget = targetFor('integrating')
  check(
    blockedTarget?.guard === 'failed' &&
      (blockedTarget?.reasons ?? []).some((r) => r.code === 'delivery.guard.branchNotReady'),
    'the plan reports the SAME gap the refusal did (one source, recomputed on every read)',
  )

  // ---- 4. nothing was written by any refusal so far ----
  phase = 'no-write'
  await waitForDetail(() => detail?.delivery?.status === 'planned', 'still planned')
  check(
    detail?.delivery?.status === 'planned',
    'the delivery never moved — a refusal writes nothing',
  )
  check(errors.length === 0, 'a refused transition never degrades into a generic error frame')

  // ---- 5. a SYSTEM-ONLY edge is refused for a human caller ----
  // `verified → delivered` is what the forge's merge drives; a human clicking it
  // must be refused with the systemOnly gap rather than shipping an unmerged
  // delivery. Reaching `verified` honestly needs a branch, associations and a
  // forge, so the status is seeded and only the REFUSAL is exercised over the wire.
  phase = 'system-only-edge'
  if (!DB_PATH || !DatabaseSync) {
    console.log('[e2e] skip — C3_DB_PATH / node:sqlite unavailable, cannot seed `verified`')
  } else {
    forceStatus('verified')
    await waitForDetail(() => detail?.delivery?.status === 'verified', 'seeded verified')
    const systemOnly = await attempt('delivered')
    check(
      systemOnly?.code === 'delivery.transitionGuardFailed',
      'verified → delivered by a human is refused as transitionGuardFailed',
    )
    check(
      (systemOnly?.reasons ?? []).some((r) => r.code === 'delivery.guard.systemOnly'),
      'the refusal carries the delivery.guard.systemOnly gap — only the forge fact may land it',
    )
    check(
      systemOnly?.currentStatus === 'verified' && systemOnly?.to === 'delivered',
      'the system-only refusal echoes the current status and the attempted target',
    )
    await waitForDetail(() => detail?.delivery?.status === 'verified', 'still verified')
    check(
      detail?.delivery?.status === 'verified',
      'the delivery stayed verified — the system-only refusal wrote nothing either',
    )
  }

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
