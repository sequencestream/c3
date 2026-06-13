#!/usr/bin/env node
/**
 * Sandbox REAL end-to-end run — drives c3 through an actual worktree intent-dev
 * run that launches a container and lets the in-container agent do real work.
 *
 * Unlike e2e-sandbox-container-test.mjs (token-free container-path probe), this
 * exercises c3's OWN run lifecycle: create an intent → start_development →
 * worktree created under <c3-home>/worktrees → sandbox container launched
 * (ADR-0024 pick + pin) → the pinned custom agent runs INSIDE the container and
 * writes a proof file into the bind-mounted worktree. We then assert the proof
 * file appears on the host worktree and that the server logged the container
 * start/stop lifecycle.
 *
 * This SPENDS REAL TOKENS (one comm turn to save the intent on the host default
 * agent + one dev turn by the pinned in-container agent) and needs:
 *   - Docker + the base image (node scripts/e2e/sandbox/build-image.mjs)
 *   - a server started with an isolated settings.json that has a sandbox def
 *     pointing at the image (networkDisabled:false) + a real custom claude/codex
 *     agent with provider creds, and the workspace sandbox-enabled in worktree
 *     mode with that agent in agentIds. The wrapper script (sandbox/real-run.sh
 *     equivalent — see the orchestration in the task that created this) sets all
 *     of that up. Run it via that orchestration, not standalone.
 *
 * Required env:
 *   WS_URL                  ws url (default ws://localhost:13000/ws)
 *   C3_SANDBOX_E2E_WORKSPACE absolute path to the (git) test project
 *   C3_HOME_DIR             the server's resolved c3 home (= --settings dir), to
 *                           compute the deterministic worktree path
 *   C3_SANDBOX_AGENT_ID     the custom agent id to pin into the sandbox pool
 *   C3_SANDBOX_DEF          system sandbox def name (default 'c3-e2e')
 *
 * Exit: 0 PASS, 5 SKIP (missing prereqs), 2 TIMEOUT, else FAIL.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const URL = process.env.WS_URL || process.argv[2] || 'ws://localhost:13000/ws'
const PROJ = process.env.C3_SANDBOX_E2E_WORKSPACE
const C3_HOME = process.env.C3_HOME_DIR
const AGENT_ID = process.env.C3_SANDBOX_AGENT_ID
const DEF_NAME = process.env.C3_SANDBOX_DEF || 'c3-e2e'
const TIMEOUT_MS = 300_000

if (!PROJ || !C3_HOME || !AGENT_ID) {
  console.log(
    '[real-run] missing C3_SANDBOX_E2E_WORKSPACE / C3_HOME_DIR / C3_SANDBOX_AGENT_ID — SKIP',
  )
  process.exit(5)
}

const PROOF = 'SANDBOX_PROOF.txt'
const PROOF_CONTENT = 'sandbox-run-ok'
const REQ_TITLE = 'E2E sandbox 真实运行'
const SAVE_PROMPT =
  `你是 New Intent 助手。不要读任何文件、不要向我提问。` +
  `直接调用 save_intents 工具,只提交一条意图:` +
  `title="${REQ_TITLE}",` +
  `content="在当前工作目录(.)用 Write 工具创建文件 ${PROOF},内容正好是 ${PROOF_CONTENT}。只做这一件事,不要运行其他命令。",` +
  `priority="P1"。提交后用一句话告诉我已提交。`

// Deterministic worktree path (mirrors features/intents/worktree.ts).
function projectDirName(p) {
  return p.replace(/^\/+/, '').replace(/[/:]/g, '-')
}
function worktreeProofPath(intentId) {
  return join(C3_HOME, 'worktrees', projectDirName(PROJ), `intent-${intentId}`, PROOF)
}

// ─── WS plumbing ────────────────────────────────────────────────────────────────

const inbox = []
let cursor = 0
let notify = null
/** @type {WebSocket} */
let ws
let commSessionId = null
let devWatch = false
const selectedDev = new Set()

function send(d) {
  ws.send(JSON.stringify(d))
}

