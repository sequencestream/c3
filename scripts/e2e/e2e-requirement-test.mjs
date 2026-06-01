#!/usr/bin/env node
/**
 * End-to-end test for the REQUIREMENT-MANAGEMENT save flow.
 *
 * Scenario: register a throwaway project under /tmp, enter its requirement view
 * (`open_requirement_chat` — opens/resumes the read-only communication session
 * and returns the project's requirement list), then ask the comm agent to
 * propose ONE requirement and call the `save_requirements` tool. The c3
 * requirement gate intercepts that call as a `permission_request`
 * (toolName `mcp__c3__save_requirements`); we approve it, the tool persists the
 * batch and the server broadcasts the refreshed `requirements` list (the new row
 * lands as status `todo`). Finally we flip the saved requirement to `done` via
 * `update_requirement_status` and confirm the broadcast reflects it.
 *
 * After the save flow, a SECOND turn on the same read-only comm session exercises
 * the requirement gate's AskUserQuestion handling — the runtime path the unit test
 * (`requirement-gate.test.ts`) cannot reach because the decision lives in a
 * `canUseTool` closure. We drive the comm agent to call AskUserQuestion; the gate
 * must route it to the answer panel (`permission_request`, toolName
 * `AskUserQuestion`) rather than the read-only deny-by-default fallback — if it
 * denied, no such request would arrive at all. We submit `answers`, and the agent
 * must echo our choice back, proving `withAnswers` fed the answer to the model.
 *
 * What this verifies (maps to the requirement spec):
 * - US-1/US-2: entering the view returns a `session_selected` comm session
 *   (title New Requirement) plus the project's `requirements` list.
 * - US-3/US-4: the agent's `save_requirements` call is gated (human confirm),
 *   and only persists after `allow` — landing as a `todo` row, broadcast live.
 * - status machine: `update_requirement_status` moves the row and re-broadcasts.
 * - read-only gate / AskUserQuestion (003 follow-up): AskUserQuestion is routed to
 *   the answer panel + answers injected, NOT denied as a non-read-only tool.
 *
 * Unlike the consensus tests this needs no extra agents — only the default agent
 * runs. It spends real tokens (two short comm turns — save, then AskUserQuestion)
 * and needs the requirement db (`c3.db`) available; the runner points `C3_DB_PATH`
 * at a throwaway file.
 *
 * Usage:
 *   pnpm start --project /tmp --port 13000     # in another terminal
 *   node scripts/e2e/e2e-requirement-test.mjs [ws-url]
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'

const URL = process.argv[2] || 'ws://localhost:13000/ws'
const TIMEOUT_MS = 240_000 // two live comm turns (save, then AskUserQuestion)

const SAVE_TOOL = 'mcp__c3__save_requirements'
const ASK_TOOL = 'AskUserQuestion'

// The label we expect the agent to echo back after we answer its question — proof
// that `withAnswers` injected our choice into the model's view of the tool result.
const ASK_CHOICE = 'pnpm'

// ---- Seed a throwaway project under /tmp (gives the read-only agent material) ----
const PROJECT_DIR = mkdtempSync('/tmp/c3-requirement-')
writeFileSync(
  `${PROJECT_DIR}/README.md`,
  ['# Demo project', '', 'A throwaway project for the c3 requirement e2e.', ''].join('\n'),
)

const REQ_TITLE = 'E2E 落库验证'
const PROMPT =
  `你是New Requirement助手。请不要阅读任何文件、也不要向我提问。` +
  `直接调用 save_requirements 工具,只提交一条需求:` +
  `title="${REQ_TITLE}",content="验证 c3 需求落库端到端流程",priority="P2"。` +
  `提交后用一句话告诉我已提交。`

// Second turn: force ONE AskUserQuestion call so the read-only gate must route it
// through the answer panel. Mirror the ask-consensus e2e prompt shape.
const ASK_PROMPT =
  `现在请只调用一次 AskUserQuestion 工具,向我提一个问题:` +
  `"Which package manager should this project use?",header 用 "PkgMgr",` +
  `选项依次为 "${ASK_CHOICE}"、"npm"、"yarn"。` +
  `等我回答后,用一句话复述我选择的包管理器名称。不要使用任何其他工具。`

console.log(`[e2e] project: ${PROJECT_DIR}`)
console.log(`[e2e] connecting ${URL}`)

/** @type {WebSocket} */
const ws = new WebSocket(URL)

// ---- State ----
let workspaceAdded = false
let chatOpened = false
let promptSent = false
let commSessionId = null

