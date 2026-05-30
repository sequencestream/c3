#!/usr/bin/env node
/**
 * End-to-end test for the multi-agent CONSENSUS voting flow.
 *
 * Scenario (coding): create a throwaway project under /tmp, seed it with a tiny
 * source file, then ask the model to MODIFY that file. The edit forces a
 * sensitive tool (Edit) through `canUseTool`, which — with consensus enabled —
 * puts the call to the *other* configured agents to vote on before either
 * auto-resolving (unanimous) or asking the human (split).
 *
 * Config: the agents/keys come from the real `~/.c3/settings.json` (driven via
 * the `get_settings` / `save_settings` wire messages). Consensus is usually off
 * there, so this test TEMPORARILY enables it for the run and RESTORES the
 * original settings on exit. The agents themselves are never modified.
 *
 * Verification: the run must surface consensus actually executing — either a
 * `consensus_auto` event (all voters agreed → auto allow/deny) or a
 * `permission_request` carrying a `consensus` outcome (split → human decides).
 * A plain `permission_request` with no `consensus` would mean voting did not run.
 *
 * Usage:
 *   pnpm start --project /tmp --port 13000     # in another terminal
 *   node scripts/e2e/e2e-consensus-test.mjs [ws-url]
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'

const URL = process.argv[2] || 'ws://localhost:13000/ws'
const TIMEOUT_MS = 300_000 // voting spawns several advisor queries — be generous

// ---- Seed a throwaway coding project under /tmp ----
const PROJECT_DIR = mkdtempSync('/tmp/c3-consensus-')
const SRC_FILE = `${PROJECT_DIR}/calc.js`
writeFileSync(
  SRC_FILE,
  ['function add(a, b) {', '  return a + b', '}', '', 'module.exports = { add }', ''].join('\n'),
)
const PROMPT =
  `In this project, use the Edit tool to modify calc.js so the \`add\` function ` +
  `logs the string "add called" to the console before returning. ` +
  `Do not run any shell commands and do not create any other files.`

console.log(`[e2e] project: ${PROJECT_DIR}`)
console.log(`[e2e] connecting ${URL}`)

/** @type {WebSocket} */
const ws = new WebSocket(URL)

// ---- State ----
let originalSettings = null // captured from get_settings, restored on exit
let consensusEnabled = false
let voterCount = 0
let workspaceAdded = false
let sessionCreated = false
let promptSent = false

let sawPermission = false
let sawConsensusAuto = false
let sawConsensusSplit = false
let autoDecision = null // 'allow' | 'deny' when unanimous
let lastVotes = null
let sawTurnEnd = false
let turnReason = ''
let finished = false
const events = []

const timeout = setTimeout(() => {
  console.error('[e2e] TIMEOUT')
  finish(2)
}, TIMEOUT_MS)

function send(msg) {
  ws.send(JSON.stringify(msg))
}