function onMessage(evt) {
  let msg
  try {
    msg = JSON.parse(typeof evt.data === 'string' ? evt.data : String(evt.data))
  } catch {
    return
  }
  inbox.push(msg)

  // Auto-approve EVERY permission request (comm save_intents + dev tools) so the
  // run never blocks on a human. Logged so the transcript shows what was allowed.
  if (msg.type === 'permission_request') {
    console.log(`[real-run] permission_request: ${msg.toolName} → allow`)
    send({ type: 'permission_response', requestId: msg.requestId, decision: 'allow' })
  }
  // Rebind the comm session's pending id → real SDK id (else the next prompt is
  // rejected with session.notSelected).
  if (msg.type === 'session_started' && commSessionId === msg.clientId) {
    commSessionId = msg.sessionId
    send({ type: 'rebind_view', from: msg.clientId, to: msg.sessionId })
  }
  // Once start_development has fired, attach to the dev session so we receive its
  // turn frames (assistant_text / tool_use / turn_end / permission_request) — those
  // are viewer-scoped, so without selecting it we'd be blind to the in-container run.
  if (devWatch && (msg.type === 'session_status' || msg.type === 'sessions')) {
    const ids =
      msg.type === 'sessions'
        ? (msg.sessions ?? []).map((s) => s.id ?? s.sessionId)
        : (msg.statuses ?? []).map((s) => s.sessionId)
    for (const id of ids) {
      if (id && id !== commSessionId && !selectedDev.has(id)) {
        selectedDev.add(id)
        console.log(`[real-run] selecting dev session ${String(id).slice(0, 24)}`)
        send({ type: 'select_session', workspacePath: PROJ, sessionId: id })
      }
    }
  }
  if (msg.type === 'assistant_text' && msg.text) {
    console.log(
      `[real-run] assistant: ${msg.text.slice(0, 100)}${msg.text.length > 100 ? '…' : ''}`,
    )
  }
  if (msg.type === 'tool_use') console.log(`[real-run] tool_use: ${msg.toolName}`)

  // Verbose diagnostics for the dev run: surface every lifecycle/error frame so a
  // silent hard-fail (e.g. sandbox pick rejection) is visible.
  if (msg.type === 'error') console.log(`[real-run] ⚠️ error: ${JSON.stringify(msg).slice(0, 400)}`)
  if (msg.type === 'turn_end')
    console.log(
      `[real-run] turn_end[${msg.sessionId?.slice(0, 12)}]: reason=${msg.reason}${msg.error ? ' error=' + msg.error : ''}`,
    )
  if (msg.type === 'session_started')
    console.log(
      `[real-run] session_started: client=${msg.clientId?.slice(0, 16)} → ${msg.sessionId?.slice(0, 16)}`,
    )
  if (msg.type === 'run_settled' || msg.type === 'run:settled')
    console.log(`[real-run] run_settled: ${JSON.stringify(msg).slice(0, 300)}`)

  if (notify) notify()
}