let sawCommSession = false // session_selected for the comm session (title New Requirement)
let sawInitialList = false // first `requirements` reply (the list on entry)
let sawSavePermission = false // permission_request for save_requirements
let proposedValid = false // the proposed payload looked well-formed
let savedReqId = null // id of the persisted requirement (from the broadcast)
let sawSaveResult = false // tool_result for the save call (not an error)
let statusUpdated = false // the saved row flipped to `done` via update_requirement_status
let statusUpdateSent = false

// ---- AskUserQuestion turn (second turn) ----
let askPromptSent = false // the AskUserQuestion prompt has been sent
let sawAskPermission = false // permission_request for AskUserQuestion (gate ROUTED it, didn't deny)
let askAnswered = false // we submitted answers to the panel
let askAnswerInjected = false // the agent echoed ASK_CHOICE back (withAnswers worked)
let sawAskTurnEnd = false // the AskUserQuestion turn completed

// ---- new_requirement_chat ("+" → brand-new comm session) ----
let newChatSent = false // we sent new_requirement_chat
let sawNewChat = false // got a fresh session_selected with a different id + empty history

let saveTurnReason = '' // turn_end reason of the first (save) turn
let askTurnReason = '' // turn_end reason of the second (AskUserQuestion) turn
let finished = false
const events = []

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
      console.log('[e2e] ready → adding workspace')
      workspaceAdded = true
      send({ type: 'add_workspace', path: PROJECT_DIR })
      break

    case 'workspaces':
      if (workspaceAdded && !chatOpened) {
        chatOpened = true
        console.log('[e2e] entering requirement view (open_requirement_chat)')
        send({ type: 'open_requirement_chat', projectPath: PROJECT_DIR })
      }
      break

    case 'session_selected':
      if (newChatSent) {
        // Response to new_requirement_chat: must be a DIFFERENT session id with an
        // empty history (the old conversation must not bleed into the new one).
        const fresh = msg.sessionId !== commSessionId && (msg.history?.length ?? 0) === 0
        sawNewChat = fresh
        console.log(
          `[e2e] ${fresh ? '✅' : '⚠️'} new_requirement_chat → session ${msg.sessionId} ` +
            `(prev ${commSessionId}, history=${msg.history?.length ?? 0})`,
        )
        finish(judge())
        break
      }
      // The comm session for the requirement view (read-only, title New Requirement).
      sawCommSession = true
      commSessionId = msg.sessionId
      console.log(`[e2e] comm session ${commSessionId} (title="${msg.title}")`)
      break

    case 'requirements': {
      const count = msg.items.length
      if (!sawInitialList) {
        sawInitialList = true
        console.log(`[e2e] initial requirement list: ${count} item(s)`)
        // List in hand → drive the comm agent to propose + save.
        if (!promptSent && commSessionId) {
          promptSent = true
          console.log('[e2e] sending save prompt to comm agent')
          send({ type: 'user_prompt', text: PROMPT })
        }
        break
      }
      // A later broadcast: after the save it carries our new `todo` row; after the
      // status update it carries the same row as `done`.
      const mine =
        msg.items.find((r) => r.id === savedReqId) ?? msg.items.find((r) => r.title === REQ_TITLE)
      if (mine && !savedReqId) {
        savedReqId = mine.id
        console.log(
          `[e2e] ✅ requirement persisted: id=${mine.id} status=${mine.status} priority=${mine.priority}`,
        )
      }
      if (mine && mine.status === 'done') {
        statusUpdated = true
        console.log('[e2e] ✅ status updated → done')
        maybeStartAskTurn() // save flow done → exercise the AskUserQuestion path
      }
      break
    }

    case 'assistant_text':
      console.log(
        `[e2e] assistant_text: ${msg.text.slice(0, 100)}${msg.text.length > 100 ? '…' : ''}`,
      )
      // After we answer the panel, the agent should name our choice back — only
      // possible if `withAnswers` injected the answer into the tool result.
      if (
        askAnswered &&
        !askAnswerInjected &&
        msg.text.toLowerCase().includes(ASK_CHOICE.toLowerCase())
      ) {
        askAnswerInjected = true
        console.log(`[e2e] ✅ agent echoed "${ASK_CHOICE}" → withAnswers injection confirmed`)
      }
      break

    case 'tool_use':
      console.log(`[e2e] tool_use: ${msg.toolName}`)
      break

    case 'permission_request':
      if (msg.toolName === SAVE_TOOL) {
        sawSavePermission = true
        const reqs =
          msg.input && Array.isArray(msg.input.requirements) ? msg.input.requirements : []
        proposedValid =
          reqs.length >= 1 && reqs.every((r) => r && r.title && r.content && r.priority)
        console.log(
          `[e2e] ✅ save_requirements gated: ${reqs.length} proposed (valid=${proposedValid}) → allow`,
        )
        send({ type: 'permission_response', requestId: msg.requestId, decision: 'allow' })
      } else if (msg.toolName === ASK_TOOL) {
        // Reaching here AT ALL proves the read-only gate routed AskUserQuestion to
        // the answer panel instead of denying it (a denied tool yields no
        // permission_request). Single agent ⇒ plain panel, no consensus roll-up.
        sawAskPermission = true
        const answers = {}
        for (const q of msg.input?.questions ?? []) {
          const labels = (q.options ?? []).map((o) => o.label)
          // Prefer our sentinel choice so we can detect the echo; else first option.
          answers[q.question] = labels.includes(ASK_CHOICE) ? ASK_CHOICE : (labels[0] ?? '')
        }
        askAnswered = true
        console.log(
          `[e2e] ✅ AskUserQuestion gated (routed to panel) → answers ${JSON.stringify(answers)}`,
        )
        send({ type: 'permission_response', requestId: msg.requestId, decision: 'allow', answers })
      } else {
        // The read-only gate should only ever prompt for save_requirements or
        // AskUserQuestion. Anything else is a regression — deny it.
        console.log(`[e2e] ⚠️ unexpected permission_request: ${msg.toolName} → deny`)
        send({ type: 'permission_response', requestId: msg.requestId, decision: 'deny' })
      }
      break

    case 'tool_result':
      if (!msg.isError) sawSaveResult = true
      console.log(`[e2e] tool_result (isError=${msg.isError})`)
      break

    case 'turn_end': {
      const reason = msg.reason + (msg.error ? `: ${msg.error}` : '')
      console.log(`[e2e] turn_end: ${reason}`)
      if (askPromptSent) {
        // The AskUserQuestion (second) turn finished. Last flow: exercise the "+"
        // (new_requirement_chat) before judging.
        sawAskTurnEnd = true
        askTurnReason = reason
        maybeStartNewChat()
        break
      }
      // First (save) turn finished. Drive the status machine, then start the
      // AskUserQuestion turn once the `done` broadcast lands (bounded fallback so a
      // slow/missing broadcast still hands off to the second turn).
      saveTurnReason = reason
      if (savedReqId && !statusUpdateSent) {
        statusUpdateSent = true
        console.log(`[e2e] update_requirement_status ${savedReqId} → done`)
        send({ type: 'update_requirement_status', requirementId: savedReqId, status: 'done' })
        setTimeout(maybeStartAskTurn, 4000)
      } else {
        maybeStartAskTurn()
      }
      break
    }

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

