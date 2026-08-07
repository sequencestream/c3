#!/usr/bin/env node
/**
 * End-to-end test for the INTENT ↔ DELIVERY ASSOCIATION over the real wire
 * protocol: link, both-sides visibility, and every unlink guard that can be
 * driven deterministically without a live forge.
 *
 * Scenario — a throwaway git workspace (no remote), one delivery, two intents:
 *
 *   Alpha — gets an `intent_prs` row toward the delivery, seeded straight into
 *           the ledger (the state a real `create_pr` would leave behind)
 *   Beta  — no PR at all
 *
 * PASS asserts the properties the association exists to guarantee:
 *
 *  1. Linking is visible from BOTH sides: the delivery detail lists the intent,
 *     and the intent's own projection names the delivery.
 *  2. The delivery detail's PR column is the intent's PR TOWARD THIS DELIVERY.
 *  3. An intent with no PR unlinks cleanly; the edge disappears.
 *  4. A MERGED PR can never be unlinked (`delivery.unlinkMergedPrDenied`) and the
 *     edge survives the refusal — the black hole this guard exists for.
 *  5. When the forge's live state cannot be read, the unlink is BLOCKED
 *     (`delivery.unlinkPrStatusCheckFailed`), not guessed. This is also the only
 *     honest thing the suite can assert about a non-merged PR: the workspace has
 *     no remote and no authenticated forge CLI, so the lookup genuinely fails.
 *  6. Cancelling the delivery does NOT drop the association edges (history stays
 *     queryable).
 *
 * WHAT THIS DOES NOT COVER — and why. The "unmerged PR is CLOSED, then the edge
 * and PR row are dropped" path needs a forge that answers `pr view` and accepts
 * `pr close`. That cannot be provoked deterministically in a sandboxed repo with
 * no remote, and faking a CLI on PATH would fake exactly the boundary under test.
 * That chain — forge says reviewing → `closeForgePr` → PR row deleted → edge
 * deleted → `integration.total` drops, plus the already-closed-is-success and
 * close-failure-blocks branches — is covered by
 * `server/src/features/deliveries/index.test.ts` ("link / unlink intent ↔
 * delivery"), which injects the forge results directly.
 *
 * NO AGENT TOKENS ARE SPENT: no session is ever started.
 *
 * Needs `C3_DB_PATH` pointing at the server's ledger (the suite runner passes it)
 * to seed the PR rows; without it the test SKIPs (exit 5).
 *
 * Usage:
 *   pnpm start --port 13000                        # in another terminal
 *   C3_DB_PATH=~/.c3/c3.db node scripts/e2e/e2e-delivery-link-test.mjs [ws-url]
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const URL = process.argv[2] || 'ws://localhost:13000/ws'
const TIMEOUT_MS = 60_000
const POLL_MS = 150
const POLL_TRIES = 40
const DB_PATH = process.env.C3_DB_PATH

if (!DB_PATH) {
  console.error('[e2e] C3_DB_PATH not set — cannot seed PR rows; SKIP')
  process.exit(5)
}

let DatabaseSync
try {
  ;({ DatabaseSync } = await import('node:sqlite'))
} catch (err) {
  console.error('[e2e] node:sqlite unavailable — SKIP:', err?.message ?? err)
  process.exit(5)
}

// ---- Seed a throwaway git workspace under /tmp (no remote, on purpose) ----
const PROJECT_DIR = mkdtempSync('/tmp/c3-delivery-link-')
writeFileSync(`${PROJECT_DIR}/README.md`, '# Delivery link e2e\n')
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
let deliveryId = null
const ids = {}
let detail = null
let intents = []
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
    if (detail && predicate()) return true
  }
  console.log(`[e2e] gave up waiting for: ${label}`)
  return false
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

/** Write one `intent_prs` row straight into the ledger (what a real PR leaves). */
function seedPrRow(intentId, number, status) {
  const db = new DatabaseSync(DB_PATH)
  try {
    db.exec('PRAGMA busy_timeout=5000;')
    const now = Date.now()
    db.prepare(
      `INSERT INTO intent_prs
         (id, intent_id, delivery_id, forge, repo, number, url, status, head_branch, base_branch, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      randomUUID(),
      intentId,
      deliveryId,
      'github',
      'o/r',
      number,
      `https://github.com/o/r/pull/${number}`,
      status,
      'feat/alpha',
      'delivery/e2e',
      now,
      now,
    )
  } finally {
    db.close()
  }
}

/** Move a seeded PR row to another status (merged → reviewing, …). */
function setPrRowStatus(intentId, status) {
  const db = new DatabaseSync(DB_PATH)
  try {
    db.exec('PRAGMA busy_timeout=5000;')
    db.prepare('UPDATE intent_prs SET status=? WHERE intent_id=? AND delivery_id=?').run(
      status,
      intentId,
      deliveryId,
    )
  } finally {
    db.close()
  }
}

/** Whether the ledger still holds the (delivery, intent) association edge. */
function edgeExists(intentId) {
  const db = new DatabaseSync(DB_PATH)
  try {
    db.exec('PRAGMA busy_timeout=5000;')
    return !!db
      .prepare('SELECT 1 FROM intent_deliveries WHERE delivery_id=? AND intent_id=?')
      .get(deliveryId, intentId)
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
        content: `delivery link e2e ${label}`,
      })
      seedNextIntent()
      break
    }

    case 'create_delivery_result':
      deliveryId = msg.delivery.id
      break

    case 'delivery_detail':
      detail = msg
      break

    case 'intents':
      intents = msg.items ?? []
      break

    case 'error':
      errors.push(msg.error?.code ?? '?')
      break
  }
})

