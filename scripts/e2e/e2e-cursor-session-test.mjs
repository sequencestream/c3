#!/usr/bin/env node
/**
 * Cursor 会话端到端验证 — 走真实 WS 协议与真实 `cursor-agent` CLI(花费少量
 * 真实额度,两轮短对话)。复核 c3 服务端的 Cursor 接线:新建 Cursor 会话 → 第一轮
 * 产出 text 与 tool_use → 会话进入列表 → 以捕获的原生 agent id 续聊第二轮。
 *
 * 覆盖的验收点:
 *   - UI(协议层)新建 Cursor 会话并完成一轮执行,展示 text 与 tool_use。
 *   - 会话出现在列表中。
 *   - 使用 Cursor 原生 session id 成功续聊第二轮。
 *
 * 前置(不满足即 SKIP,退出码 5):环境变量 CURSOR_API_KEY 已设置,且 `cursor-agent`
 * 可解析。SDK 只认 API Key —— `cursor-agent login` 的钥匙串登录态对它无效。
 * 非 CI 安全 —— 需要真实密钥与出网。
 *
 * 用法:
 *   node scripts/e2e/e2e-cursor-session-test.mjs [ws-url]
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertIsolatedSettings } from './settings-guard.mjs'

const URL = process.argv[2] || 'ws://localhost:13000/ws'
const TIMEOUT_MS = 300_000

const log = (s) => console.log(`[cursor-e2e] ${s}`)

function skip(reason) {
  log(`SKIP: ${reason}`)
  process.exit(5)
}

// ─── 前置检查:CLI 可解析,且已登录或有 API Key ──────────────────────────────
function cliAvailable() {
  const override = (process.env.CURSOR_PATH ?? '').trim()
  if (override) return existsSync(override)
  const r = spawnSync('sh', ['-c', 'command -v cursor-agent'], { encoding: 'utf-8' })
  return r.status === 0 && (r.stdout || '').trim().length > 0
}
function loggedIn() {
  const r = spawnSync('cursor-agent', ['status'], { encoding: 'utf-8' })
  return r.status === 0 && !/not logged in|logged out/i.test(`${r.stdout}${r.stderr}`)
}
const API_KEY = (process.env.CURSOR_API_KEY ?? '').trim()
if (!cliAvailable()) skip('宿主上找不到 cursor-agent(未安装,或 $CURSOR_PATH 指向不存在的路径)')
if (!API_KEY && !loggedIn()) skip('既没有 CURSOR_API_KEY,cursor-agent 也未登录')

// ─── 工作区 ────────────────────────────────────────────────────────────────────
const PROJECT_DIR = mkdtempSync(join(tmpdir(), 'c3-cursor-e2e-'))
writeFileSync(join(PROJECT_DIR, 'README.md'), '# c3 cursor e2e\n')

const CURSOR_AGENT_ID = 'cursor-e2e-agent'
const PROMPT_1 =
  'Use a tool to list the files in the current directory, then reply with exactly: CURSOR-E2E-ONE'
const PROMPT_2 =
  'What exact reply phrase did I ask you to end your previous message with in this conversation? Reply with only that phrase.'

// Injects a cursor agent into the running server's settings — refuse before the
// first byte if that server reads the real ~/.c3/settings.json. This one only
// ever runs by hand (it is not in the `pnpm e2e` suite), which is exactly the
// case the guard exists for.
await assertIsolatedSettings(URL, { testScript: 'scripts/e2e/e2e-cursor-session-test.mjs' })

/** @type {WebSocket} */
const ws = new WebSocket(URL)

let originalSettings = null
let workspaceId = null
let pendingSessionId = null
let boundSessionId = null
let phase = 'init'
// Turn 1 observations.
let t1Text = false
let t1ToolUse = false
let listedSession = false

const timeout = setTimeout(() => {
  console.error('[cursor-e2e] TIMEOUT')
  finish(2)
}, TIMEOUT_MS)

function send(obj) {
  ws.send(JSON.stringify(obj))
}

function finish(code) {
  clearTimeout(timeout)
  try {
    // 尽力还原设置(不阻塞退出码)。
    if (originalSettings && ws.readyState === WebSocket.OPEN) {
      send({ type: 'save_settings', settings: originalSettings })
    }
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(code), 300)
}

