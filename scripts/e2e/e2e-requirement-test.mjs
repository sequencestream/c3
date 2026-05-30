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
 * What this verifies (maps to the requirement spec):
 * - US-1/US-2: entering the view returns a `session_selected` comm session
 *   (title 需求沟通) plus the project's `requirements` list.
 * - US-3/US-4: the agent's `save_requirements` call is gated (human confirm),
 *   and only persists after `allow` — landing as a `todo` row, broadcast live.
 * - status machine: `update_requirement_status` moves the row and re-broadcasts.
 *
 * Unlike the consensus tests this needs no extra agents — only the default agent
 * runs. It spends real tokens (one short comm turn) and needs the requirement db
 * (`c3.db`) available; the runner points `C3_DB_PATH` at a throwaway file.
 *
 * Usage:
 *   pnpm start --project /tmp --port 13000     # in another terminal
 *   node scripts/e2e/e2e-requirement-test.mjs [ws-url]
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'

const URL = process.argv[2] || 'ws://localhost:13000/ws'
const TIMEOUT_MS = 180_000

const SAVE_TOOL = 'mcp__c3__save_requirements'

// ---- Seed a throwaway project under /tmp (gives the read-only agent material) ----
const PROJECT_DIR = mkdtempSync('/tmp/c3-requirement-')
writeFileSync(
  `${PROJECT_DIR}/README.md`,
  ['# Demo project', '', 'A throwaway project for the c3 requirement e2e.', ''].join('\n'),
)

const REQ_TITLE = 'E2E 落库验证'
const PROMPT =
  `你是需求沟通助手。请不要阅读任何文件、也不要向我提问。` +
  `直接调用 save_requirements 工具,只提交一条需求:` +
  `title="${REQ_TITLE}",content="验证 c3 需求落库端到端流程",priority="P2"。` +
  `提交后用一句话告诉我已提交。`

console.log(`[e2e] project: ${PROJECT_DIR}`)
console.log(`[e2e] connecting ${URL}`)

/** @type {WebSocket} */
const ws = new WebSocket(URL)

// ---- State ----
let workspaceAdded = false
let chatOpened = false
let promptSent = false
let commSessionId = null

let sawCommSession = false // session_selected for the comm session (title 需求沟通)
let sawInitialList = false // first `requirements` reply (the list on entry)
let sawSavePermission = false // permission_request for save_requirements
let proposedValid = false // the proposed payload looked well-formed
let savedReqId = null // id of the persisted requirement (from the broadcast)
let sawSaveResult = false // tool_result for the save call (not an error)
let statusUpdated = false // the saved row flipped to `done` via update_requirement_status
let statusUpdateSent = false

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
      // The comm session for the requirement view (read-only, title 需求沟通).
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
        if (sawTurnEnd) finish(judge())
      }
      break
    }

    case 'assistant_text':
      console.log(
        `[e2e] assistant_text: ${msg.text.slice(0, 100)}${msg.text.length > 100 ? '…' : ''}`,
      )
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
      } else {
        // The read-only gate should only ever prompt for save_requirements.
        console.log(`[e2e] ⚠️ unexpected permission_request: ${msg.toolName} → deny`)
        send({ type: 'permission_response', requestId: msg.requestId, decision: 'deny' })
      }
      break

    case 'tool_result':
      if (!msg.isError) sawSaveResult = true
      console.log(`[e2e] tool_result (isError=${msg.isError})`)
      break

    case 'turn_end':
      sawTurnEnd = true
      turnReason = msg.reason + (msg.error ? `: ${msg.error}` : '')
      console.log(`[e2e] turn_end: ${turnReason}`)
      // Saved? Exercise the status machine, then judge once it broadcasts back.
      if (savedReqId && !statusUpdateSent) {
        statusUpdateSent = true
        console.log(`[e2e] update_requirement_status ${savedReqId} → done`)
        send({ type: 'update_requirement_status', requirementId: savedReqId, status: 'done' })
        setTimeout(() => finish(judge()), 4000) // bounded wait for the broadcast
      } else {
        finish(judge())
      }
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
    turn_completed_clean: sawTurnEnd && turnReason.startsWith('complete'),
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
