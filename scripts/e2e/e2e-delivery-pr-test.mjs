#!/usr/bin/env node
/**
 * End-to-end test for the DELIVERY PR (「交付分支 → 主线」) over the real wire
 * protocol: the create gates, forge-first idempotency, all three failure layers,
 * and the `delivered` atomic write with its chained actions.
 *
 * ── Why this test spawns its OWN server
 *
 * Every other test in the suite shares one server. This one cannot: it needs the
 * forge to answer particular things on demand (merged / conflicting / red CI /
 * missing approval / unreachable), so it puts a scriptable `gh` stand-in
 * (`fixtures/fake-forge/gh`) on the PATH of a server it starts for itself. Doing
 * that to the SHARED server would silently answer `e2e-delivery-link-test.mjs`'s
 * lookups and destroy its premise — that test exists precisely to prove an
 * unreadable forge BLOCKS an unlink. The `[ws-url]` argument is therefore ignored;
 * the private instance gets its own port, ledger and settings.
 *
 * Scripting the forge is not faking the boundary under test. The subject here is
 * the SETTLEMENT chain — gate order, "ask the forge before creating", the layered
 * verdicts, and the single-transaction `delivered` write. The forge is that
 * chain's input, and every interesting input is one a sandboxed repo with no
 * remote can never produce. Everything downstream of the answer — handlers, state
 * machine, transaction, ledger, event, broadcasts — is the real thing.
 *
 * ── PASS asserts
 *
 *  1. `delivery_detail` always carries `deliveryPr` (null before one is opened).
 *  2. Gate order is fixed: not-`verified` is refused before the branch is even
 *     looked at; a branch holding nothing beyond mainline is refused; and
 *     `current-branch` refuses both actions outright.
 *  3. FORGE-FIRST IDEMPOTENCY: the create asks `pr list` BEFORE `pr create`, and a
 *     retry against a forge that now reports the PR adopts it — `pr create` is
 *     never invoked twice, and the ledger still holds exactly one row.
 *  4. The row records the REAL `origin/<base>` / `origin/<branch>` SHAs (the
 *     idempotency key's own material) and head/base branches.
 *  5. LAYER 1 — transient: an unreachable forge reports a retryable error and
 *     moves nothing: not the status, not the PR row, not the log.
 *  6. LAYER 2 — blocked: red CI and missing approvals both leave the delivery
 *     `verified` and only record `blocked_reason`. The code is fine, so the
 *     verification it already earned is not thrown away.
 *  7. LAYER 3 — conflict: a genuinely conflicting mainline sends the delivery back
 *     to `verifying`, with the REAL conflicting file enumerated by the local merge
 *     trial and a `merge_conflict` log line.
 *  8. `delivered` ATOMIC WRITE: once the forge reports merged, status + delivery
 *     log + PR row all settle together; the associated intent's status is NOT
 *     rewritten; and a repeat sync is idempotent (no second log line).
 *  9. Opening a delivery PR works from a NON-ADMIN connection — the forge's
 *     protected branches and approvals are the gate, never a second one in c3.
 *
 * The cross-delivery dependency gate unlocking on `delivered` is covered by
 * `e2e-dependency-gate-test.mjs`; the forge-answer normalization itself (GitHub vs
 * GitLab field shapes) is covered by `server/src/features/deliveries/`.
 *
 * NO AGENT TOKENS ARE SPENT: no session is ever started.
 *
 * Needs a built server (`pnpm build` → `server/dist/cli.cjs`); without it the test
 * SKIPs (exit 5). The suite runner builds by default.
 *
 * Usage:
 *   pnpm build && node scripts/e2e/e2e-delivery-pr-test.mjs
 */
import { spawn, execFileSync } from 'node:child_process'
import { connect } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { seedConfig } from './isolated-server.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const SERVER_CLI = join(ROOT, 'server', 'dist', 'cli.cjs')
const FAKE_FORGE_DIR = join(HERE, 'fixtures', 'fake-forge')

