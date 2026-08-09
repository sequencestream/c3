#!/usr/bin/env node
/**
 * End-to-end test for CREATING AN INTENT WITH A CHOSEN BASE BRANCH over the real
 * wire protocol — the request the 「+」 create dialog sends.
 *
 * Scenario — a throwaway git workspace (no remote) whose main branch is
 * `trunk`, plus two deliveries: one with a ready branch, one never initialized.
 *
 * PASS asserts the facts the base-branch choice exists to guarantee:
 *
 *  1. `{ kind: 'branch' }` persists exactly that branch name.
 *  2. `{ kind: 'delivery' }` persists the DELIVERY'S branch, read by the server
 *     from its own records — the request never carries a branch name, so a
 *     client cannot assert a mapping the ledger disagrees with — AND writes the
 *     association edge, so choosing a delivery means being linked to it. A
 *     branch source writes no edge at all.
 *  3. No `base` at all keeps the pre-existing behaviour: the workspace's own
 *     main branch (`trunk` here, so this cannot pass by accidentally matching a
 *     hardcoded `main`).
 *  4. Every refusal leaves NOTHING behind — no half-written intent. Covered:
 *     a delivery from another workspace, a delivery whose branch was never
 *     initialized, and a blank branch name. A refusal must never silently
 *     degrade to the main branch, which is the whole point of the snapshot.
 *  5. `create_intent_result` names the exact server id, and that id is the one
 *     that shows up in the `intents` snapshot — the console never has to guess
 *     by title or list position.
 *
 * WHAT THIS DOES NOT COVER — and why:
 *
 *  - The `content` → owner-session path. A create carrying content continues
 *    into a real agent run, so asserting it here would spend tokens on a fact
 *    that is already pinned MORE precisely by
 *    `server/src/features/intents/create-intent.test.ts`: the first prompt handed
 *    to `launchRun` is asserted EQUAL to the shared
 *    `buildIntentSessionFirstPrompt` output for that record, and the
 *    launch-failure case asserts the session is unwound while the intent keeps
 *    its content and base. A black-box e2e could only assert something weaker.
 *  - The console landing on the intent-session tab, and the create-result /
 *    snapshot arrival order not misfiring the jump. Both are browser-side state,
 *    invisible to this protocol-level suite; they are covered by
 *    `web/src/controls/message-handler.test.ts` and
 *    `web/src/pages/intents/components/CreateIntentDialog/CreateIntentDialog.test.ts`.
 *
 * NO AGENT TOKENS ARE SPENT: no session is ever started (no create carries
 * content).
 *
 * Needs `C3_DB_PATH` pointing at the server's ledger (the suite runner passes it)
 * to read back `intents.base_branch` and to mark a delivery branch ready without
 * a remote; without it the test SKIPs (exit 5).
 *
 * Usage:
 *   pnpm build && node scripts/e2e/isolated-server.mjs --port 13000 --db /tmp/c3-e2e/c3.db   # in another terminal
 *   C3_DB_PATH=/tmp/c3-e2e/c3.db node scripts/e2e/e2e-create-intent-test.mjs [ws-url]
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'

const URL = process.argv[2] || 'ws://localhost:13000/ws'
const TIMEOUT_MS = 60_000
const POLL_MS = 150
const POLL_TRIES = 40
const DB_PATH = process.env.C3_DB_PATH
/** The workspace main branch — deliberately NOT `main`, so a hardcoded default fails. */
const MAIN_BRANCH = 'trunk'
/** The ready delivery's branch, and the value case 2 must persist. */
const DELIVERY_BRANCH = 'delivery/ready-e2e'

if (!DB_PATH) {
  console.error('[e2e] C3_DB_PATH not set — cannot read back base_branch; SKIP')
  process.exit(5)
}

let DatabaseSync
try {
  ;({ DatabaseSync } = await import('node:sqlite'))
} catch (err) {
  console.error('[e2e] node:sqlite unavailable — SKIP:', err?.message ?? err)
  process.exit(5)
}

// ---- Seed two throwaway git workspaces under /tmp (no remote, on purpose) ----
function seedRepo(prefix) {
  const dir = mkdtempSync(prefix)
  writeFileSync(`${dir}/README.md`, '# Create intent e2e\n')
  execFileSync('git', ['init', '-q', '-b', MAIN_BRANCH], { cwd: dir })
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync(
    'git',
    ['-c', 'user.email=e2e@c3', '-c', 'user.name=c3 e2e', 'commit', '-qm', 'init'],
    { cwd: dir },
  )
  return dir
}

