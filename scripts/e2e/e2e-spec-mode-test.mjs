#!/usr/bin/env node
/**
 * End-to-end test for the PER-INTENT SPEC MODE override over the real wire.
 *
 * The intent detail's「是否需要规范」switch writes exactly one message —
 * `set_intent_spec_mode` — and reads back exactly one derived value,
 * `effectiveSpecMode`, off the `intents` broadcast. This suite drives that round
 * trip through the live server so the UI's contract is pinned end to end:
 *
 *  1. a fresh intent starts unset (`specMode: null`) and inherits the workspace —
 *     `effectiveSpecMode` follows `sddEnabled`;
 *  2. an explicit `fast` / `sdd` persists and comes back on the broadcast, with
 *     `effectiveSpecMode` equal to the explicit value;
 *  3. it SURVIVES a refresh — a brand new WebSocket connection listing the same
 *     workspace still sees the override (this is the "刷新 / 重进保持" claim);
 *  4. flipping the workspace's `sddEnabled` moves the UNSET intent's derived
 *     value and leaves the explicitly-set one alone — the derivation rule the
 *     per-intent switch exists to override;
 *  5. an explicit `null` clears the override and inheritance resumes;
 *  6. the mode write never touches `specStatus` (fast does not revoke an
 *     approved spec) and an unknown intent is refused with `intent.notFound`.
 *
 * NO AGENT TOKENS ARE SPENT: no session is ever started, no spec is authored.
 * The one place the ledger is touched directly is seeding an `approved`
 * `spec_status` for assertion 6 — approving a spec for real would need an
 * authored spec document, i.e. a live agent run, which an e2e suite must not do.
 *
 * Needs `C3_DB_PATH` pointing at the server's ledger (the suite runner passes it)
 * for that one seed; without it the test SKIPs (exit 5).
 *
 * Usage:
 *   pnpm start --port 13000                    # in another terminal
 *   C3_DB_PATH=~/.c3/c3.db node scripts/e2e/e2e-spec-mode-test.mjs [ws-url]
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'

const URL = process.argv[2] || 'ws://localhost:13000/ws'
const TIMEOUT_MS = 60_000
const POLL_MS = 150
const POLL_TRIES = 40
const DB_PATH = process.env.C3_DB_PATH

if (!DB_PATH) {
  console.error('[e2e] C3_DB_PATH not set — cannot seed an approved spec status; SKIP')
  process.exit(5)
}

let DatabaseSync
try {
  ;({ DatabaseSync } = await import('node:sqlite'))
} catch (err) {
  console.error('[e2e] node:sqlite unavailable — SKIP:', err?.message ?? err)
  process.exit(5)
}

// ---- Seed a throwaway workspace under /tmp ----
const PROJECT_DIR = mkdtempSync('/tmp/c3-spec-mode-')
writeFileSync(`${PROJECT_DIR}/README.md`, '# Per-intent spec mode e2e\n')

console.log(`[e2e] workspace: ${PROJECT_DIR}`)
console.log(`[e2e] connecting ${URL}`)

const failures = []
let finished = false
let phase = 'boot'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (ok, label) => {
  console.log(`[e2e] ${ok ? 'ok  ' : 'FAIL'} — ${label}`)
  if (!ok) failures.push(label)
}

const db = (fn) => {
  const conn = new DatabaseSync(DB_PATH)
  try {
    conn.exec('PRAGMA busy_timeout=5000;')
    return fn(conn)
  } finally {
    conn.close()
  }
}

/**
 * One live connection to the server, reduced to the few frames this suite reads.
 * Opening a SECOND one is how the refresh assertion is made: a new socket has no
 * client state at all, so whatever it lists came from the ledger.
 */
function connect() {
  const ws = new WebSocket(URL)
  const state = { ws, ready: false, workspaces: null, intents: [], errors: [], setting: null }
  ws.addEventListener('message', (evt) => {
    let msg
    try {
      msg = JSON.parse(typeof evt.data === 'string' ? evt.data : String(evt.data))
    } catch {
      return
    }
    switch (msg.type) {
      case 'ready':
        state.ready = true
        break
      case 'workspaces':
        state.workspaces = msg.workspaces ?? []
        break
      case 'intents':
        state.intents = msg.items ?? []
        break
      case 'workspace_setting':
        state.setting = msg
        break
      case 'create_intent_result':
        state.created = msg.intent
        break
      case 'error':
        state.errors.push(msg.error ?? { code: '?' })
        break
    }
  })
  state.send = (m) => ws.send(JSON.stringify(m))
  return state
}