function describeOutcome(outcome) {
  if (!outcome) return ''
  const votes = (outcome.votes || []).map((v) => `${v.agentName}=${v.decision}`).join(', ')
  return `unanimous=${outcome.unanimous} decision=${outcome.decision ?? 'null'} | ${votes} | summary: ${outcome.summary}`
}

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
    case 'ready':
      console.log('[e2e] ready → fetching settings')
      send({ type: 'get_settings' })
      break

    case 'settings': {
      // First settings reply is the real config — capture + enable consensus.
      if (!originalSettings) {
        originalSettings = msg.settings
        const voters = msg.settings.agents.filter((a) => a.id !== msg.settings.defaultAgentId)
        voterCount = voters.length
        console.log(
          `[e2e] agents=${msg.settings.agents.length} default=${msg.settings.defaultAgentId} voters=${voterCount} consensus=${!!msg.settings.consensus?.enabled}`,
        )
        if (voterCount < 1) {
          console.error('[e2e] need at least one agent besides the default to vote — aborting')
          finish(5)
          return
        }
        console.log('[e2e] temporarily enabling consensus for the test run')
        send({
          type: 'save_settings',
          settings: { ...msg.settings, consensus: { enabled: true } },
        })
        return
      }
      // Second settings reply confirms consensus is on — start the scenario.
      if (!workspaceAdded) {
        consensusEnabled = !!msg.settings.consensus?.enabled
        console.log(`[e2e] consensus now enabled=${consensusEnabled} → adding workspace`)
        workspaceAdded = true
        send({ type: 'add_workspace', path: PROJECT_DIR })
      }
      break
    }

    case 'workspaces':
      if (workspaceAdded && !sessionCreated) {
        sessionCreated = true
        console.log('[e2e] creating session')
        send({ type: 'create_session', workspacePath: PROJECT_DIR })
      }
      break

    case 'session_selected':
      if (!promptSent) {
        promptSent = true
        // Pin to `default` so Edit hits `canUseTool` (and thus consensus) — the
        // user's configured default mode (e.g. `auto`/`acceptEdits`) would
        // otherwise auto-approve the edit and skip voting entirely.
        send({ type: 'set_mode', mode: 'default' })
        console.log(`[e2e] session ${msg.sessionId} → set_mode default → sending coding prompt`)
        send({ type: 'user_prompt', text: PROMPT })
      }
      break

    case 'assistant_text':
      console.log(
        `[e2e] assistant_text: ${msg.text.slice(0, 100)}${msg.text.length > 100 ? '…' : ''}`,
      )
      break

    case 'tool_use':
      console.log(`[e2e] tool_use: ${msg.toolName}`)
      break

    case 'tool_result':
      console.log(`[e2e] tool_result (isError=${msg.isError})`)
      break

    case 'consensus_auto':
      sawConsensusAuto = true
      autoDecision = msg.outcome.decision
      lastVotes = msg.outcome.votes
      console.log(`[e2e] ✅ consensus_auto (${msg.toolName}): ${describeOutcome(msg.outcome)}`)
      break

    case 'permission_request':
      sawPermission = true
      if (msg.consensus) {
        sawConsensusSplit = true
        lastVotes = msg.consensus.votes
        console.log(
          `[e2e] ✅ permission_request WITH consensus (split): ${describeOutcome(msg.consensus)}`,
        )
      } else {
        console.log('[e2e] ⚠️ permission_request WITHOUT consensus — voting did not run')
      }
      // Approve so the run can complete in both the split and no-consensus cases.
      send({ type: 'permission_response', requestId: msg.requestId, decision: 'allow' })
      break

    case 'turn_end':
      sawTurnEnd = true
      turnReason = msg.reason + (msg.error ? `: ${msg.error}` : '')
      console.log(`[e2e] turn_end: ${turnReason}`)
      finish(judge())
      break

    case 'error':
      console.error(`[e2e] error: ${msg.message}`)
      break
  }
})

ws.addEventListener('error', (err) => {
  console.error('[e2e] ws error:', err.message ?? err)
  finish(3)
})

ws.addEventListener('close', () => {
  if (!finished) {
    console.error('[e2e] ws closed before completion')
    finish(4)
  }
})

function judge() {
  const consensusObserved = sawConsensusAuto || sawConsensusSplit
  console.log('\n========== CONSENSUS E2E REPORT ==========')
  console.log(`events: ${JSON.stringify(events)}`)
  const checks = {
    consensus_enabled: consensusEnabled,
    permission_reached: sawPermission || sawConsensusAuto,
    consensus_executed: consensusObserved,
    turn_completed_clean: sawTurnEnd && turnReason.startsWith('complete'),
  }
  console.log('checks:', checks)
  if (sawConsensusAuto) console.log(`auto-decision: ${autoDecision}`)
  if (lastVotes) console.log(`votes: ${JSON.stringify(lastVotes)}`)
  const pass = Object.values(checks).every(Boolean)
  console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL')
  console.log('==========================================\n')
  return pass ? 0 : 1
}

// Best-effort restore of the original settings, then clean up + exit.
function finish(code) {
  if (finished) return
  finished = true
  clearTimeout(timeout)

  const cleanup = () => {
    try {
      rmSync(PROJECT_DIR, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    try {
      ws.close()
    } catch {
      /* ignore */
    }
    process.exit(code)
  }

  if (originalSettings && ws.readyState === WebSocket.OPEN) {
    console.log('[e2e] restoring original settings')
    send({ type: 'save_settings', settings: originalSettings })
    setTimeout(cleanup, 800) // give the restore a moment to flush
  } else {
    cleanup()
  }
}