let PROJECT_DIR
let OTHER_DIR
try {
  PROJECT_DIR = seedRepo('/tmp/c3-create-intent-')
  OTHER_DIR = seedRepo('/tmp/c3-create-intent-other-')
} catch (err) {
  console.error('[e2e] git seed failed — SKIP:', err?.message ?? err)
  if (PROJECT_DIR) rmSync(PROJECT_DIR, { recursive: true, force: true })
  if (OTHER_DIR) rmSync(OTHER_DIR, { recursive: true, force: true })
  process.exit(5)
}

console.log(`[e2e] workspace: ${PROJECT_DIR}`)
console.log(`[e2e] other workspace: ${OTHER_DIR}`)
console.log(`[e2e] connecting ${URL}`)

const ws = new WebSocket(URL)

// ---- State ----
let workspaceId = null
let otherWorkspaceId = null
let phase = 'boot'
let intents = []
/** Deliveries created by this run, by label. */
const deliveries = {}
/** The most recent `create_intent_result`, consumed by the section that awaited it. */
let lastCreated = null
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

/** Read one intent's persisted base branch straight from the ledger. */
function baseBranchOf(intentId) {
  const db = new DatabaseSync(DB_PATH)
  try {
    db.exec('PRAGMA busy_timeout=5000;')
    return (
      db.prepare('SELECT base_branch FROM intents WHERE id=?').get(intentId)?.base_branch ?? null
    )
  } finally {
    db.close()
  }
}

/** The deliveries this intent is associated with, straight from the edge table. */
function linkedDeliveryIdsOf(intentId) {
  const db = new DatabaseSync(DB_PATH)
  try {
    db.exec('PRAGMA busy_timeout=5000;')
    return db
      .prepare('SELECT delivery_id FROM intent_deliveries WHERE intent_id=?')
      .all(intentId)
      .map((r) => r.delivery_id)
  } finally {
    db.close()
  }
}

/** How many intents this workspace holds — the "a refusal wrote nothing" probe. */
function intentCount(dir = PROJECT_DIR) {
  const db = new DatabaseSync(DB_PATH)
  try {
    db.exec('PRAGMA busy_timeout=5000;')
    return db.prepare('SELECT COUNT(*) AS c FROM intents WHERE workspace_path=?').get(dir)?.c ?? 0
  } finally {
    db.close()
  }
}

/**
 * Mark a delivery's branch ready without a remote. `init_delivery_branch` needs
 * one to push to, and this test is about the CREATE's base resolution, not about
 * branch initialization — so the ready state is written directly, exactly as the
 * successful init would leave it.
 */
function markBranchReady(deliveryId, branch) {
  const db = new DatabaseSync(DB_PATH)
  try {
    db.exec('PRAGMA busy_timeout=5000;')
    db.prepare('UPDATE deliveries SET branch_name=?, branch_ready=1, updated_at=? WHERE id=?').run(
      branch,
      Date.now(),
      deliveryId,
    )
  } finally {
    db.close()
  }
}

/** Send one create and resolve with its result id, or null when it was refused. */
async function createIntent(payload, label) {
  lastCreated = null
  const before = errors.length
  send({ type: 'create_intent', workspaceId, ...payload })
  for (let i = 0; i < POLL_TRIES; i++) {
    await sleep(POLL_MS)
    if (lastCreated) return lastCreated.intent.id
    if (errors.length > before) return null
  }
  console.log(`[e2e] gave up waiting for: ${label}`)
  return null
}