async function waitFor(predicate, label) {
  for (let i = 0; i < POLL_TRIES; i++) {
    if (predicate()) return true
    await sleep(POLL_MS)
  }
  console.log(`[e2e] gave up waiting for: ${label}`)
  return false
}

/** Poll a connection's intent list until `predicate` holds on the freshest frame. */
async function pollIntents(conn, workspaceName, predicate, label) {
  for (let i = 0; i < POLL_TRIES; i++) {
    conn.send({ type: 'list_intents', workspaceName })
    await sleep(POLL_MS)
    if (conn.intents.length && predicate(conn.intents)) return true
  }
  console.log(`[e2e] gave up waiting for: ${label}`)
  return false
}

const findIntent = (list, id) => list.find((i) => i.id === id) ?? null

async function setSdd(conn, workspaceName, enabled) {
  conn.setting = null
  conn.send({
    type: 'save_workspace_setting',
    workspaceName,
    config: { sddEnabled: enabled },
  })
  await waitFor(() => conn.setting !== null, `workspace_setting echo (sddEnabled=${enabled})`)
  await sleep(POLL_MS)
}

async function createIntent(conn, workspaceName) {
  conn.created = null
  conn.send({ type: 'create_intent', workspaceName })
  await waitFor(() => conn.created !== null, 'create_intent_result')
  return conn.created?.id ?? null
}

const timeout = setTimeout(() => {
  failures.push(`TIMEOUT in phase "${phase}"`)
  finish()
}, TIMEOUT_MS)

const main = connect()
let refresh = null