function pass(msg) {
  log(`RESULT: PASS — ${msg}`)
  finish(0)
}
function fail(msg) {
  log(`RESULT: FAIL — ${msg}`)
  finish(1)
}

ws.addEventListener('message', (evt) => {
  let msg
  try {
    msg = JSON.parse(typeof evt.data === 'string' ? evt.data : String(evt.data))
  } catch {
    return
  }

  switch (msg.type) {
    case 'ready':
      // 取当前设置快照,随后注入一个 system 模式 Cursor agent。
      send({ type: 'get_settings' })
      break

    case 'settings':
      if (phase !== 'init') return
      phase = 'seed-agent'
      originalSettings = msg.settings
      {
        const agents = [...(msg.settings.agents ?? [])]
        if (!agents.some((a) => a.id === CURSOR_AGENT_ID)) {
          agents.push({
            id: CURSOR_AGENT_ID,
            vendor: 'cursor',
            configMode: 'system',
            displayName: 'Cursor E2E',
            enabled: true,
            // SDK 只认 API Key;留空则回落到服务端环境里的 CURSOR_API_KEY。
            config: { apiKey: API_KEY, model: '' },
          })
        }
        send({ type: 'save_settings', settings: { ...msg.settings, agents } })
        log('注入 Cursor agent,添加工作区')
        send({ type: 'add_workspace', path: PROJECT_DIR })
      }
      break

    case 'workspaces':
      if (workspaceId) return
      workspaceId =
        msg.workspaces?.find((w) => w.name === PROJECT_DIR.split('/').pop())?.id ??
        msg.workspaces?.[0]?.id ??
        null
      if (!workspaceId) return fail('add_workspace 后没有工作区')
      phase = 'turn1'
      log('创建 Cursor 会话')
      send({ type: 'create_session', workspaceId, agentId: CURSOR_AGENT_ID })
      break

    case 'session_selected':
      if (phase === 'turn1' && !pendingSessionId) {
        pendingSessionId = msg.sessionId
        log(`会话已创建(${pendingSessionId}),发起第一轮`)
        // Pin full-access so tools auto-run: the SDK has no approval channel, and an
        // unlisted tool would otherwise block the turn waiting for one.
        send({ type: 'set_mode', mode: 'full-access' })
        send({ type: 'user_prompt', text: PROMPT_1 })
      } else if (phase === 'selecting') {
        phase = 'turn2'
        log('续聊会话已选中,发起第二轮')
        send({ type: 'set_mode', mode: 'full-access' })
        send({ type: 'user_prompt', text: PROMPT_2 })
      }
      break

    case 'session_started':
      // 首轮把 pending 会话绑定到真实原生 id —— 续聊要用它。
      if (msg.sessionId) boundSessionId = msg.sessionId
      break

    case 'assistant_text':
      if (phase === 'turn1') t1Text = true
      break

    case 'tool_use':
      if (phase === 'turn1') t1ToolUse = true
      break

    case 'turn_end':
      if (phase === 'turn1') {
        if (msg.reason !== 'complete') return fail(`第一轮 reason=${msg.reason}`)
        if (!t1Text) return fail('第一轮没有 assistant_text')
        if (!t1ToolUse) return fail('第一轮没有 tool_use')
        if (!boundSessionId) return fail('第一轮未捕获原生 session id')
        log(`第一轮完成(text+tool_use),原生 id=${boundSessionId};检查会话列表`)
        phase = 'list'
        send({ type: 'list_sessions', workspaceId, limit: 50 })
      } else if (phase === 'turn2') {
        if (msg.reason !== 'complete') return fail(`第二轮 reason=${msg.reason}`)
        pass('第一轮 text+tool_use、会话入列、原生 id 续聊第二轮均成功')
      }
      break

    case 'sessions':
      if (phase !== 'list') return
      listedSession = (msg.sessions ?? []).some(
        (s) => s.sessionId === boundSessionId || s.sessionId === pendingSessionId,
      )
      if (!listedSession) return fail('绑定后的会话未出现在会话列表中')
      log('会话已在列表中,选择它以续聊')
      phase = 'selecting'
      send({ type: 'select_session', workspaceId, sessionId: boundSessionId })
      break
  }
})

ws.addEventListener('open', () => log(`连接 ${URL}`))
ws.addEventListener('error', () => fail('WebSocket 连接错误'))
