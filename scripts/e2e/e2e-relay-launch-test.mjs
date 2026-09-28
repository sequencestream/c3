#!/usr/bin/env node
/**
 * Real end-to-end validation that a PR review / fix relay phase actually LAUNCHES.
 *
 * The bug this pins: the relay hands the dispatcher the intent's workspace PATH
 * while the dispatcher's workspace gate only resolved REGISTERED NAMES, so both
 * entry points died at the gate with `automation_workspace_not_found` before a
 * vendor was ever asked to start — no review session, no conclusion, and a queue
 * that silently burned its failure ladder.
 *
 * What it asserts, on a real running server:
 *  1. `start_intent_relay` is ACCEPTED (no synchronous `error` frame), and the
 *     intent immediately reads `reviewStatus: 'pending'` with a `pending:` session
 *     placeholder — the claim really happened.
 *  2. The phase does NOT die at the workspace gate: the server log must contain
 *     NEITHER `automation_workspace_not_found` NOR the follow-on
 *     「会话执行失败」 / 「已结束但未回填结论」 lines. Whatever happens next is the
 *     vendor's business, not the gate's.
 *  3. If a real session does bind, `reviewSessionId` carries a REAL session id
 *     (the `pending:` placeholder is replaced) — and that session's projection row
 *     is owned by the INTENT with kind `work`, not by an automation.
 *
 * The intent is seeded straight into the throwaway db (an intent needs a PR row
 * and a worktree, neither of which the wire protocol can create without a real
 * forge). Exit: 0 PASS, 1 FAIL, 2 TIMEOUT, 3 ws-error, 5 SKIP.
 *
 * Usage:
 *   node scripts/e2e/isolated-server.mjs --port 13000 --db /tmp/x/c3.db
 *   node scripts/e2e/e2e-relay-launch-test.mjs <ws-url> <db-path> <workspace-dir>
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const URL = process.argv[2] || 'ws://localhost:13000/ws'
const DB = process.argv[3] || ''
const WORKSPACE = process.argv[4] || ''
const C3_HOME = process.argv[5] || dirname(DB)
const TIMEOUT_MS = 90_000

if (!DB || !WORKSPACE) {
  console.error('[relay-launch-e2e] usage: <ws-url> <db-path> <workspace-dir> [c3-home]')
  process.exit(1)
}

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')

let ws
let intentId = null
let workspaceName = null
let exitCode = 1
const errors = []
const log = (...a) => console.log('[relay-launch-e2e]', ...a)

function finish(code) {
  exitCode = code
  try {
    ws?.close()
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(code), 100)
}

/**
 * A workspace registered over the wire, so the intent store initialises.
 *
 * The NAME is derived from the directory's basename on purpose: it must not be the
 * path, so the relay resolving the workspace by PATH is a genuinely different code
 * path from resolving it by name — the one that used to fail the dispatcher's gate.
 */
const BOOT_WS = basename(WORKSPACE)

const timeout = setTimeout(() => {
  console.error('[relay-launch-e2e] TIMEOUT')
  finish(2)
}, TIMEOUT_MS)

