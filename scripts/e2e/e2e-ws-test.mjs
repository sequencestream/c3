#!/usr/bin/env node
/**
 * End-to-end WebSocket smoke test: simulates a browser submitting a prompt
 * that requires a tool, auto-approving the permission prompt, and confirming
 * we see tool_result + turn_end.
 *
 * Usage:
 *   node scripts/e2e-ws-test.mjs [ws-url] [prompt]
 */
// Node 22+ has WebSocket as a global; no external dep needed.
const URL = process.argv[2] || 'ws://localhost:13000/ws'
const PROMPT =
  process.argv[3] ||
  'Use the Write tool to create the file /tmp/c3-e2e-test.txt with content exactly "c3-e2e-ok". Do not run any other commands.'
const TIMEOUT_MS = 120_000

console.log(`[e2e] connecting ${URL}`)
/** @type {WebSocket} */
const ws = new WebSocket(URL)

let sawReady = false
let sessionCreated = false
let promptSent = false
let sawPermissionRequest = false
let sawConsensusAuto = false
let sawToolUse = false
let sawToolResult = false
let sawTurnEnd = false
let endReason = ''
const events = []

const timeout = setTimeout(() => {
  console.error('[e2e] TIMEOUT — closing')
  finish(2)
}, TIMEOUT_MS)

ws.addEventListener('open', () => {
  console.log('[e2e] open')
})

ws.addEventListener('message', (evt) => {
  let msg
  try {
    msg = JSON.parse(typeof evt.data === 'string' ? evt.data : String(evt.data))
  } catch {
    return
  }
  events.push(msg.type)

  if (msg.type === 'ready') {
    sawReady = true
    const ws0 = msg.workspaces?.[0]?.path
    if (!ws0) {
      console.error('[e2e] no seed workspace in ready — start with --project <dir>')
      finish(5)
      return
    }
    console.log(`[e2e] ready → creating session in ${ws0}`)
    sessionCreated = true
    ws.send(JSON.stringify({ type: 'create_session', workspacePath: ws0 }))
  } else if (msg.type === 'session_selected') {
    if (!promptSent) {
      promptSent = true
      // Pin to `default` so the permission gateway fires regardless of the
      // user's configured default mode (e.g. `auto`/`acceptEdits` would
      // silently auto-approve the Write and skip the prompt we're testing).
      ws.send(JSON.stringify({ type: 'set_mode', mode: 'default' }))
      console.log(`[e2e] session ${msg.sessionId} → set_mode default → sending prompt`)
      ws.send(JSON.stringify({ type: 'user_prompt', text: PROMPT }))
    }
  } else if (msg.type === 'consensus_auto') {
    // Consensus enabled in the user's settings: a unanimous vote auto-resolves
    // the tool with no human prompt. That still counts as the gateway firing.
    sawConsensusAuto = true
    console.log(`[e2e] consensus_auto (${msg.toolName}): decision=${msg.outcome?.decision}`)
  } else if (msg.type === 'assistant_text') {
    console.log(
      `[e2e] assistant_text: ${msg.text.slice(0, 120)}${msg.text.length > 120 ? '…' : ''}`,
    )
  } else if (msg.type === 'permission_request') {
    sawPermissionRequest = true
    console.log(
      `[e2e] permission_request: tool=${msg.toolName} input=${JSON.stringify(msg.input).slice(0, 200)}`,
    )
    console.log('[e2e] auto-approving...')
    ws.send(
      JSON.stringify({
        type: 'permission_response',
        requestId: msg.requestId,
        decision: 'allow',
      }),
    )
  } else if (msg.type === 'tool_use') {
    sawToolUse = true
    console.log(`[e2e] tool_use: ${msg.toolName} id=${msg.toolUseId}`)
  } else if (msg.type === 'tool_result') {
    sawToolResult = true
    const summary = msg.content.slice(0, 200)
    console.log(`[e2e] tool_result (isError=${msg.isError}): ${summary}`)
  } else if (msg.type === 'turn_end') {
    sawTurnEnd = true
    endReason = msg.reason + (msg.error ? `: ${msg.error}` : '')
    console.log(`[e2e] turn_end: ${endReason}`)
    finish(judge())
  }
})

ws.addEventListener('error', (err) => {
  console.error('[e2e] ws error:', err.message ?? err)
  finish(3)
})

ws.addEventListener('close', () => {
  if (!sawTurnEnd) {
    console.error('[e2e] ws closed before turn_end')
    finish(4)
  }
})

function judge() {
  console.log('\n========== E2E REPORT ==========')
  console.log(`events seen: ${JSON.stringify(events)}`)
  const checks = {
    ready: sawReady,
    session_created: sessionCreated,
    // The gateway fired — either a human prompt or a unanimous consensus auto-resolve.
    permission_gateway: sawPermissionRequest || sawConsensusAuto,
    tool_use: sawToolUse,
    tool_result: sawToolResult,
    turn_end_clean: sawTurnEnd && !endReason.startsWith('error'),
  }
  console.log('checks:', checks)
  const pass = Object.values(checks).every(Boolean)
  console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL')
  console.log('================================\n')
  return pass ? 0 : 1
}

function finish(code) {
  clearTimeout(timeout)
  try {
    ws.close()
  } catch {
    // already closed — nothing to do
  }
  process.exit(code)
}
