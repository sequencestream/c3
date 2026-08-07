#!/usr/bin/env node
/**
 * End-to-end test for the DEPENDENCY GATE's three states over the real wire.
 *
 * The gate no longer asks "is the dependency's PR merged" but "**is the
 * dependency's output on my base**", and the answer depends on the session's
 * delivery context. This suite drives all three readings through the live server
 * and asserts that each produces its OWN explanation — the whole point of the
 * change is that a user can tell the three apart.
 *
 * Scenario — a throwaway git workspace (no remote), two deliveries, four intents:
 *
 *   DepSame  — `done`, on its own branch, linked to delivery X, PR toward X
 *   DepCross — `done`, on its own branch, linked to delivery Y (not `delivered`)
 *   DepPlain — `done`, on its own branch, no delivery, PR unmerged
 *   Target   — linked to delivery X; depends on one of the above per section
 *
 * PASS asserts:
 *
 *  1. SAME delivery, PR toward it unmerged → `intent.dependencyPrUnmergedInDelivery`
 *     (names the delivery both sides share).
 *  2. CROSS delivery, the dependency's delivery not `delivered` →
 *     `intent.dependencyDeliveryNotDelivered` (names the OTHER delivery, and
 *     carries its id so the page can link to it).
 *  3. NO delivery on either side → the historic `intent.dependencyNotMerged`,
 *     unchanged.
 *  4. Each state OPENS on its own terms: the same-delivery PR merging, and the
 *     cross delivery reaching `delivered`, each clear the block.
 *
 * NO AGENT TOKENS ARE SPENT: no session is ever started. The three BLOCKED states
 * are asserted through the real `start_development` launch gate (which refuses
 * before any git or agent work). The OPEN states are asserted through the intent
 * projection's `actionDescriptor`, which is computed from the SAME shared
 * criterion — driving the launch gate to a pass would start a real session and
 * spend tokens, which an e2e suite must never do.
 *
 * Needs `C3_DB_PATH` pointing at the server's ledger (the suite runner passes it)
 * to seed branch names and PR rows; without it the test SKIPs (exit 5).
 *
 * Usage:
 *   pnpm start --port 13000                        # in another terminal
 *   C3_DB_PATH=~/.c3/c3.db node scripts/e2e/e2e-dependency-gate-test.mjs [ws-url]
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
  console.error('[e2e] C3_DB_PATH not set — cannot seed branch/PR rows; SKIP')
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
const PROJECT_DIR = mkdtempSync('/tmp/c3-dep-gate-')
writeFileSync(`${PROJECT_DIR}/README.md`, '# Dependency gate e2e\n')
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

/**
 * PR numbers are unique per (forge, repo, number) across the WHOLE ledger, so a
 * re-run against the same db would collide on fixed numbers. Namespace them per
 * run instead of clearing the table — the suite never deletes another test's data.
 */
const RUN = String(Date.now() % 1_000_000)

const ws = new WebSocket(URL)

// ---- State ----
let workspaceId = null
let phase = 'boot'
const ids = {}
const deliveries = {}
let intents = []
/** Errors keyed by arrival order; each assertion snapshots the length first. */
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

const db = (fn) => {
  const conn = new DatabaseSync(DB_PATH)
  try {
    conn.exec('PRAGMA busy_timeout=5000;')
    return fn(conn)
  } finally {
    conn.close()
  }
}

/** Give an intent its own development branch (what a real work session leaves). */
const seedBranch = (intentId, branch) =>
  db((c) => c.prepare('UPDATE intents SET branch_name=? WHERE id=?').run(branch, intentId))

/** One `intent_prs` row — toward a delivery, or delivery-less when `delivery` is null. */
const seedPr = (intentId, number, status, delivery) =>
  db((c) => {
    const now = Date.now()
    c.prepare(
      `INSERT INTO intent_prs
         (id, intent_id, delivery_id, forge, repo, number, url, status, head_branch, base_branch, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      randomUUID(),
      intentId,
      delivery,
      'github',
      'o/r',
      number,
      `https://github.com/o/r/pull/${number}`,
      status,
      `intent/${number}`,
      delivery ? 'delivery/x' : 'main',
      now,
      now,
    )
  })

