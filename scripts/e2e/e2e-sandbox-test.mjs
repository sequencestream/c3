#!/usr/bin/env node
/**
 * Sandbox E2E test — backward compatibility + sandboxed path validation.
 *
 * Phase 1 (always): Non-sandboxed prompt against the seed project.
 *   Proves that sandbox code hasn't changed host-only execution.
 *
 * Phase 2 (conditional): Same prompt against a sandbox-enabled project.
 *   Requires Docker + existing system sandbox defs. SKIPs when not.
 *
 * Usage:
 *   node scripts/e2e/e2e-sandbox-test.mjs [ws-url] [prompt]
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

const URL = process.argv[2] || 'ws://localhost:13000/ws'
const TIMEOUT_MS = 180_000
const PROMPT =
  process.argv[3] ||
  'Use the Write tool to create the file /tmp/c3-e2e-sandbox-test.txt with content exactly "c3-sandbox-e2e-ok". Do not run any other commands.'

// ─── State machine ────────────────────────────────────────────────────────────

/**
 * Test phases:
 * 0 = init (waiting for ready)
 * 1 = set up sandbox (check Docker, get settings, create sandbox project)
 * 2 = Phase 1 — non-sandboxed run
 * 3 = Phase 2 — sandboxed run (skipped if prerequisites missing)
 * 4 = done
 */
let phase = 0
let seedWorkspace = ''
let sandboxProject = ''
let sandboxDefName = ''
let phase1Passed = false
let phase2Passed = null
let dockerAvailable = false
let sandboxDefsAvailable = false
const events = []

// Per-prompt flags (reset per phase)
let sawPermissionRequest = false
let sawConsensusAuto = false
let sawToolUse = false
let sawToolResult = false
let sawTurnEnd = false
let promptSent = false
let endReason = ''

/** @type {WebSocket} */
let ws

const timeout = setTimeout(() => {
  console.error('[e2e-sandbox] TIMEOUT')
  finish(2)
}, TIMEOUT_MS)

function finish(code) {
  clearTimeout(timeout)
  try {
    ws.close()
  } catch {
    /* ignore */
  }
  process.exit(code)
}

function send(data) {
  ws.send(JSON.stringify(data))
}

function resetFlags() {
  sawPermissionRequest = false
  sawConsensusAuto = false
  sawToolUse = false
  sawToolResult = false
  sawTurnEnd = false
  promptSent = false
  endReason = ''
  events.length = 0
}

function judge(label) {
  console.log(`\n========== ${label} ==========`)
  console.log(`events: ${JSON.stringify(events)}`)
  const checks = {
    permission_gateway: sawPermissionRequest || sawConsensusAuto,
    tool_use: sawToolUse,
    tool_result: sawToolResult,
    turn_end_clean: sawTurnEnd && !endReason.startsWith('error'),
  }
  console.log('checks:', JSON.stringify(checks))
  const ok = Object.values(checks).every(Boolean)
  console.log(`result: ${ok ? 'PASS' : 'FAIL'}`)
  console.log('===============================\n')
  return ok
}

// ─── Message handler ──────────────────────────────────────────────────────────

function onMessage(evt) {
  let msg
  try {
    msg = JSON.parse(typeof evt.data === 'string' ? evt.data : String(evt.data))
  } catch {
    return
  }
  events.push(msg.type)

  // ── Phase 0: init ─────────────────────────────────────────────────
  if (msg.type === 'ready') {
    seedWorkspace = msg.workspaces?.[0]?.path
    if (!seedWorkspace) {
      console.error('[e2e-sandbox] no seed workspace — start with --project <dir>')
      finish(5)
      return
    }
    console.log(`[e2e-sandbox] ready → workspace: ${seedWorkspace}`)
    phase = 1
    runSetup()
    return
  }

  // ── Pending requests (settings / project_config) ──────────────────
  if (msg.type === 'settings') {
    const defs = msg.settings?.sandboxes
    sandboxDefsAvailable = Array.isArray(defs) && defs.length > 0
    if (sandboxDefsAvailable) {
      sandboxDefName = defs[0].name
      console.log(`[e2e-sandbox] found sandbox def: "${sandboxDefName}"`)
    } else {
      console.log('[e2e-sandbox] no sandbox defs in settings')
    }
    // After settings, create sandbox project if possible
    tryCreateSandboxProject()
    return
  }

  if (msg.type === 'workspaces') {
    // add_workspace response — project now registered
    console.log('[e2e-sandbox] sandbox workspace added')
    // Now save the project config
    send({
      type: 'save_project_config',
      projectPath: sandboxProject,
      config: { sandbox: { enabled: true, sandbox: sandboxDefName } },
    })
    return
  }

  if (msg.type === 'project_config') {
    // Config saved. Now start Phase 1 (non-sandboxed).
    console.log('[e2e-sandbox] sandbox project config saved')
    startNonSandboxedRun()
    return
  }

  if (msg.type === 'error') {
    console.warn(`[e2e-sandbox] error: ${JSON.stringify(msg.error)}`)
    return
  }

  // ── Session events (Phase 2/3) ───────────────────────────────────
  if (msg.type === 'session_selected') {
    if (promptSent) return // session may re-bind after resume
    promptSent = true
    send({ type: 'set_mode', mode: 'default' })
    console.log(`[e2e-sandbox] session ${msg.sessionId} → set_mode default → prompt`)
    send({ type: 'user_prompt', text: PROMPT })
    return
  }

  if (msg.type === 'consensus_auto') {
    sawConsensusAuto = true
    return
  }

  if (msg.type === 'assistant_text') {
    const t = (msg.text ?? '').slice(0, 120)
    console.log(`[e2e-sandbox] assistant: ${t}${msg.text?.length > 120 ? '…' : ''}`)
    return
  }

  if (msg.type === 'permission_request') {
    sawPermissionRequest = true
    console.log(`[e2e-sandbox] permission: ${msg.toolName}`)
    send({ type: 'permission_response', requestId: msg.requestId, decision: 'allow' })
    return
  }

  if (msg.type === 'tool_use') {
    sawToolUse = true
    console.log(`[e2e-sandbox] tool_use: ${msg.toolName}`)
    return
  }

  if (msg.type === 'tool_result') {
    sawToolResult = true
    return
  }

  if (msg.type === 'turn_end') {
    sawTurnEnd = true
    endReason = msg.reason + (msg.error ? `: ${msg.error}` : '')
    console.log(`[e2e-sandbox] turn_end: ${endReason}`)
    onTurnEnd()
  }
}