const PORT = Number(process.env.E2E_DELIVERY_PR_PORT) || 13141
const URL = `ws://localhost:${PORT}/ws`
const TIMEOUT_MS = 120_000
const POLL_MS = 150
const POLL_TRIES = 60
const BRANCH = 'delivery/e2e-pr'

if (!existsSync(SERVER_CLI)) {
  console.error(`[e2e] ${SERVER_CLI} missing — run \`pnpm build\` first; SKIP`)
  process.exit(5)
}

let DatabaseSync
try {
  ;({ DatabaseSync } = await import('node:sqlite'))
} catch (err) {
  console.error('[e2e] node:sqlite unavailable — SKIP:', err?.message ?? err)
  process.exit(5)
}

// ---- Private server state: own ledger, own settings, own forge script ----
const STATE_DIR = mkdtempSync(join(tmpdir(), 'c3-delivery-pr-state-'))
const DB_PATH = join(STATE_DIR, 'c3.db')
const FORGE_STATE = join(STATE_DIR, 'forge-state.json')
const FORGE_CALLS = join(STATE_DIR, 'forge-calls.log')
// Configuration seeded from the real database minus `auth.*` (same rule as the suite
// runner: this connection carries no token, and an auth-enabled config would gate the
// handshake).
seedConfig(DB_PATH)

