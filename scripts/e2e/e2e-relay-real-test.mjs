#!/usr/bin/env node
/**
 * Real end-to-end validation of the vendor-neutral relay (ADR-0029).
 *
 * Drives ONE tool-less turn on a specific agent through a running c3 server:
 * create a session, re-target it to the given agent id, send a prompt that asks
 * the model to echo a sentinel word, and PASS iff the turn completes cleanly and
 * the sentinel comes back in the assistant text. Because ALL custom-provider
 * traffic now flows through c3's loopback relay, a successful reply proves the
 * relay path end-to-end:
 *   - claude custom  → anthropic passthrough (auth swap + model override),
 *   - codex custom (wireApi=chat) → Responses↔Chat translation,
 * with the real provider key held only in the relay (never in the subprocess).
 *
 * Usage:
 *   node scripts/e2e/e2e-relay-real-test.mjs <ws-url> <agentId> [sentinel]
 * Exit: 0 PASS, 1 FAIL, 2 TIMEOUT, 3 ws-error.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const URL = process.argv[2] || 'ws://localhost:13123/ws'
const PROJECT_DIR = mkdtempSync(join(tmpdir(), 'c3-e2e-relay-'))
writeFileSync(join(PROJECT_DIR, 'README.md'), '# c3 e2e relay\n')

const AGENT_ID = process.argv[3]
const SENTINEL = process.argv[4] || 'BANANA42'
const TIMEOUT_MS = 120_000

if (!AGENT_ID) {
  console.error('[relay-e2e] usage: e2e-relay-real-test.mjs <ws-url> <agentId> [sentinel]')
  process.exit(1)
}

const PROMPT =
  `Reply with exactly the single word ${SENTINEL} and nothing else. ` +
  `Do not use any tools. Do not explain.`

console.log(`[relay-e2e] connecting ${URL} — agent=${AGENT_ID} sentinel=${SENTINEL}`)
const ws = new WebSocket(URL)

let sessionId = ''
let agentSet = false
let promptSent = false
let sawText = ''
let sawTurnEnd = false
let endReason = ''
const events = []

const timeout = setTimeout(() => {
  console.error('[relay-e2e] TIMEOUT')
  finish(2)
}, TIMEOUT_MS)

ws.addEventListener('message', (evt) => {
  let msg
  try {
    msg = JSON.parse(typeof evt.data === 'string' ? evt.data : String(evt.data))
  } catch {
    return
  }
  events.push(msg.type)

  if (msg.type === 'ready') {
    console.log(`[relay-e2e] ready → add_workspace ${PROJECT_DIR}`)
    ws.send(JSON.stringify({ type: 'add_workspace', path: PROJECT_DIR }))
  } else if (msg.type === 'workspaces') {
    if (sessionId) return
    const added =
      msg.workspaces?.find((w) => w.name === PROJECT_DIR.split('/').pop()) ?? msg.workspaces?.[0]
    const ws0 = added?.id ?? null
    if (!ws0) {
      console.error('[relay-e2e] no workspace after add_workspace')
      finish(5)
      return
    }
    console.log(`[relay-e2e] workspaces → create_session in ${ws0}`)
    ws.send(JSON.stringify({ type: 'create_session', workspaceId: ws0 }))
  } else if (msg.type === 'session_selected') {
    sessionId = msg.sessionId
    if (!agentSet) {
      agentSet = true
      // Re-target the (pending) session onto the agent under test, then send the turn.
      console.log(`[relay-e2e] session ${sessionId} → set_session_agent ${AGENT_ID}`)
      ws.send(JSON.stringify({ type: 'set_session_agent', sessionId, agentId: AGENT_ID }))
      ws.send(JSON.stringify({ type: 'set_mode', mode: 'default' }))
      if (!promptSent) {
        promptSent = true
        console.log('[relay-e2e] → user_prompt')
        ws.send(JSON.stringify({ type: 'user_prompt', text: PROMPT }))
      }
    }
  } else if (msg.type === 'session_agent_changed') {
    console.log(`[relay-e2e] session_agent_changed ok=${msg.ok}`)
  } else if (msg.type === 'assistant_text') {
    sawText += msg.text
    console.log(`[relay-e2e] assistant_text: ${String(msg.text).slice(0, 200)}`)
  } else if (msg.type === 'agent_failed') {
    console.error(`[relay-e2e] agent_failed: ${msg.agentName} — ${msg.error}`)
  } else if (msg.type === 'turn_end') {
    sawTurnEnd = true
    endReason = msg.reason + (msg.error ? `: ${msg.error}` : '')
    console.log(`[relay-e2e] turn_end: ${endReason}`)
    finish(judge())
  }
})

ws.addEventListener('error', (err) => {
  console.error('[relay-e2e] ws error:', err?.message ?? err)
  finish(3)
})
ws.addEventListener('close', () => {
  if (!sawTurnEnd) {
    console.error('[relay-e2e] ws closed before turn_end')
    finish(4)
  }
})

function judge() {
  const cleanEnd = sawTurnEnd && !endReason.startsWith('error')
  const gotSentinel = sawText.toUpperCase().includes(SENTINEL.toUpperCase())
  console.log('\n========== RELAY E2E REPORT ==========')
  console.log(`events: ${JSON.stringify(events)}`)
  console.log('checks:', { cleanEnd, gotSentinel, endReason })
  const pass = cleanEnd && gotSentinel
  console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL')
  console.log('======================================\n')
  return pass ? 0 : 1
}

function finish(code) {
  clearTimeout(timeout)
  try {
    ws.close()
  } catch {
    /* already closed */
  }
  try {
    rmSync(PROJECT_DIR, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  process.exit(code)
}
