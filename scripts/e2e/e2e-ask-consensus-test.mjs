#!/usr/bin/env node
/**
 * End-to-end test for multi-agent consensus over an `AskUserQuestion` prompt.
 *
 * Scenario: ask the model to use AskUserQuestion to pose ONE clear question with
 * a few options, then proceed. With consensus enabled, the *other* agents answer
 * the question(s); if they all agree the gateway auto-answers (`consensus_auto`
 * with `outcome.kind === 'ask'`), otherwise a `permission_request` carries the
 * per-question roll-up (`consensus.kind === 'ask'`) and we submit `answers`.
 *
 * Verification: consensus must actually run on AskUserQuestion (either path), the
 * answer must be fed back (we see a tool_result / the model continues), and the
 * turn must complete cleanly. Settings are captured + restored like the sibling
 * consensus e2e.
 *
 * Usage:
 *   pnpm start --project /tmp --port 13000     # in another terminal
 *   node scripts/e2e/e2e-ask-consensus-test.mjs [ws-url]
 */
const URL = process.argv[2] || 'ws://localhost:13000/ws'
const TIMEOUT_MS = 300_000

const PROMPT =
  'Use the AskUserQuestion tool once to ask me a single question: "Which package ' +
  'manager should this project use?" with header "PkgMgr" and options labeled ' +
  '"pnpm", "npm", "yarn". After I answer, reply with one short sentence naming my ' +
  'choice. Do not use any other tools.'

const ws = new WebSocket(URL)

let originalSettings = null
let workspaceAdded = false
let sessionCreated = false
let promptSent = false

let sawConsensusAuto = false
let sawConsensusSplitAsk = false
let sawAskKind = false
let answeredPanel = false
let sawTurnEnd = false
let turnReason = ''
let finished = false
const events = []

const PROJECT_DIR = '/tmp'

const timeout = setTimeout(() => {
  console.error('[e2e] TIMEOUT')
  finish(2)
}, TIMEOUT_MS)

function send(msg) {
  ws.send(JSON.stringify(msg))
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
      send({ type: 'get_settings' })
      break

    case 'settings': {
      if (!originalSettings) {
        originalSettings = msg.settings
        const voters = msg.settings.agents.filter((a) => a.id !== msg.settings.defaultAgentId)
        console.log(`[e2e] voters=${voters.length} consensus=${!!msg.settings.consensus?.enabled}`)
        if (voters.length < 1) {
          console.error('[e2e] need ≥1 non-default agent to vote — aborting')
          finish(5)
          return
        }
        send({ type: 'save_settings', settings: { ...msg.settings, consensus: { enabled: true } } })
        return
      }
      if (!workspaceAdded) {
        workspaceAdded = true
        send({ type: 'add_workspace', path: PROJECT_DIR })
      }
      break
    }

    case 'workspaces':
      if (workspaceAdded && !sessionCreated) {
        sessionCreated = true
        send({ type: 'create_session', workspacePath: PROJECT_DIR })
      }
      break

    case 'session_selected':
      if (!promptSent) {
        promptSent = true
        // Pin to `default` so AskUserQuestion routes through the gateway (and
        // thus consensus), independent of the user's configured default mode.
        send({ type: 'set_mode', mode: 'default' })
        console.log(
          `[e2e] session ${msg.sessionId} → set_mode default → sending AskUserQuestion prompt`,
        )
        send({ type: 'user_prompt', text: PROMPT })
      }
      break

    case 'assistant_text':
      console.log(`[e2e] assistant: ${msg.text.slice(0, 120)}`)
      break

    case 'tool_use':
      console.log(`[e2e] tool_use: ${msg.toolName}`)
      break

    case 'tool_result':
      console.log(`[e2e] tool_result: ${msg.content.slice(0, 160)}`)
      break

    case 'consensus_auto':
      sawConsensusAuto = true
      if (msg.outcome?.kind === 'ask') {
        sawAskKind = true
        console.log(
          `[e2e] ✅ consensus_auto (ask): fullyUnanimous=${msg.outcome.fullyUnanimous} agreed=${JSON.stringify(msg.outcome.agreedAnswers)}`,
        )
      } else {
        console.log(`[e2e] ⚠️ consensus_auto but kind=${msg.outcome?.kind} (expected ask)`)
      }
      break

    case 'permission_request': {
      if (msg.toolName !== 'AskUserQuestion') {
        // Unexpected tool — just allow to let the run finish.
        send({ type: 'permission_response', requestId: msg.requestId, decision: 'allow' })
        return
      }
      if (msg.consensus?.kind === 'ask') {
        sawConsensusSplitAsk = true
        sawAskKind = true
        console.log(
          `[e2e] ✅ permission_request WITH ask-consensus (split): ${msg.consensus.summary}`,
        )
      } else {
        console.log('[e2e] ⚠️ AskUserQuestion permission_request WITHOUT ask-consensus')
      }
      // Build answers: pick the first option of each question.
      const answers = {}
      for (const q of msg.input?.questions ?? []) {
        answers[q.question] = q.options?.[0]?.label ?? ''
      }
      answeredPanel = true
      console.log(`[e2e] submitting answers: ${JSON.stringify(answers)}`)
      send({ type: 'permission_response', requestId: msg.requestId, decision: 'allow', answers })
      break
    }

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
  console.log('\n========== ASK CONSENSUS E2E REPORT ==========')
  console.log(`events: ${JSON.stringify(events)}`)
  const checks = {
    consensus_ran_on_ask: sawAskKind,
    answer_path_exercised: sawConsensusAuto || answeredPanel,
    turn_completed_clean: sawTurnEnd && turnReason.startsWith('complete'),
  }
  console.log('checks:', checks)
  console.log(`auto=${sawConsensusAuto} split=${sawConsensusSplitAsk}`)
  const pass = Object.values(checks).every(Boolean)
  console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL')
  console.log('==============================================\n')
  return pass ? 0 : 1
}

function finish(code) {
  if (finished) return
  finished = true
  clearTimeout(timeout)
  const cleanup = () => {
    try {
      ws.close()
    } catch {
      /* ignore */
    }
    process.exit(code)
  }
  if (originalSettings && ws.readyState === WebSocket.OPEN) {
    send({ type: 'save_settings', settings: originalSettings })
    setTimeout(cleanup, 800)
  } else {
    cleanup()
  }
}
