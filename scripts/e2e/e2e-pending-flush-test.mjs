#!/usr/bin/env node
/**
 * End-to-end WebSocket test for the pending-queue flush race.
 *
 * Reproduces the client's "pending send queue" behaviour at the protocol level:
 * while an ordinary turn runs the browser queues a second prompt, then flushes it
 * the instant the session's `session_status` flips back to idle (App.vue's
 * `flushIfReady`, watching the running→idle transition). The bug: the server used
 * to broadcast `idle` from inside the run's `turn_end` — BEFORE the run's teardown
 * `finally` nulled `rt.run` — so the immediately-flushed `user_prompt` raced the
 * teardown and got rejected with "A turn is already running in this session.",
 * silently dropping the queued prompt. The teardown gap is the whole SDK query
 * winddown (input.close → iterator end), tens-to-hundreds of ms, so the flush
 * reliably beats it.
 *
 * This test sends a first trivial (tool-less) prompt, waits for our session's
 * `session_status` to transition running→idle, and AT THAT MOMENT sends a second
 * prompt — exactly mirroring the flush. It FAILS if the server answers with the
 * "already running" error, PASSES if the second turn is accepted and completes.
 *
 * Usage:
 *   node scripts/e2e/e2e-pending-flush-test.mjs [ws-url]
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const URL = process.argv[2] || 'ws://localhost:13000/ws'
const PROJECT_DIR = mkdtempSync(join(tmpdir(), 'c3-e2e-pending-flush-'))
writeFileSync(join(PROJECT_DIR, 'README.md'), '# c3 e2e pending-flush\n')

const PROMPT_1 = 'Reply with exactly the word ONE and nothing else. Do not use any tools.'
const PROMPT_2 = 'Reply with exactly the word TWO and nothing else. Do not use any tools.'
const TIMEOUT_MS = 120_000

console.log(`[e2e] connecting ${URL}`)
/** @type {WebSocket} */
const ws = new WebSocket(URL)

let sawReady = false
let sessionId = null
let firstSent = false
let turn1SawRunning = false
let secondSent = false
let sawAlreadyRunningError = false
let turnEndCount = 0
let secondTurnEnded = false
const events = []

const timeout = setTimeout(() => {
  console.error('[e2e] TIMEOUT — closing')
  finish(2)
}, TIMEOUT_MS)

ws.addEventListener('open', () => console.log('[e2e] open'))

ws.addEventListener('message', (evt) => {
  let msg
  try {
    msg = JSON.parse(typeof evt.data === 'string' ? evt.data : String(evt.data))
  } catch {
    return
  }
  events.push(msg.type)

  switch (msg.type) {
    case 'ready': {
      sawReady = true
      console.log(`[e2e] ready → adding workspace ${PROJECT_DIR}`)
      ws.send(JSON.stringify({ type: 'add_workspace', path: PROJECT_DIR }))
      break
    }
    case 'workspaces': {
      if (sessionId) break
      const added =
        msg.workspaces?.find((w) => w.name === PROJECT_DIR.split('/').pop()) ?? msg.workspaces?.[0]
      const ws0 = added?.id ?? null
      if (!ws0) {
        console.error('[e2e] no workspace after add_workspace')
        finish(5)
        return
      }
      console.log(`[e2e] workspaces → creating session in ${ws0}`)
      ws.send(JSON.stringify({ type: 'create_session', workspaceId: ws0 }))
      break
    }
    case 'session_selected': {
      sessionId = msg.sessionId
      if (!firstSent) {
        firstSent = true
        console.log(`[e2e] session ${sessionId} → sending first prompt`)
        ws.send(JSON.stringify({ type: 'user_prompt', text: PROMPT_1 }))
      }
      break
    }
    case 'session_started': {
      // Pending id re-keyed to the real SDK id; track the real one.
      if (sessionId === msg.clientId) {
        sessionId = msg.sessionId
        // Echo rebind_view so the server updates conn.viewing (ADR-0018).
        // Without this, the second user_prompt finds no runtime and is
        // rejected with session.notSelected.
        ws.send(JSON.stringify({ type: 'rebind_view', from: msg.clientId, to: msg.sessionId }))
      }
      break
    }
    case 'session_status': {
      const mine = msg.statuses?.find((s) => s.sessionId === sessionId)
      if (!mine) break
      if (mine.status === 'running') turn1SawRunning = true
      // running→idle for our session = the flush trigger. Mirror the client and
      // fire the second prompt the instant we see idle (after turn 1 ran).
      if (mine.status === 'idle' && turn1SawRunning && !secondSent) {
        secondSent = true
        console.log('[e2e] session idle → flushing second prompt (the race window)')
        ws.send(JSON.stringify({ type: 'user_prompt', text: PROMPT_2 }))
      }
      break
    }
    case 'assistant_text': {
      console.log(`[e2e] assistant_text: ${msg.text.slice(0, 80)}`)
      break
    }
    case 'error': {
      const errMsg = msg?.error?.code || msg?.message || JSON.stringify(msg)
      console.error(`[e2e] error: ${errMsg}`)
      if (/already running/i.test(errMsg)) sawAlreadyRunningError = true
      // The race rejection is terminal for the test — judge immediately.
      if (secondSent) finish(judge())
      break
    }
    case 'turn_end': {
      turnEndCount += 1
      console.log(
        `[e2e] turn_end #${turnEndCount}: ${msg.reason}${msg.error ? `: ${msg.error}` : ''}`,
      )
      // The second turn's terminal event (only counts once the flush was sent).
      if (secondSent && turnEndCount >= 2) {
        secondTurnEnded = true
        finish(judge())
      }
      break
    }
    default:
      break
  }
})

ws.addEventListener('error', (err) => {
  console.error('[e2e] ws error:', err.message ?? err)
  finish(3)
})

ws.addEventListener('close', () => {
  if (!secondTurnEnded && !sawAlreadyRunningError) {
    console.error('[e2e] ws closed before the second turn settled')
    finish(4)
  }
})

function judge() {
  console.log('\n========== E2E REPORT ==========')
  console.log(`events seen: ${JSON.stringify(events)}`)
  const checks = {
    ready: sawReady,
    first_turn_ran: turn1SawRunning,
    second_prompt_flushed: secondSent,
    // The whole point: the flushed prompt must NOT be rejected as "already running".
    no_already_running_error: !sawAlreadyRunningError,
    second_turn_accepted_and_ended: secondTurnEnded,
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
  try {
    rmSync(PROJECT_DIR, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  process.exit(code)
}