// ---- Intent + delivery setup ----
const LABELS = ['Alpha', 'Beta']
let created = 0

function seedNextIntent() {
  if (created < LABELS.length) {
    send({ type: 'create_intent', workspaceId })
    return
  }
  phase = 'create-delivery'
  send({ type: 'create_delivery', workspaceId, title: 'Delivery link e2e' })
  void runAssertions()
}

// ---- Assertions ----

const rowFor = (intentId) => detail?.associatedIntents?.find((r) => r.id === intentId) ?? null
const intentFor = (intentId) => intents.find((i) => i.id === intentId) ?? null

async function runAssertions() {
  phase = 'await-delivery'
  for (let i = 0; i < POLL_TRIES && !deliveryId; i++) await sleep(POLL_MS)
  if (!deliveryId) {
    failures.push('delivery was never created')
    finish()
    return
  }

  // ---- 1. link both intents; both sides must see it ----
  phase = 'link'
  send({ type: 'link_intent_to_delivery', workspaceId, deliveryId, intentId: ids.Alpha })
  send({ type: 'link_intent_to_delivery', workspaceId, deliveryId, intentId: ids.Beta })
  await waitForDetail(() => (detail?.associatedIntents?.length ?? 0) === 2, 'two intents linked')
  check(
    (detail?.associatedIntents?.length ?? 0) === 2,
    'the delivery detail lists both linked intents',
  )
  check(rowFor(ids.Alpha)?.prStatus === null, 'a linked intent with no PR shows no PR status')

  await waitForIntents(
    () => (intentFor(ids.Alpha)?.linkedDeliveries?.length ?? 0) === 1,
    'the intent projection names the delivery',
  )
  check(
    intentFor(ids.Alpha)?.linkedDeliveries?.[0]?.id === deliveryId,
    'the intent side names the delivery it is linked to (both sides see the edge)',
  )

  // ---- 2. the PR column is the PR TOWARD THIS DELIVERY ----
  phase = 'seed-pr'
  seedPrRow(ids.Alpha, '101', 'merged')
  await waitForDetail(() => rowFor(ids.Alpha)?.prStatus === 'merged', 'Alpha PR shows as merged')
  check(
    rowFor(ids.Alpha)?.prStatus === 'merged',
    "the list shows the intent's PR toward THIS delivery",
  )
  check(
    rowFor(ids.Beta)?.prStatus === null,
    'an intent without a PR toward this delivery shows none',
  )
  check(detail?.delivery?.integration?.merged === 1, 'the N/M aggregate counts the merged PR')

  // ---- 3. an intent with no PR unlinks cleanly ----
  phase = 'unlink-no-pr'
  let errorsBefore = errors.length
  send({ type: 'unlink_intent_from_delivery', workspaceId, deliveryId, intentId: ids.Beta })
  await waitForDetail(() => !rowFor(ids.Beta), 'Beta unlinked')
  check(!rowFor(ids.Beta), 'an intent with no PR unlinks and leaves the list')
  check(edgeExists(ids.Beta) === false, 'the association edge is gone from the ledger')
  check(errors.length === errorsBefore, 'a PR-less unlink reports no error')

  // ---- 4. a MERGED PR can never be unlinked ----
  phase = 'unlink-merged'
  errorsBefore = errors.length
  send({ type: 'unlink_intent_from_delivery', workspaceId, deliveryId, intentId: ids.Alpha })
  await sleep(POLL_MS * 4)
  check(
    errors.slice(errorsBefore).includes('delivery.unlinkMergedPrDenied'),
    'unlinking a merged PR is refused with delivery.unlinkMergedPrDenied',
  )
  check(edgeExists(ids.Alpha) === true, 'the refused unlink left the association edge in place')

  // ---- 5. an unreadable forge state BLOCKS the unlink (never guessed) ----
  phase = 'unlink-status-check-failed'
  setPrRowStatus(ids.Alpha, 'reviewing')
  errorsBefore = errors.length
  send({ type: 'unlink_intent_from_delivery', workspaceId, deliveryId, intentId: ids.Alpha })
  await sleep(POLL_MS * 8)
  check(
    errors.slice(errorsBefore).includes('delivery.unlinkPrStatusCheckFailed'),
    'an unreadable forge status blocks the unlink instead of assuming "not merged"',
  )
  check(edgeExists(ids.Alpha) === true, 'the blocked unlink left the association edge in place')

  // ---- 6. cancelling the delivery keeps the edges (history stays queryable) ----
  phase = 'cancel-delivery'
  send({ type: 'cancel_delivery', workspaceId, deliveryId })
  await waitForDetail(() => detail?.delivery?.status === 'cancelled', 'delivery cancelled')
  check(detail?.delivery?.status === 'cancelled', 'the delivery reached the cancelled terminal')
  check(edgeExists(ids.Alpha) === true, 'cancelling a delivery does NOT drop its association edges')
  check(
    (detail?.associatedIntents ?? []).some((r) => r.id === ids.Alpha),
    'a cancelled delivery still lists its associated intents',
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
