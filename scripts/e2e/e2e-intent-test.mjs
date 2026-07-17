#!/usr/bin/env node
/**
 * End-to-end test for the INTENT-MANAGEMENT save flow.
 *
 * Scenario: register a throwaway project under /tmp, enter its intent view
 * (`open_intent_chat` — opens/resumes the read-only communication session
 * and returns the project's intent list), then ask the comm agent to
 * propose ONE intent and call the `save_intents` tool. The c3
 * intent gate intercepts that call as a `permission_request`
 * (toolName `mcp__c3__save_intents`); we approve it, the tool persists the
 * batch and the server broadcasts the refreshed `intents` list (the new row
 * lands as status `todo`). Finally we flip the saved intent to `done` via
 * `update_intent_status` and confirm the broadcast reflects it.
 *
 * After the save flow, a SECOND turn on the same read-only comm session exercises
 * the intent gate's AskUserQuestion handling — the runtime path the unit test
 * (`intent-gate.test.ts`) cannot reach because the decision lives in a
 * `canUseTool` closure. We drive the comm agent to call AskUserQuestion; the gate
 * must route it to the answer panel (`permission_request`, toolName
 * `AskUserQuestion`) rather than the read-only deny-by-default fallback — if it
 * denied, no such request would arrive at all. We submit `answers`, and the agent
 * must echo our choice back, proving `withAnswers` fed the answer to the model.
 *
 * What this verifies (maps to the intent spec):
 * - US-1/US-2: entering the view returns a `session_selected` comm session
 *   (title New Intent) plus the project's `intents` list.
 * - US-3/US-4: the agent's `save_intents` call is gated (human confirm),
 *   and only persists after `allow` — landing as a `todo` row, broadcast live.
 * - status machine: `update_intent_status` moves the row and re-broadcasts.
 * - read-only gate / AskUserQuestion (003 follow-up): AskUserQuestion is routed to
 *   the answer panel + answers injected, NOT denied as a non-read-only tool.
 * - deprecated alias soft-landing (PR-2): the save-flow probe accepts EITHER the
 *   new `mcp__c3__save_intents` OR the deprecated `mcp__c3__save_requirements`
 *   wire name as the gated save, so an old caller is proven "兜住" (same
 *   confirm-save path). The deterministic classifier proof lives in
 *   `server/src/intent-gate.test.ts` (the alias block).
 *
 * Unlike the consensus tests this needs no extra agents — only the default agent
 * runs. It spends real tokens (two short comm turns — save, then AskUserQuestion)
 * and needs the intent db (`c3.db`) available; the runner points `C3_DB_PATH`
 * at a throwaway file.
 *
 * Usage:
 *   pnpm start --port 13000     # in another terminal
 *   node scripts/e2e/e2e-intent-test.mjs [ws-url]
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'

const URL = process.argv[2] || 'ws://localhost:13000/ws'
const TIMEOUT_MS = 240_000 // two live comm turns (save, then AskUserQuestion)

const SAVE_TOOL = 'mcp__c3__save_intents'
// Deprecated wire-name alias kept callable for one minor version (PR-2 soft-landing).
// The save-flow probe accepts EITHER name as the gated save, so if anything still
// reaches for the old name the gate is proven to "兜住" it (same confirm-save path).
const SAVE_TOOL_DEPRECATED = 'mcp__c3__save_requirements'
const SAVE_TOOLS = new Set([SAVE_TOOL, SAVE_TOOL_DEPRECATED])
const ASK_TOOL = 'AskUserQuestion'

// The label we expect the agent to echo back after we answer its question — proof
// that `withAnswers` injected our choice into the model's view of the tool result.
const ASK_CHOICE = 'pnpm'

// ---- Seed a throwaway project under /tmp (gives the read-only agent material) ----
const PROJECT_DIR = mkdtempSync('/tmp/c3-intent-')
writeFileSync(
  `${PROJECT_DIR}/README.md`,
  ['# Demo project', '', 'A throwaway project for the c3 intent e2e.', ''].join('\n'),
)

const REQ_TITLE = 'E2E 落库验证'
const PROMPT =
  `你是New Intent助手。请不要阅读任何文件、也不要向我提问。` +
  `直接调用 save_intents 工具,只提交一条意图:` +
  `title="${REQ_TITLE}",content="验证 c3 意图落库端到端流程",priority="P2"。` +
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
let workspaceId = null // server-assigned opaque id, captured from `workspaces`
let workspaceAdded = false
let chatOpened = false
let promptSent = false
let commSessionId = null

let sawCommSession = false // session_selected for the comm session (title New Intent)
let sawInitialList = false // first `intents` reply (the list on entry)
let sawSavePermission = false // permission_request for save_intents
let proposedValid = false // the proposed payload looked well-formed
let savedReqId = null // id of the persisted intent (from the broadcast)
let sawSaveResult = false // tool_result for the save call (not an error)
// Track whether we've sent the first (todo→in_progress) status update.
let pendingInProgress = false
let statusUpdated = false // the saved row flipped to `done` via update_intent_status
let statusUpdateSent = false

// ---- AskUserQuestion turn (second turn) ----
let askPromptSent = false // the AskUserQuestion prompt has been sent
let sawAskPermission = false // permission_request for AskUserQuestion (gate ROUTED it, didn't deny)
let askAnswered = false // we submitted answers to the panel
let askAnswerInjected = false // the agent echoed ASK_CHOICE back (withAnswers worked)
let sawAskTurnEnd = false // the AskUserQuestion turn completed

// ---- new_intent_chat ("+" → brand-new comm session) ----
let newChatSent = false // we sent new_intent_chat
let sawNewChat = false // got a fresh session_selected with a different id + empty history

// ---- Intent session list operations (list/switch/delete) ----
let sessionListRequested = false // we sent list_intent_sessions
let sawSessionList = false // received intent_sessions with items
let sessionIds = [] // cached session ids from the list
let switchRequested = false // we sent open_intent_chat with a specific sessionId
let sessionSwitched = false // received session_selected for the switched session
let deleteRequested = false // we sent delete_intent_session
let sessionDeleted = false // confirmed session removed from the list

let saveTurnReason = '' // turn_end reason of the first (save) turn
let askTurnReason = '' // turn_end reason of the second (AskUserQuestion) turn
let saveTurnEnded = false // first (save) turn_end seen
let commIdle = false // comm session is idle per session_status (run teardown complete)
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
        const added =
          msg.workspaces?.find((w) => w.name === PROJECT_DIR.split('/').pop()) ??
          msg.workspaces?.[0]
        workspaceId = added?.id ?? null
        if (!workspaceId) {
          console.error('[e2e] no workspaceId after add_workspace — aborting')
          finish(5)
          return
        }
        chatOpened = true
        console.log('[e2e] entering intent view (open_intent_chat)')
        send({ type: 'open_intent_chat', workspaceId })
      }
      break

    case 'session_selected':
      if (switchRequested) {
        // Response to open_intent_chat with a specific sessionId: verify it's the
        // targeted session.
        const expected = sessionIds[1] // the second session in the list
        sessionSwitched = msg.sessionId === expected
        console.log(
          `[e2e] ${sessionSwitched ? '✅' : '⚠️'} session switch → ${msg.sessionId} ` +
            `(expected ${expected})`,
        )
        // After switching, test delete: remove the first (old) session.
        if (sessionIds.length >= 2) {
          deleteRequested = true
          console.log(`[e2e] delete_intent_session ${sessionIds[0]}`)
          send({
            type: 'delete_intent_session',
            workspaceId,
            sessionId: sessionIds[0],
          })
        } else {
          finish(judge())
        }
        break
      }
      if (newChatSent) {
        // Response to new_intent_chat: must be a DIFFERENT session id with an
        // empty history (the old conversation must not bleed into the new one).
        const fresh = msg.sessionId !== commSessionId && (msg.history?.length ?? 0) === 0
        sawNewChat = fresh
        console.log(
          `[e2e] ${fresh ? '✅' : '⚠️'} new_intent_chat → session ${msg.sessionId} ` +
            `(prev ${commSessionId}, history=${msg.history?.length ?? 0})`,
        )
        // Don't finish yet — proceed to session list operations.
        maybeStartSessionListTest()
        break
      }
      // The comm session for the intent view (read-only, title New Intent).
      sawCommSession = true
      commSessionId = msg.sessionId
      console.log(`[e2e] comm session ${commSessionId} (title="${msg.title}")`)
      break

    case 'session_started':
      // First turn rebinds the pending comm id to the real SDK id; track the real
      // one so our session_status matching below keys off the right session.
      if (commSessionId === msg.clientId) {
        commSessionId = msg.sessionId
        console.log(`[e2e] comm session rekeyed → ${commSessionId}`)
        // Echo rebind_view so the server updates conn.viewing (ADR-0018).
        // Without this, the next user_prompt finds no runtime and is
        // rejected with session.notSelected.
        send({ type: 'rebind_view', from: msg.clientId, to: msg.sessionId })
      }
      break

    case 'session_status': {
      const mine = msg.statuses?.find((s) => s.sessionId === commSessionId)
      if (!mine) break
      if (mine.status === 'idle') {
        commIdle = true
        // Mirror the real client (App.vue flushIfReady): only drive the next turn
        // once the session is idle, i.e. the prior run's teardown has completed.
        // Firing earlier (e.g. off the status-update broadcast) races the save
        // turn's SDK winddown and is rejected with `session.turnRunning`.
        if (saveTurnEnded) maybeStartAskTurn()
      } else {
        commIdle = false
      }
      break
    }

    case 'intents': {
      const count = msg.items.length
      if (!sawInitialList) {
        sawInitialList = true
        console.log(`[e2e] initial intent list: ${count} item(s)`)
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
          `[e2e] ✅ intent persisted: id=${mine.id} status=${mine.status} priority=${mine.priority}`,
        )
      }
      // First status update: todo → in_progress. On broadcast, drive the second
      // step in_progress → done (which is a valid transition).
      if (mine && mine.status === 'in_progress' && pendingInProgress) {
        pendingInProgress = false
        console.log(`[e2e] ✅ status updated → in_progress, now driving → done`)
        send({ type: 'update_intent_status', intentId: mine.id, status: 'done' })
      }
      if (mine && mine.status === 'done') {
        statusUpdated = true
        console.log('[e2e] ✅ status updated → done')
        maybeStartAskTurn() // save flow done → exercise the AskUserQuestion path
      }
      break
    }

    case 'intent_sessions': {
      // Track the session list for list/switch/delete tests.
      const count = msg.items.length
      if (!sessionListRequested) break // ignore unsolicited broadcasts before our request

      if (!sawSessionList) {
        sawSessionList = true
        sessionIds = msg.items.map((s) => s.sessionId)
        console.log(`[e2e] ✅ intent_sessions: ${count} item(s)`)
        // Proceed to switch test: open a different session (the second one, if available).
        if (sessionIds.length >= 2) {
          switchRequested = true
          console.log(`[e2e] open_intent_chat → session ${sessionIds[1]}`)
          send({ type: 'open_intent_chat', workspaceId, sessionId: sessionIds[1] })
        } else {
          finish(judge())
        }
        break
      }

      // Second intent_sensors arrival: after delete, verify the count decreased.
      if (deleteRequested) {
        const expectedCount = sessionIds.length - 1
        sessionDeleted = count < sessionIds.length
        console.log(
          `[e2e] ${sessionDeleted ? '✅' : '⚠️'} delete_intent_session → ` +
            `count ${count} (expected ~${expectedCount})`,
        )
        finish(judge())
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
      if (SAVE_TOOLS.has(msg.toolName)) {
        sawSavePermission = true
        const viaAlias = msg.toolName === SAVE_TOOL_DEPRECATED
        const reqs = msg.input && Array.isArray(msg.input.intents) ? msg.input.intents : []
        proposedValid =
          reqs.length >= 1 && reqs.every((r) => r && r.title && r.content && r.priority)
        console.log(
          `[e2e] ✅ ${msg.toolName} gated${viaAlias ? ' (deprecated alias 兜住)' : ''}: ` +
            `${reqs.length} proposed (valid=${proposedValid}) → allow`,
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
        // The read-only gate should only ever prompt for save_intents or
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
        // (new_intent_chat) before judging.
        sawAskTurnEnd = true
        askTurnReason = reason
        maybeStartNewChat()
        break
      }
      // First (save) turn finished. Drive the status machine; the AskUserQuestion
      // turn fires from the session_status idle handler once teardown completes
      // (bounded fallback below covers a slow/missing idle broadcast).
      saveTurnReason = reason
      saveTurnEnded = true
      if (savedReqId && !statusUpdateSent) {
        statusUpdateSent = true
        // Intent is `todo` after save. Valid transitions are:
        //   todo → { in_progress, cancelled, blocked }
        // Must go through in_progress before reaching done.
        pendingInProgress = true
        console.log(`[e2e] update_intent_status ${savedReqId} → in_progress`)
        send({ type: 'update_intent_status', intentId: savedReqId, status: 'in_progress' })
        setTimeout(maybeStartAskTurn, 8000)
      } else {
        maybeStartAskTurn()
      }
      break
    }

    case 'error':
      // Protocol error shape is { type:'error', error:{ code, params } } — there is
      // no `message` field, so log the structured error (code + params).
      console.error(`[e2e] error: ${JSON.stringify(msg.error ?? msg)}`)
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
  // Wait for the comm session to be idle (prior run torn down) before driving the
  // next turn — otherwise the server rejects it with `session.turnRunning`. The
  // session_status idle handler re-invokes us once teardown completes.
  if (!commIdle) return
  askPromptSent = true
  console.log('[e2e] sending AskUserQuestion prompt to comm agent')
  send({ type: 'user_prompt', text: ASK_PROMPT })
}

// After new chat is confirmed, test the session list operations: list, switch, delete.
function maybeStartSessionListTest() {
  if (sessionListRequested || finished) return
  sessionListRequested = true
  console.log('[e2e] sending list_intent_sessions')
  send({ type: 'list_intent_sessions', workspaceId })
}

// Final flow: open a brand-new comm session via "+". The response is handled in
// the `session_selected` case, which verifies a fresh id + empty history then judges.
function maybeStartNewChat() {
  if (newChatSent || finished) return
  newChatSent = true
  console.log('[e2e] sending new_intent_chat (the "+" button)')
  send({ type: 'new_intent_chat', workspaceId })
}

function judge() {
  console.log('\n========== INTENT E2E REPORT ==========')
  console.log(`events: ${JSON.stringify(events)}`)
  const checks = {
    comm_session_opened: sawCommSession,
    intent_list_returned: sawInitialList,
    save_gated: sawSavePermission,
    proposed_payload_valid: proposedValid,
    intent_persisted: !!savedReqId,
    save_tool_result_ok: sawSaveResult,
    status_update_broadcast: statusUpdated,
    save_turn_completed_clean: saveTurnReason.startsWith('complete'),
    // AskUserQuestion runtime path (003 follow-up): routed to the panel (not
    // denied) and the injected answer made it back to the model.
    ask_gated: sawAskPermission,
    ask_answer_injected: askAnswerInjected,
    ask_turn_completed_clean: sawAskTurnEnd && askTurnReason.startsWith('complete'),
    // "+" → new_intent_chat: fresh session id, empty history (old chat not threaded in).
    new_chat_fresh_session: sawNewChat,
    // Session list: list_intent_sessions returns items.
    session_list_returned: sawSessionList,
    // Session switch: open a different session via open_intent_chat with sessionId.
    session_switched: sessionSwitched,
    // Session delete: delete_intent_session removes from the list.
    session_deleted: sessionDeleted,
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