// ─── Setup ────────────────────────────────────────────────────────────────────

function runSetup() {
  // Check Docker
  try {
    execSync('docker info --format "{{.ServerVersion}}"', { timeout: 5000, stdio: 'pipe' })
    dockerAvailable = true
    console.log('[e2e-sandbox] Docker available')
  } catch {
    console.log('[e2e-sandbox] Docker NOT available — sandbox path will be skipped')
  }

  if (dockerAvailable) {
    // Request settings to check for sandbox definitions
    send({ type: 'get_settings' })
  } else {
    // Skip sandbox setup entirely
    startNonSandboxedRun()
  }
}

function tryCreateSandboxProject() {
  if (!sandboxDefsAvailable) {
    console.log('[e2e-sandbox] no sandbox definitions — skipping sandbox project')
    startNonSandboxedRun()
    return
  }

  sandboxProject = mkdtempSync(join(tmpdir(), 'c3-e2e-sandbox-project-'))
  mkdirSync(sandboxProject, { recursive: true })
  writeFileSync(join(sandboxProject, 'README.md'), '# c3 sandbox e2e\n')
  console.log(`[e2e-sandbox] sandbox project: ${sandboxProject}`)

  // Add workspace, then save_project_config, then start phase 1
  send({ type: 'add_workspace', path: sandboxProject })
}

// ─── Run phases ───────────────────────────────────────────────────────────────

function startNonSandboxedRun() {
  phase = 2
  resetFlags()
  console.log('\n[e2e-sandbox] === Phase 1: Non-sandboxed run ===')
  send({ type: 'create_session', workspacePath: seedWorkspace })
}

function onTurnEnd() {
  if (phase === 2) {
    // Phase 1 complete
    phase1Passed = judge('Phase 1 (non-sandboxed)')
    if (!phase1Passed) {
      console.error('[e2e-sandbox] Phase 1 FAILED — aborting')
      finish(1)
      return
    }
    // Start Phase 2 if prerequisites met
    if (sandboxProject) {
      phase = 3
      resetFlags()
      console.log('\n[e2e-sandbox] === Phase 2: Sandboxed run ===')
      send({ type: 'create_session', workspacePath: sandboxProject })
    } else {
      finishReport()
    }
  } else if (phase === 3) {
    // Phase 2 complete
    phase2Passed = judge('Phase 2 (sandboxed)')
    finishReport()
  }
}

function finishReport() {
  console.log('\n========== E2E SANDBOX SUMMARY ==========')
  console.log(`Phase 1 (non-sandboxed): ${phase1Passed ? 'PASS' : 'FAIL'}`)
  const p2 = phase2Passed === null ? 'SKIP' : phase2Passed ? 'PASS' : 'FAIL'
  console.log(`Phase 2 (sandboxed):    ${p2}`)
  console.log(`  (Docker: ${dockerAvailable}, sandbox defs: ${sandboxDefsAvailable})`)
  console.log('=========================================\n')
  finish(phase1Passed ? 0 : 1)
}

// ─── Entry ────────────────────────────────────────────────────────────────────

console.log(`[e2e-sandbox] connecting ${URL}`)
ws = new WebSocket(URL)
ws.addEventListener('open', () => console.log('[e2e-sandbox] connected'))
ws.addEventListener('message', onMessage)
ws.addEventListener('error', (err) => {
  console.error('[e2e-sandbox] ws error:', err.message ?? err)
  finish(3)
})
ws.addEventListener('close', () => {
  if (!sawTurnEnd) {
    console.error('[e2e-sandbox] ws closed early')
    finish(4)
  }
})