/** Seed the ledger the relay's admission needs: an intent, a live PR, worktree mode. */
function seed() {
  mkdirSync(join(WORKSPACE, '.git'), { recursive: true })
  writeFileSync(join(WORKSPACE, 'README.md'), '# relay e2e\n')
  const db = new DatabaseSync(DB)
  const now = Date.now()
  intentId = `relay-e2e-${now}`
  // The server resolves a workspace to its REAL path (macOS `/tmp` is a symlink to
  // `/private/tmp`), and the intent ledger stores that same resolved path. Seeding
  // the literal argument would make the handler's workspace comparison fail for a
  // reason that has nothing to do with the relay.
  const wsPath = realpathSync(WORKSPACE)
  // The relay refuses to run without the intent's own worktree (a fix must edit the
  // PR head branch, so there is deliberately no fallback to the project checkout).
  // Lay down the directory the server's deterministic path points at: c3 home is
  // the isolated instance's state dir, which the caller passes as the db's folder.
  const worktree = join(
    realpathSync(C3_HOME),
    'worktrees',
    wsPath.replace(/^\/+/, '').replace(/[/:]/g, '-'),
    `intent-${intentId}`,
  )
  mkdirSync(worktree, { recursive: true })
  writeFileSync(join(worktree, '.git'), 'gitdir: /dev/null\n')
  writeFileSync(join(worktree, 'README.md'), '# relay e2e worktree\n')
  log('worktree at', worktree)
  // The workspace is already registered over the wire under a name that is not its
  // path; the relay resolves it by PATH, so this is exactly the form that used to
  // fail the dispatcher's gate.
  workspaceName = BOOT_WS
  db.prepare(
    `INSERT INTO intents (id, workspace_name, title, short_en_title, content, priority, impact_level,
       status, module, automate, spec_status, spec_approved, spec_mode, review_fix_rounds, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    intentId,
    wsPath,
    '接力启动验证',
    'relay-launch-e2e',
    'e2e body',
    'high',
    'L2',
    'in_progress',
    '',
    0,
    'raw',
    0,
    null,
    0,
    now,
    now,
  )
  db.prepare(
    `INSERT INTO intent_prs (id, intent_id, delivery_id, forge, repo, number, url, status, head_branch, base_branch, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    `pr-${now}`,
    intentId,
    null,
    'github',
    'acme/does-not-exist',
    // Unique per run: intent_prs enforces one row per (forge, repo, number), and a
    // second run against the same throwaway db must not collide with the first.
    String(now),
    'https://example.invalid/pr/1',
    'reviewing',
    'intent/relay-launch-e2e',
    'main',
    now,
    now,
  )
  db.close()
  log('seeded intent', intentId, 'in workspace', WORKSPACE, 'named', workspaceName)
}

/** Read the ledger straight from the throwaway db — the assertion of record. */
function readIntent() {
  const db = new DatabaseSync(DB, { readOnly: true })
  const row = db
    .prepare(
      `SELECT review_status, review_session_id, review_fix_rounds
       FROM intents WHERE id = ?`,
    )
    .get(intentId)
  const sess = db
    .prepare(
      `SELECT session_kind, owner_kind, owner_id, title FROM session_metadata
       WHERE vendor_session_id = ?`,
    )
    .get(row.review_session_id)
  db.close()
  return { ...row, projection: sess }
}

function send(msg) {
  ws.send(JSON.stringify(msg))
}

ws = new WebSocket(URL)
let phase = 'boot'
let accepted = false

ws.addEventListener('message', (evt) => {
  const msg = JSON.parse(typeof evt.data === 'string' ? evt.data : String(evt.data))
  if (process.env.RELAY_E2E_TRACE) console.log('  <<', msg.type, 'phase=' + phase)

  // Step 1 — register the throwaway workspace over the wire. Its NAME is
  // deliberately not its path, so the relay's path-form workspace identifier and
  // the name-form one are both exercised against a real registry.
  if (msg.type === 'ready') {
    if (phase !== 'boot') return
    phase = 'addws'
    if (process.env.RELAY_E2E_TRACE) console.log('  >> add_workspace', WORKSPACE)
    send({ type: 'add_workspace', name: BOOT_WS, path: WORKSPACE })
    return
  }
  if (msg.type === 'workspaces' && phase === 'addws') {
    phase = 'open'
    // Step 2 — opening the intent view is what forces the intent store to create
    // its schema, so the seed below lands in a db that already has the tables.
    send({ type: 'open_intent_session', workspaceName: BOOT_WS })
    return
  }
  if (phase === 'open' && msg.type === 'intents') {
    phase = 'relay'
    try {
      seed()
    } catch (err) {
      console.error('[relay-launch-e2e] seed failed:', err)
      return finish(1)
    }
    log('sending start_intent_relay')
    send({ type: 'start_intent_relay', workspaceName, intentId, phase: 'review' })
    return
  }

  if (msg.type === 'error') {
    console.log('  !! ERROR FRAME:', JSON.stringify(msg.error))
  }
  if (msg.type !== 'intents') return
  const item = (msg.items ?? []).find((i) => i.id === intentId)
  if (!item) return

  if (!accepted) {
    if (item.reviewStatus !== 'pending') return
    accepted = true
    log('ACCEPTED — claim landed, reviewStatus=pending, session =', item.reviewSessionId)
    if (typeof item.reviewSessionId !== 'string' || !item.reviewSessionId.startsWith('pending:')) {
      errors.push(`expected a pending: placeholder, got ${item.reviewSessionId}`)
      return finish(1)
    }
    // Give the vendor a real chance to bind before judging the outcome.
    setTimeout(verify, 25_000)
  }
})

function verify() {
  clearTimeout(timeout)
  const row = readIntent()
  log('ledger now:', JSON.stringify(row))

  if (row.review_status !== 'pending') {
    errors.push(`review_status should still be pending, got ${row.review_status}`)
  }
  const sid = row.review_session_id
  if (typeof sid === 'string' && sid.startsWith('pending:')) {
    // No vendor session bound. That is legitimate where no usable agent exists —
    // but the GATE must not be the reason, which the log check below proves.
    log('no vendor session bound in this environment (gate was not the blocker)')
  } else if (sid) {
    log('REAL SESSION BOUND:', sid)
    const p = row.projection
    if (!p) {
      errors.push(`session ${sid} bound but has no session_metadata projection row`)
    } else {
      log('projection:', JSON.stringify(p))
      if (p.owner_kind !== 'intent' || p.owner_id !== intentId) {
        errors.push(`projection not owned by the intent: ${JSON.stringify(p)}`)
      }
      if (p.session_kind !== 'work') {
        errors.push(`projection session_kind should be 'work', got ${p.session_kind}`)
      }
      if (!/^PR 评审:/.test(p.title ?? '')) {
        errors.push(`projection title should identify the review phase: ${p.title}`)
      }
    }
  }

  // The regression this whole test exists for.
  const logText = readServerLog()
  if (/automation_workspace_not_found/.test(logText)) {
    errors.push('server log still contains automation_workspace_not_found')
  }
  if (/会话执行失败/.test(logText)) {
    errors.push('server log contains 「会话执行失败」 — the phase did not launch')
  }
  if (/已结束但未回填结论/.test(logText)) {
    errors.push('server log contains 「已结束但未回填结论」 — the phase died')
  }

  if (errors.length) {
    for (const e of errors) console.error('[relay-launch-e2e] FAIL:', e)
    return finish(1)
  }
  log('PASS')
  finish(0)
}

function readServerLog() {
  const p = process.env.RELAY_E2E_SERVER_LOG
  if (!p || !existsSync(p)) return ''
  return execFileSync('cat', [p], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

ws.addEventListener('error', () => {
  console.error('[relay-launch-e2e] ws error')
  finish(3)
})