/** Drive what the fake forge answers next. */
function setForge(state) {
  writeFileSync(FORGE_STATE, JSON.stringify(state, null, 2))
}
/** Every `gh` invocation so far, oldest first. */
function forgeCalls() {
  try {
    return readFileSync(FORGE_CALLS, 'utf-8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}
const countCalls = (prefix) => forgeCalls().filter((l) => l.startsWith(prefix)).length

setForge({ mode: 'ok', openPr: null, createNumber: '900' })

// ---- Throwaway git workspace with a bare origin ----
const PROJECT_DIR = mkdtempSync(join(tmpdir(), 'c3-delivery-pr-'))
const BARE_DIR = `${PROJECT_DIR}-remote.git`
const git = (...args) => execFileSync('git', args, { cwd: PROJECT_DIR, encoding: 'utf-8' }).trim()
try {
  writeFileSync(join(PROJECT_DIR, 'README.md'), '# Delivery PR e2e\n')
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@c3')
  git('config', 'user.name', 'c3 e2e')
  git('config', 'commit.gpgsign', 'false')
  git('add', '.')
  git('commit', '-qm', 'init')
  execFileSync('git', ['init', '--bare', '-q', BARE_DIR])
  git('remote', 'add', 'origin', BARE_DIR)
  git('push', '-q', '-u', 'origin', 'HEAD')
} catch (err) {
  console.error('[e2e] git seed failed — SKIP:', err?.message ?? err)
  cleanupDirs()
  process.exit(5)
}

function cleanupDirs() {
  for (const d of [PROJECT_DIR, BARE_DIR, STATE_DIR]) {
    rmSync(d, { recursive: true, force: true })
  }
}

// ---- Start the private server ----
console.log(`[e2e] workspace: ${PROJECT_DIR}`)
console.log(`[e2e] starting private server on :${PORT} (fake forge on PATH)`)
const server = spawn('node', [SERVER_CLI, 'start', '--port', String(PORT), '--db', DB_PATH], {
  cwd: ROOT,
  stdio: 'ignore',
  env: {
    ...process.env,
    C3_DB_PATH: DB_PATH,
    C3_E2E_FORGE_STATE: FORGE_STATE,
    PATH: `${FAKE_FORGE_DIR}:${process.env.PATH ?? ''}`,
  },
})
let serverExited = false
server.on('exit', () => {
  serverExited = true
})

async function waitForPort(port, tries = 120) {
  for (let i = 0; i < tries; i++) {
    const up = await new Promise((r) => {
      const sock = connect(port, '127.0.0.1')
      sock.on('connect', () => {
        sock.destroy()
        r(true)
      })
      sock.on('error', () => r(false))
    })
    if (up) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

if (!(await waitForPort(PORT))) {
  console.error(`[e2e] private server did not come up on :${PORT}`)
  server.kill('SIGKILL')
  cleanupDirs()
  process.exit(1)
}
console.log('[e2e] private server is up')

// ---- State ----
const ws = new WebSocket(URL)
let workspaceId = null
let phase = 'boot'
let deliveryId = null
let intentId = null
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Poll the open delivery's detail until `predicate` holds against the newest frame. */
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
 * Wait for an `error` frame with `code` after index `before`. Polling rather than
 * a fixed sleep: the delivery-PR paths do several git round trips, and a short
 * window would let one phase's verdict land inside the next phase's slice.
 */
async function waitForError(before, code) {
  for (let i = 0; i < POLL_TRIES; i++) {
    if (errors.slice(before).includes(code)) return true
    await sleep(POLL_MS)
  }
  console.log(`[e2e] gave up waiting for error ${code}; saw: ${errors.slice(before).join(', ')}`)
  return false
}

function db(fn) {
  const conn = new DatabaseSync(DB_PATH)
  try {
    conn.exec('PRAGMA busy_timeout=5000;')
    return fn(conn)
  } finally {
    conn.close()
  }
}

const deliveryStatus = () =>
  db((c) => c.prepare('SELECT status FROM deliveries WHERE id=?').get(deliveryId)?.status ?? null)
const deliveryPrRows = () =>
  db((c) => c.prepare('SELECT * FROM delivery_prs WHERE delivery_id=?').all(deliveryId))
const deliveryLogs = (op) =>
  db((c) =>
    c
      .prepare('SELECT * FROM delivery_logs WHERE delivery_id=? AND operation_type=?')
      .all(deliveryId, op),
  )
const intentStatus = () =>
  db((c) => c.prepare('SELECT status FROM intents WHERE id=?').get(intentId)?.status ?? null)

/** The intent's merged PR toward this delivery — what the integration guard reads. */
function seedIntentPrRow() {
  db((c) => {
    const now = Date.now()
    c.prepare(
      `INSERT INTO intent_prs
         (id, intent_id, delivery_id, forge, repo, number, url, status, head_branch, base_branch, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      randomUUID(),
      intentId,
      deliveryId,
      'github',
      'o/r',
      '101',
      'https://github.com/o/r/pull/101',
      'merged',
      'feat/e2e',
      BRANCH,
      now,
      now,
    )
  })
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
      // `forge: 'github'` pins the stand-in: the bare local origin would otherwise
      // be auto-detected as GitLab and the server would look for `glab`.
      send({
        type: 'save_workspace_setting',
        workspaceId,
        config: { gitBranchMode: 'worktree', defaultMainBranch: 'main', forge: 'github' },
      })
      phase = 'seed-intent'
      send({ type: 'create_intent', workspaceId })
      break
    }

    case 'create_intent_result':
      intentId = msg.intent.id
      phase = 'create-delivery'
      send({ type: 'create_delivery', workspaceId, title: 'Delivery PR e2e' })
      break

    case 'create_delivery_result':
      if (!deliveryId) {
        deliveryId = msg.delivery.id
        void runAssertions()
      }
      break

    case 'delivery_detail':
      detail = msg
      break

    case 'error':
      errors.push(msg.error?.code ?? '?')
      break
  }
})

async function runAssertions() {
  phase = 'await-delivery'
  for (let i = 0; i < POLL_TRIES && !deliveryId; i++) await sleep(POLL_MS)
  if (!deliveryId) {
    failures.push('delivery was never created')
    finish()
    return
  }

  // ---- 1. the frame contract ----
  phase = 'detail-contract'
  await waitForDetail(() => detail?.delivery?.status === 'planned', 'delivery detail')
  check(
    detail !== null && 'deliveryPr' in detail && detail.deliveryPr === null,
    'delivery_detail carries deliveryPr, null before one is opened',
  )

  // ---- 2. the status gate comes before the branch gate ----
  phase = 'gate-not-verified'
  let before = errors.length
  send({ type: 'create_delivery_pr', workspaceId, deliveryId })
  check(
    await waitForError(before, 'delivery.deliveryPrForbidden'),
    'a delivery that is not verified cannot open a delivery PR (status gate first)',
  )
  check(countCalls('pr ') === 0, 'a refused create never touches the forge')

  // ---- 3. branch + association, then walk to `verified` through the state machine ----
  phase = 'to-verified'
  send({
    type: 'init_delivery_branch',
    workspaceId,
    deliveryId,
    branchName: BRANCH,
    mode: 'create',
  })
  const ready = await waitForDetail(() => detail?.delivery?.branchReady === true, 'branch ready')
  check(ready, 'the delivery branch was initialized on the remote')
  if (!ready) {
    finish()
    return
  }
  send({ type: 'link_intent_to_delivery', workspaceId, deliveryId, intentId })
  await waitForDetail(() => (detail?.associatedIntents?.length ?? 0) === 1, 'intent linked')
  seedIntentPrRow()
  await waitForDetail(() => detail?.delivery?.integration?.merged === 1, 'N/M sees the merged PR')

  // A branch identical to mainline has nothing to propose — the shape a delivery
  // branch already merged by hand ends up in. Asserted BEFORE the first commit.
  phase = 'gate-no-diff'
  for (const to of ['integrating', 'verifying', 'verified']) {
    send({ type: 'transition_delivery', workspaceId, deliveryId, to, confirmVerified: true })
    await waitForDetail(() => detail?.delivery?.status === to, `status ${to}`)
  }
  check(detail?.delivery?.status === 'verified', 'the delivery reached verified')
  before = errors.length
  send({ type: 'create_delivery_pr', workspaceId, deliveryId })
  check(
    await waitForError(before, 'delivery.deliveryPrNoDiff'),
    'a delivery branch with no commits beyond mainline cannot open a PR',
  )

  // Real work on the delivery branch, so `ahead > 0` is a fact.
  git('checkout', '-q', BRANCH)
  writeFileSync(join(PROJECT_DIR, 'feature.txt'), 'delivery work\n')
  git('add', '-A')
  git('commit', '-qm', 'feature')
  git('push', '-q', 'origin', BRANCH)
  git('checkout', '-q', 'main')

  // ---- 4. create: forge asked FIRST, from a non-admin connection ----
  phase = 'create-pr'
  setForge({ mode: 'ok', openPr: null, createNumber: '900' })
  const baseSha = git('rev-parse', 'origin/main')
  const headSha = git('rev-parse', `origin/${BRANCH}`)
  send({ type: 'create_delivery_pr', workspaceId, deliveryId })
  const created = await waitForDetail(() => detail?.deliveryPr?.number === '900', 'delivery PR row')
  // This connection never logged in, so it is not an admin — reaching a created PR
  // is the proof that no c3-side permission gate stands in front of the forge.
  check(created, 'a non-admin workspace member can open the delivery PR')
  const calls = forgeCalls()
  const listAt = calls.findIndex((l) => l.startsWith('pr list'))
  const createAt = calls.findIndex((l) => l.startsWith('pr create'))
  check(
    listAt >= 0 && createAt >= 0 && listAt < createAt,
    'the forge is asked for an existing open PR BEFORE anything is created',
  )
  check(
    calls[listAt]?.includes(`--head ${BRANCH}`) && calls[listAt]?.includes('--base main'),
    'the lookup is keyed on (head = delivery branch, base = mainline)',
  )
  const row = deliveryPrRows()[0]
  check(
    row?.head_branch === BRANCH && row?.base_branch === 'main',
    'the row records head = the delivery branch and base = mainline',
  )
  check(
    row?.base_sha === baseSha && row?.head_sha === headSha,
    'the row records the REAL origin SHAs (the idempotency key material)',
  )
  check(
    row?.status === 'reviewing' && row?.blocked_reason === null,
    'a fresh delivery PR is open and unblocked',
  )

  // ---- 5. retry adopts the forge's PR instead of opening a second one ----
  phase = 'create-retry'
  setForge({ mode: 'ok', openPr: { number: '900', url: 'https://github.com/o/r/pull/900' } })
  const createsBefore = countCalls('pr create')
  send({ type: 'create_delivery_pr', workspaceId, deliveryId })
  await sleep(POLL_MS * 12)
  check(countCalls('pr create') === createsBefore, 'a retry never creates a second PR')
  check(deliveryPrRows().length === 1, 'the ledger still holds exactly one delivery PR row')

  // ---- 6. LAYER 1 — transient: nothing happened, so nothing moves ----
  phase = 'layer-transient'
  setForge({ mode: 'fail' })
  const logsBefore = db(
    (c) =>
      c.prepare('SELECT COUNT(*) AS n FROM delivery_logs WHERE delivery_id=?').get(deliveryId).n,
  )
  before = errors.length
  send({ type: 'sync_delivery_pr', workspaceId, deliveryId })
  check(
    await waitForError(before, 'delivery.deliveryPrSyncFailed'),
    'an unreachable forge reports a retryable sync failure',
  )
  check(
    deliveryStatus() === 'verified',
    'a failed sync leaves the delivery status exactly as it was',
  )
  check(deliveryPrRows()[0]?.status === 'reviewing', 'a failed sync leaves the PR row untouched')
  check(
    db(
      (c) =>
        c.prepare('SELECT COUNT(*) AS n FROM delivery_logs WHERE delivery_id=?').get(deliveryId).n,
    ) === logsBefore,
    'a failed sync writes no delivery log line',
  )

  // ---- 7. LAYER 2 — blocked: the code is fine, something external is not ----
  phase = 'layer-blocked-ci'
  setForge({
    mode: 'ok',
    openPr: { number: '900' },
    view: { state: 'OPEN', statusCheckRollup: [{ conclusion: 'FAILURE' }] },
  })
  send({ type: 'sync_delivery_pr', workspaceId, deliveryId })
  await waitForDetail(() => detail?.deliveryPr?.blockedReason === 'ci_failed', 'ci_failed recorded')
  check(
    deliveryPrRows()[0]?.blocked_reason === 'ci_failed',
    'red CI is recorded as blocked_reason=ci_failed',
  )
  check(
    deliveryStatus() === 'verified',
    'red CI does NOT roll the delivery back — the verification it earned still stands',
  )

  phase = 'layer-blocked-approval'
  setForge({
    mode: 'ok',
    openPr: { number: '900' },
    view: { state: 'OPEN', reviewDecision: 'REVIEW_REQUIRED' },
  })
  send({ type: 'sync_delivery_pr', workspaceId, deliveryId })
  await waitForDetail(() => detail?.deliveryPr?.blockedReason === 'approval', 'approval recorded')
  check(
    deliveryPrRows()[0]?.blocked_reason === 'approval',
    'missing approvals are recorded as blocked_reason=approval',
  )
  check(deliveryStatus() === 'verified', 'missing approvals do NOT roll the delivery back')

  phase = 'layer-unblocked'
  setForge({ mode: 'ok', openPr: { number: '900' }, view: { state: 'OPEN' } })
  send({ type: 'sync_delivery_pr', workspaceId, deliveryId })
  await waitForDetail(() => detail?.deliveryPr?.blockedReason === null, 'block cleared')
  check(
    deliveryPrRows()[0]?.blocked_reason === null,
    'an unblocked PR clears a previously recorded block',
  )

  // ---- 8. LAYER 3 — conflict: the code genuinely has to change ----
  // A REAL conflict: mainline rewrites the same file the delivery branch added, so
  // the local merge trial has something true to enumerate.
  phase = 'layer-conflict'
  writeFileSync(join(PROJECT_DIR, 'feature.txt'), 'mainline work\n')
  git('add', '-A')
  git('commit', '-qm', 'conflicting mainline change')
  git('push', '-q', 'origin', 'main')
  setForge({
    mode: 'ok',
    openPr: { number: '900' },
    view: { state: 'OPEN', mergeable: 'CONFLICTING' },
  })
  send({ type: 'sync_delivery_pr', workspaceId, deliveryId })
  const rolledBack = await waitForDetail(
    () => detail?.delivery?.status === 'verifying',
    'conflict rollback',
  )
  check(rolledBack, 'a merge conflict sends the delivery back to verifying')
  check(
    (deliveryPrRows()[0]?.conflict_files ?? '').includes('feature.txt'),
    'the conflicting file is enumerated by the local merge trial and recorded',
  )
  check(
    deliveryLogs('merge_conflict').length === 1,
    'the conflict rollback wrote a merge_conflict log line',
  )

  // ---- 9. resolve, re-verify, then merge on the forge ----
  phase = 'delivered'
  // Resolve the conflict on the delivery branch so the tree is mergeable again;
  // the human then re-confirms the verification through the real state machine.
  git('checkout', '-q', BRANCH)
  git('merge', '-q', '--no-edit', '-X', 'ours', 'origin/main')
  git('push', '-q', 'origin', BRANCH)
  git('checkout', '-q', 'main')
  send({
    type: 'transition_delivery',
    workspaceId,
    deliveryId,
    to: 'verified',
    confirmVerified: true,
  })
  await waitForDetail(() => detail?.delivery?.status === 'verified', 're-verified')
  check(
    deliveryStatus() === 'verified',
    'the delivery was re-verified after the conflict was resolved',
  )

  const intentBefore = intentStatus()
  setForge({
    mode: 'ok',
    openPr: { number: '900' },
    view: { state: 'MERGED', mergedAt: '2026-08-07T00:00:00Z' },
  })
  send({ type: 'sync_delivery_pr', workspaceId, deliveryId })
  const delivered = await waitForDetail(() => detail?.delivery?.status === 'delivered', 'delivered')
  check(delivered, 'a merged delivery PR settles the delivery as delivered')
  check(deliveryPrRows()[0]?.status === 'merged', 'the PR row settles to merged in the same unit')
  const deliveredLogs = deliveryLogs('delivered')
  check(deliveredLogs.length === 1, 'the delivered write left exactly one delivery log line')
  check(
    deliveredLogs[0]?.actor === 'system' && (deliveredLogs[0]?.summary ?? '').includes('#900'),
    'the log line names the system as actor and the PR that delivered it',
  )
  check(
    intentStatus() === intentBefore,
    'the associated intent status is NOT rewritten by the delivered write',
  )

  // ---- 10. a repeat sync of a settled delivery is idempotent ----
  phase = 'delivered-repeat'
  send({ type: 'sync_delivery_pr', workspaceId, deliveryId })
  await sleep(POLL_MS * 12)
  check(deliveryStatus() === 'delivered', 'a repeat sync leaves the delivery delivered')
  check(
    deliveryLogs('delivered').length === 1,
    'a repeat sync does not write a second delivered log line',
  )

  // ---- 11. current-branch has no delivery branch to propose from ----
  phase = 'current-branch'
  send({
    type: 'save_workspace_setting',
    workspaceId,
    config: { gitBranchMode: 'current-branch', defaultMainBranch: 'main', forge: 'github' },
  })
  await sleep(POLL_MS * 4)
  before = errors.length
  send({ type: 'create_delivery_pr', workspaceId, deliveryId })
  send({ type: 'sync_delivery_pr', workspaceId, deliveryId })
  await waitForError(before, 'delivery.deliveryPrModeUnsupported')
  await sleep(POLL_MS * 4)
  check(
    errors.slice(before).filter((c) => c === 'delivery.deliveryPrModeUnsupported').length === 2,
    'current-branch mode refuses both delivery-PR actions',
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
  if (!serverExited) {
    server.kill('SIGTERM')
    setTimeout(() => {
      if (!serverExited) server.kill('SIGKILL')
    }, 500)
  }
  setTimeout(() => {
    cleanupDirs()
    if (failures.length === 0) {
      console.log('\nRESULT: PASS')
      process.exit(0)
    }
    console.error(`\n[e2e] ${failures.length} assertion(s) failed:`)
    for (const f of failures) console.error(`  - ${f}`)
    console.error('RESULT: FAIL')
    process.exit(1)
  }, 700)
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