function waitFor(pred, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  return (async () => {
    for (;;) {
      while (cursor < inbox.length) {
        const m = inbox[cursor++]
        if (pred(m)) return m
      }
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`)
      await new Promise((r) => {
        notify = r
        setTimeout(r, 250)
      })
      notify = null
    }
  })()
}

function openSocket(url) {
  return new Promise((resolve) => {
    ws = new WebSocket(url)
    ws.addEventListener('message', onMessage)
    ws.addEventListener('error', (e) => {
      console.error('[real-run] ws error:', e.message ?? e)
      process.exit(3)
    })
    ws.addEventListener('open', () => resolve())
  })
}

/** Wait until the proof file appears on the host worktree (sandbox did real work). */
async function waitForProof(intentId, timeoutMs) {
  const path = worktreeProofPath(intentId)
  console.log(`[real-run] waiting for in-container agent to write: ${path}`)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (existsSync(path)) {
      const body = readFileSync(path, 'utf-8').trim()
      console.log(`[real-run] ✅ proof file present, content="${body}"`)
      return body.includes(PROOF_CONTENT)
    }
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, 1000))
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[real-run] connecting ${URL}`)
  await openSocket(URL)
  const first = await waitFor((m) => m.type === 'ready' || m.type === 'unauthenticated', 'ready')
  if (first.type === 'unauthenticated') {
    console.log(
      '[real-run] server has auth enabled — run against an isolated auth-free settings. SKIP',
    )
    process.exit(5)
  }

  // Register workspace + enable sandbox in worktree mode with our agent pinned.
  send({ type: 'add_workspace', path: PROJ })
  await waitFor((m) => m.type === 'workspaces', 'workspaces')
  send({
    type: 'save_workspace_setting',
    projectPath: PROJ,
    config: {
      gitBranchMode: 'worktree',
      // bypassPermissions (never-ask): the in-container agent is isolated, so it
      // writes into the mounted worktree without a human approving each tool. A
      // background dev run has no live approver, so any gated mode would stall.
      defaultMode: { claude: 'bypassPermissions' },
      sandbox: { enabled: true, sandbox: DEF_NAME, agentIds: [AGENT_ID] },
    },
  })
  const wsCfg = await waitFor((m) => m.type === 'workspace_setting', 'workspace_setting')
  const sb = wsCfg.config?.sandbox
  console.log(
    `[real-run] sandbox config: mode=${wsCfg.config?.gitBranchMode} enabled=${sb?.enabled} ` +
      `def=${sb?.sandbox} agentIds=${JSON.stringify(sb?.agentIds)}`,
  )
  if (!sb?.enabled || !(sb?.agentIds || []).includes(AGENT_ID)) {
    throw new Error(
      `sandbox not enabled or agent ${AGENT_ID} dropped by normalize (not enabled+custom?)`,
    )
  }

  // Enter intent view → comm session + intent list.
  send({ type: 'open_intent_chat', projectPath: PROJ })
  const commSel = await waitFor((m) => m.type === 'session_selected', 'comm session_selected')
  commSessionId = commSel.sessionId
  console.log(`[real-run] comm session ${commSessionId}`)
  await waitFor((m) => m.type === 'intents', 'initial intents list')

  // Drive the comm agent to save ONE intent (whose content is the dev task).
  console.log('[real-run] asking comm agent to save the intent …')
  send({ type: 'user_prompt', text: SAVE_PROMPT })
  await waitFor(
    (m) => m.type === 'permission_request' && /save_intents|save_requirements/.test(m.toolName),
    'save_intents permission',
    120_000,
  )
  // Capture the persisted intent id from the refreshed broadcast.
  const persisted = await waitFor(
    (m) => m.type === 'intents' && m.items?.some((r) => r.title === REQ_TITLE),
    'intents broadcast with our row',
    60_000,
  )
  const intentId = persisted.items.find((r) => r.title === REQ_TITLE).id
  console.log(`[real-run] ✅ intent persisted: id=${intentId}`)

  // Trigger the real worktree intent-dev run (this launches the sandbox).
  console.log('[real-run] start_development → expect worktree + container launch …')
  devWatch = true
  send({ type: 'start_development', projectPath: PROJ, intentId })

  // The pinned agent runs INSIDE the container; success = it wrote the proof file
  // into the bind-mounted worktree on the host.
  const ok = await waitForProof(intentId, 240_000)

  console.log('\n========== SANDBOX REAL-RUN ==========')
  console.log(`proof_file_written_in_worktree: ${ok}`)
  console.log(`worktree_path: ${worktreeProofPath(intentId).replace('/' + PROOF, '')}`)
  console.log(`result: ${ok ? 'PASS' : 'FAIL'}`)
  console.log('======================================\n')
  console.log('(check the server log for `[sandbox] container started/stopped` lines)')
  return ok ? 0 : 1
}

const timeout = setTimeout(() => {
  console.error('[real-run] TIMEOUT')
  process.exit(2)
}, TIMEOUT_MS)

main()
  .then((code) => {
    clearTimeout(timeout)
    try {
      ws?.close()
    } catch {
      /* ignore */
    }
    process.exit(code)
  })
  .catch((err) => {
    clearTimeout(timeout)
    console.error('[real-run] fatal:', err.message ?? err)
    process.exit(1)
  })