async function run() {
  phase = 'boot'
  if (!(await waitFor(() => main.ready, 'ready'))) {
    failures.push('server never sent ready')
    return
  }

  phase = 'add-workspace'
  main.send({ type: 'add_workspace', name: PROJECT_DIR.split('/').pop(), path: PROJECT_DIR })
  const name = PROJECT_DIR.split('/').pop()
  if (!(await waitFor(() => main.workspaces?.some((w) => w.name === name), 'workspaces'))) {
    failures.push('workspace never registered')
    return
  }
  const workspaceName = main.workspaces.find((w) => w.name === name).name

  // SDD on: the baseline where the derived value is `sdd` and the switch has teeth.
  phase = 'sdd-on'
  await setSdd(main, workspaceName, true)

  phase = 'create-intents'
  const unsetId = await createIntent(main, workspaceName)
  const pinnedId = await createIntent(main, workspaceName)
  if (!unsetId || !pinnedId) {
    failures.push('intents were never created')
    return
  }

  // ---- 1. unset inherits the workspace ----
  phase = 'inherit'
  await pollIntents(
    main,
    workspaceName,
    (list) => findIntent(list, unsetId) !== null,
    'the new intents land in the list',
  )
  let unset = findIntent(main.intents, unsetId)
  check(unset?.specMode === null, `a fresh intent carries no override (${unset?.specMode})`)
  check(
    unset?.effectiveSpecMode === 'sdd',
    `unset inherits sddEnabled=true as sdd (${unset?.effectiveSpecMode})`,
  )

  // ---- 2. an explicit override persists and comes back derived ----
  phase = 'explicit-fast'
  main.send({ type: 'set_intent_spec_mode', intentId: pinnedId, mode: 'fast' })
  await pollIntents(
    main,
    workspaceName,
    (list) => findIntent(list, pinnedId)?.specMode === 'fast',
    'explicit fast lands on the broadcast',
  )
  let pinned = findIntent(main.intents, pinnedId)
  check(pinned?.specMode === 'fast', `explicit fast persists (${pinned?.specMode})`)
  check(
    pinned?.effectiveSpecMode === 'fast',
    `and resolves to fast while SDD is on (${pinned?.effectiveSpecMode})`,
  )

  // ---- 3. it survives a refresh (a brand new connection reads the ledger) ----
  phase = 'refresh'
  refresh = connect()
  if (!(await waitFor(() => refresh.ready, 'second connection ready'))) {
    failures.push('second connection never became ready')
    return
  }
  await pollIntents(
    refresh,
    workspaceName,
    (list) => findIntent(list, pinnedId) !== null,
    'refreshed list',
  )
  const afterRefresh = findIntent(refresh.intents, pinnedId)
  check(
    afterRefresh?.specMode === 'fast' && afterRefresh?.effectiveSpecMode === 'fast',
    `the override survives a fresh connection (${afterRefresh?.specMode} / ${afterRefresh?.effectiveSpecMode})`,
  )

  // ---- 4. the workspace switch moves the UNSET one only ----
  phase = 'workspace-toggle'
  await setSdd(main, workspaceName, false)
  await pollIntents(
    main,
    workspaceName,
    (list) => findIntent(list, unsetId)?.effectiveSpecMode === 'fast',
    'unset intent follows sddEnabled=false',
  )
  unset = findIntent(main.intents, unsetId)
  check(
    unset?.specMode === null && unset?.effectiveSpecMode === 'fast',
    `an unset intent follows the workspace off switch (${unset?.effectiveSpecMode})`,
  )

  main.send({ type: 'set_intent_spec_mode', intentId: pinnedId, mode: 'sdd' })
  await pollIntents(
    main,
    workspaceName,
    (list) => findIntent(list, pinnedId)?.specMode === 'sdd',
    'explicit sdd lands while the workspace is off',
  )
  pinned = findIntent(main.intents, pinnedId)
  check(
    pinned?.specMode === 'sdd' && pinned?.effectiveSpecMode === 'sdd',
    `an explicit sdd holds even with sddEnabled=false (${pinned?.effectiveSpecMode})`,
  )

  await setSdd(main, workspaceName, true)
  await pollIntents(
    main,
    workspaceName,
    (list) => findIntent(list, unsetId)?.effectiveSpecMode === 'sdd',
    'unset intent follows sddEnabled=true again',
  )
  check(
    findIntent(main.intents, unsetId)?.effectiveSpecMode === 'sdd',
    'the unset intent follows the workspace back on',
  )

  // ---- 5. an explicit null restores inheritance ----
  phase = 'clear-override'
  main.send({ type: 'set_intent_spec_mode', intentId: pinnedId, mode: null })
  await pollIntents(
    main,
    workspaceName,
    (list) => findIntent(list, pinnedId)?.specMode === null,
    'the override is cleared',
  )
  pinned = findIntent(main.intents, pinnedId)
  check(pinned?.specMode === null, 'an explicit null clears the override')
  check(
    pinned?.effectiveSpecMode === 'sdd',
    `and inheritance resumes from the workspace (${pinned?.effectiveSpecMode})`,
  )

  // ---- 6. the write is spec-status neutral, and unknown intents are refused ----
  phase = 'guards'
  db((c) =>
    c
      .prepare("UPDATE intents SET spec_status='approved', spec_approved=1 WHERE id=?")
      .run(pinnedId),
  )
  main.send({ type: 'set_intent_spec_mode', intentId: pinnedId, mode: 'fast' })
  await pollIntents(
    main,
    workspaceName,
    (list) => findIntent(list, pinnedId)?.specMode === 'fast',
    'fast lands on the approved intent',
  )
  pinned = findIntent(main.intents, pinnedId)
  check(
    pinned?.specStatus === 'approved' && pinned?.specApproved === true,
    `switching to fast does not revoke an approved spec (${pinned?.specStatus})`,
  )

  const before = main.errors.length
  main.send({ type: 'set_intent_spec_mode', intentId: 'no-such-intent', mode: 'fast' })
  await waitFor(() => main.errors.length > before, 'error for an unknown intent')
  check(
    main.errors[main.errors.length - 1]?.code === 'intent.notFound',
    `an unknown intent is refused (${main.errors[main.errors.length - 1]?.code})`,
  )
}

function finish() {
  if (finished) return
  finished = true
  clearTimeout(timeout)
  for (const conn of [main, refresh]) {
    try {
      conn?.ws?.close()
    } catch {
      /* noop */
    }
  }
  rmSync(PROJECT_DIR, { recursive: true, force: true })
  console.log(`RESULT: ${failures.length === 0 ? 'PASS' : 'FAIL'}`)
  if (failures.length) for (const f of failures) console.log(`  - ${f}`)
  process.exit(failures.length === 0 ? 0 : 1)
}

try {
  await run()
} catch (err) {
  failures.push(`threw in phase "${phase}": ${err?.message ?? err}`)
}
finish()