const setPrStatus = (intentId, status, delivery) =>
  db((c) =>
    delivery
      ? c
          .prepare('UPDATE intent_prs SET status=? WHERE intent_id=? AND delivery_id=?')
          .run(status, intentId, delivery)
      : c
          .prepare('UPDATE intent_prs SET status=? WHERE intent_id=? AND delivery_id IS NULL')
          .run(status, intentId),
  )

/** Poll the intent list until `predicate` holds against the freshest frame. */
async function waitForIntents(predicate, label) {
  for (let i = 0; i < POLL_TRIES; i++) {
    send({ type: 'list_intents', workspaceId })
    await sleep(POLL_MS)
    if (intents.length && predicate()) return true
  }
  console.log(`[e2e] gave up waiting for: ${label}`)
  return false
}

const intentFor = (id) => intents.find((i) => i.id === id) ?? null

/**
 * Fire `start_development` and return the error it produced, or `null` when the
 * launch was NOT refused. Every state under test refuses before any git or agent
 * work, so nothing is started and no token is spent.
 */
async function launchError(intentId) {
  const before = errors.length
  send({ type: 'start_development', workspaceId, intentId })
  for (let i = 0; i < POLL_TRIES; i++) {
    await sleep(POLL_MS)
    if (errors.length > before) return errors[errors.length - 1]
  }
  return null
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
      // The gate's delivery readings only apply in worktree mode; SDD off so an
      // unapproved spec never stands in for a dependency refusal.
      phase = 'workspace-setting'
      send({
        type: 'save_workspace_setting',
        workspaceId,
        config: { gitBranchMode: 'worktree', defaultMainBranch: 'main', sddEnabled: false },
      })
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
        content: `dependency gate e2e ${label}`,
      })
      // A fresh intent is `draft`; only `todo` is a launchable state, and the
      // status gate sits ABOVE the dependency gate this suite is about.
      send({ type: 'update_intent_status', intentId: msg.intent.id, status: 'todo' })
      seedNextIntent()
      break
    }

    case 'create_delivery_result':
      deliveries[msg.delivery.title] = msg.delivery.id
      break

    case 'intents':
      intents = msg.items ?? []
      break

    case 'error':
      errors.push(msg.error ?? { code: '?' })
      break
  }
})

// ---- Intent + delivery setup ----
const LABELS = ['DepSame', 'DepCross', 'DepPlain', 'Target']
let created = 0

function seedNextIntent() {
  if (created < LABELS.length) {
    send({ type: 'create_intent', workspaceId })
    return
  }
  phase = 'create-deliveries'
  send({ type: 'create_delivery', workspaceId, title: 'X' })
  send({ type: 'create_delivery', workspaceId, title: 'Y' })
  void runAssertions()
}

// ---- Assertions ----

/** Whether the read-model still explains this intent as dependency-blocked. */
const blockedByDependency = (id) =>
  intentFor(id)?.actionDescriptor?.labelCode === 'dependency_blocked'