// Start the second (AskUserQuestion) turn once the save flow is done. Idempotent:
// reachable both from the `done` broadcast and from a bounded turn_end fallback.
function maybeStartAskTurn() {
  if (askPromptSent || finished) return
  if (!commSessionId) {
    finish(judge())
    return
  }
  askPromptSent = true
  console.log('[e2e] sending AskUserQuestion prompt to comm agent')
  send({ type: 'user_prompt', text: ASK_PROMPT })
}

// Final flow: open a brand-new comm session via "+". The response is handled in
// the `session_selected` case, which verifies a fresh id + empty history then judges.
function maybeStartNewChat() {
  if (newChatSent || finished) return
  newChatSent = true
  console.log('[e2e] sending new_requirement_chat (the "+" button)')
  send({ type: 'new_requirement_chat', projectPath: PROJECT_DIR })
}

function judge() {
  console.log('\n========== REQUIREMENT E2E REPORT ==========')
  console.log(`events: ${JSON.stringify(events)}`)
  const checks = {
    comm_session_opened: sawCommSession,
    requirement_list_returned: sawInitialList,
    save_gated: sawSavePermission,
    proposed_payload_valid: proposedValid,
    requirement_persisted: !!savedReqId,
    save_tool_result_ok: sawSaveResult,
    status_update_broadcast: statusUpdated,
    save_turn_completed_clean: saveTurnReason.startsWith('complete'),
    // AskUserQuestion runtime path (003 follow-up): routed to the panel (not
    // denied) and the injected answer made it back to the model.
    ask_gated: sawAskPermission,
    ask_answer_injected: askAnswerInjected,
    ask_turn_completed_clean: sawAskTurnEnd && askTurnReason.startsWith('complete'),
    // "+" → new_requirement_chat: fresh session id, empty history (old chat not threaded in).
    new_chat_fresh_session: sawNewChat,
  }
  console.log('checks:', checks)
  const pass = Object.values(checks).every(Boolean)
  console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL')
  console.log('============================================\n')
  return pass ? 0 : 1
}

function finish(code) {
  if (finished) return
  finished = true
  clearTimeout(timeout)
  try {
    rmSync(PROJECT_DIR, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  try {
    ws.close()
  } catch {
    /* already closed */
  }
  process.exit(code)
}