/** Poll the intent list until `predicate` holds. */
async function waitForIntents(predicate, label) {
  for (let i = 0; i < POLL_TRIES; i++) {
    send({ type: 'list_intents', workspaceId })
    await sleep(POLL_MS)
    if (intents.length && predicate()) return true
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
      send({ type: 'add_workspace', path: OTHER_DIR })
      break

    case 'workspaces': {
      if (workspaceId && otherWorkspaceId) break
      const name = PROJECT_DIR.split('/').pop()
      const otherName = OTHER_DIR.split('/').pop()
      workspaceId = msg.workspaces?.find((w) => w.name === name)?.id ?? workspaceId
      otherWorkspaceId = msg.workspaces?.find((w) => w.name === otherName)?.id ?? otherWorkspaceId
      if (!workspaceId || !otherWorkspaceId) break
      phase = 'seed-deliveries'
      send({ type: 'create_delivery', workspaceId, title: 'Ready delivery' })
      break
    }

    case 'create_delivery_result':
      if (!deliveries.ready) {
        deliveries.ready = msg.delivery.id
        markBranchReady(msg.delivery.id, DELIVERY_BRANCH)
        // A second delivery that never gets a branch — the "not ready" refusal.
        send({ type: 'create_delivery', workspaceId, title: 'Unready delivery' })
      } else if (!deliveries.unready) {
        deliveries.unready = msg.delivery.id
        // Third: one owned by the OTHER workspace — the cross-workspace refusal.
        send({ type: 'create_delivery', workspaceId: otherWorkspaceId, title: 'Foreign delivery' })
      } else if (!deliveries.foreign) {
        deliveries.foreign = msg.delivery.id
        markBranchReady(msg.delivery.id, 'delivery/foreign-e2e')
        void runAssertions()
      }
      break

    case 'create_intent_result':
      lastCreated = msg
      break

    case 'intents':
      intents = msg.items ?? []
      break

    case 'error':
      errors.push(msg.error?.code ?? '?')
      break
  }
})

// ---- Assertions ----

async function runAssertions() {
  // 1) An explicit branch is persisted verbatim.
  phase = 'base-branch'
  const branchId = await createIntent(
    { base: { kind: 'branch', branch: 'feature/from-dialog' } },
    'branch-based create',
  )
  check(!!branchId, 'a branch-based create succeeds')
  check(
    baseBranchOf(branchId) === 'feature/from-dialog',
    'branch source persists exactly the submitted branch',
  )
  check(linkedDeliveryIdsOf(branchId).length === 0, 'branch source creates no delivery association')

  // 2) A delivery contributes its OWN branch, resolved server-side.
  phase = 'base-delivery'
  const deliveryIntentId = await createIntent(
    { base: { kind: 'delivery', deliveryId: deliveries.ready } },
    'delivery-based create',
  )
  check(!!deliveryIntentId, 'a delivery-based create succeeds')
  check(
    baseBranchOf(deliveryIntentId) === DELIVERY_BRANCH,
    "delivery source persists the delivery's own branch",
  )
  // Choosing a delivery is choosing the delivery, not just its branch name: the
  // association edge lands in the same create, with no second "link" round trip.
  check(
    JSON.stringify(linkedDeliveryIdsOf(deliveryIntentId)) === JSON.stringify([deliveries.ready]),
    'delivery source also associates the intent with that delivery',
  )

  // 3) No choice at all → the workspace's main branch, unchanged behaviour.
  phase = 'base-default'
  const defaultId = await createIntent({}, 'create with no base')
  check(!!defaultId, 'a create with no base succeeds')
  check(
    baseBranchOf(defaultId) === MAIN_BRANCH,
    `no base falls back to the workspace main branch (${MAIN_BRANCH})`,
  )

  // 4) Refusals write nothing. Each is checked against the count BEFORE it.
  phase = 'refusals'
  for (const [payload, label] of [
    [
      { base: { kind: 'delivery', deliveryId: deliveries.foreign } },
      'a delivery from another workspace',
    ],
    [{ base: { kind: 'delivery', deliveryId: deliveries.unready } }, 'a delivery with no branch'],
    [{ base: { kind: 'delivery', deliveryId: 'no-such-delivery' } }, 'an unknown delivery'],
    [{ base: { kind: 'branch', branch: '   ' } }, 'a blank branch name'],
  ]) {
    const before = intentCount()
    const id = await createIntent(payload, label)
    check(id === null, `${label} is refused`)
    check(intentCount() === before, `${label} leaves no intent behind`)
  }

  // 5) The exact returned id is the one that lands in the snapshot.
  phase = 'exact-id'
  const landed = await waitForIntents(
    () => intents.some((i) => i.id === branchId),
    'the created intent in the list',
  )
  check(landed, 'the id from create_intent_result appears in the intents snapshot')
  check(
    intents.filter((i) => i.id === branchId).length === 1,
    'that id appears exactly once (no duplicate registration)',
  )

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
  rmSync(OTHER_DIR, { recursive: true, force: true })

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