async function runAssertions() {
  phase = 'await-deliveries'
  for (let i = 0; i < POLL_TRIES && !(deliveries.X && deliveries.Y); i++) await sleep(POLL_MS)
  if (!deliveries.X || !deliveries.Y) {
    failures.push('deliveries were never created')
    finish()
    return
  }

  // Every dependency is finished and sits on its OWN branch — the state in which
  // "is its output on my base" is a real question rather than a trivial one.
  // `done` is only reachable via `in_progress` (the 7-state graph), so the
  // promotion is two hops — not a shortcut the ledger would refuse.
  for (const label of ['DepSame', 'DepCross', 'DepPlain']) {
    send({ type: 'update_intent_status', intentId: ids[label], status: 'in_progress' })
    seedBranch(ids[label], `intent/${label.toLowerCase()}`)
  }
  await sleep(POLL_MS * 2)
  for (const label of ['DepSame', 'DepCross', 'DepPlain']) {
    send({ type: 'update_intent_status', intentId: ids[label], status: 'done' })
  }
  await sleep(POLL_MS * 2)
  send({
    type: 'link_intent_to_delivery',
    workspaceId,
    deliveryId: deliveries.X,
    intentId: ids.Target,
  })
  send({
    type: 'link_intent_to_delivery',
    workspaceId,
    deliveryId: deliveries.X,
    intentId: ids.DepSame,
  })
  send({
    type: 'link_intent_to_delivery',
    workspaceId,
    deliveryId: deliveries.Y,
    intentId: ids.DepCross,
  })
  seedPr(ids.DepSame, `${RUN}1`, 'reviewing', deliveries.X)
  seedPr(ids.DepCross, `${RUN}2`, 'merged', deliveries.Y)
  seedPr(ids.DepPlain, `${RUN}3`, 'reviewing', null)
  await sleep(POLL_MS * 4)

  // ---- 1. SAME delivery: the PR toward MY delivery is not merged ----
  phase = 'same-delivery'
  send({
    type: 'update_intent_deps',
    intentId: ids.Target,
    deps: [{ dependsOnId: ids.DepSame, depType: 'blocks' }],
  })
  await waitForIntents(() => blockedByDependency(ids.Target), 'Target blocked by DepSame')
  check(blockedByDependency(ids.Target), 'same-delivery unmerged PR blocks the target')

  let err = await launchError(ids.Target)
  check(
    err?.code === 'intent.dependencyPrUnmergedInDelivery',
    `same-delivery block explains itself as a delivery PR (${err?.code})`,
  )
  check(err?.params?.deliveryId === deliveries.X, 'it names the delivery BOTH sides share')

  // …and opens when that PR merges.
  setPrStatus(ids.DepSame, 'merged', deliveries.X)
  await waitForIntents(() => !blockedByDependency(ids.Target), 'Target released by merge')
  check(!blockedByDependency(ids.Target), 'the same-delivery block clears once the PR merges')

  // ---- 2. CROSS delivery: the dependency's delivery is not on mainline ----
  phase = 'cross-delivery'
  send({
    type: 'update_intent_deps',
    intentId: ids.Target,
    deps: [{ dependsOnId: ids.DepCross, depType: 'blocks' }],
  })
  await waitForIntents(() => blockedByDependency(ids.Target), 'Target blocked by DepCross')
  check(
    blockedByDependency(ids.Target),
    'a dependency merged into ANOTHER delivery still blocks — merged ≠ on my base',
  )

  err = await launchError(ids.Target)
  check(
    err?.code === 'intent.dependencyDeliveryNotDelivered',
    `cross-delivery block explains itself as a delivery, not a PR (${err?.code})`,
  )
  check(
    err?.params?.deliveryId === deliveries.Y,
    'it names the OTHER delivery, so the page can link to it',
  )

  // …and opens only when that delivery reaches mainline.
  db((c) => c.prepare("UPDATE deliveries SET status='delivered' WHERE id=?").run(deliveries.Y))
  await waitForIntents(() => !blockedByDependency(ids.Target), 'Target released by delivered')
  check(
    !blockedByDependency(ids.Target),
    'the cross-delivery block clears only when that delivery is delivered',
  )

  // ---- 3. NO delivery: the historic criterion, unchanged ----
  phase = 'no-delivery'
  send({
    type: 'unlink_intent_from_delivery',
    workspaceId,
    deliveryId: deliveries.X,
    intentId: ids.Target,
  })
  send({
    type: 'update_intent_deps',
    intentId: ids.Target,
    deps: [{ dependsOnId: ids.DepPlain, depType: 'blocks' }],
  })
  await waitForIntents(() => blockedByDependency(ids.Target), 'Target blocked by DepPlain')
  check(blockedByDependency(ids.Target), 'a delivery-less unmerged dependency still blocks')

  err = await launchError(ids.Target)
  check(
    err?.code === 'intent.dependencyNotMerged',
    `the delivery-less path keeps its historic code (${err?.code})`,
  )

  setPrStatus(ids.DepPlain, 'merged', null)
  await waitForIntents(() => !blockedByDependency(ids.Target), 'Target released by plain merge')
  check(!blockedByDependency(ids.Target), 'the delivery-less block clears once the PR merges')

  finish()
}

function finish() {
  if (finished) return
  finished = true
  clearTimeout(timeout)
  try {
    ws.close()
  } catch {
    /* noop */
  }
  rmSync(PROJECT_DIR, { recursive: true, force: true })
  if (failures.length) {
    console.error(`\n[e2e] FAILED (${failures.length}):`)
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log('\n[e2e] PASS — dependency gate three states')
  process.exit(0)
}

ws.addEventListener('error', (err) => {
  failures.push(`websocket error: ${err?.message ?? err}`)
  finish()
})
