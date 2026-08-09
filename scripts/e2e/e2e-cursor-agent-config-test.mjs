#!/usr/bin/env node
/**
 * Cursor agent 配置端到端验证 —— 走真实 WS 协议,复核「从设置面板建 Cursor agent
 * 并把它设为默认 agent 后能真正跑起来」这条链路。
 *
 * 覆盖的验收点:
 *   - `settings` 回包携带覆盖全部 vendor 的运行时可用性(vendorRuntime);每个 vendor
 *     都以宿主 CLI 作答,并出现在 hostStatus 里。
 *   - 设置面板保存的 Cursor agent 形态原样落盘并回传:configMode 恒为 `system`、
 *     config 仅 `{apiKey, model}`、任何路径都不产生 `baseUrl`;非空 apiKey 在
 *     settings.json 里是密文,回包里是明文(SEC-13 磁盘边界)。
 *   - 该 Cursor agent 可被设为**系统默认 agent**,并以默认身份启动会话。
 *
 * 本脚本没有 SKIP 分支 —— 三种环境各自有确定的断言:
 *   A. `cursor-agent` 找不到 ⇒ 断言 cursor 报不可用且原因码为 `host-cli-missing`
 *      (显式降级,而非静默失败),配置形态断言照常执行。
 *   B. CLI 可用但没有 CURSOR_API_KEY ⇒ key 是可选的,故两种结局都合法:凭
 *      `cursor-agent login` 的登录态跑完,或以点名两条出路的可行动错误失败。
 *   C. CLI 可用且有 key ⇒ 以默认 agent 起一轮真实短对话并完成(花费少量真实额度)。
 *
 * 用法:
 *   node scripts/e2e/e2e-cursor-agent-config-test.mjs [ws-url]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertIsolatedSettings } from './settings-guard.mjs'

const URL = process.argv[2] || 'ws://localhost:13000/ws'
const TIMEOUT_MS = 300_000

const log = (s) => console.log(`[cursor-config-e2e] ${s}`)

// cursor-agent 由 Cursor 自己的安装器分发,c3 不托管它:探测就是「宿主上找不找得到」,
// 与服务端 launcher 的解析顺序一致($CURSOR_PATH → PATH)。
function cliAvailable() {
  const override = (process.env.CURSOR_PATH ?? '').trim()
  if (override) return existsSync(override)
  const r = spawnSync('sh', ['-c', 'command -v cursor-agent'], { encoding: 'utf-8' })
  return r.status === 0 && (r.stdout || '').trim().length > 0
}
const CLI_OK = cliAvailable()
const API_KEY = (process.env.CURSOR_API_KEY ?? '').trim()

const PROJECT_DIR = mkdtempSync(join(tmpdir(), 'c3-cursor-config-e2e-'))
writeFileSync(join(PROJECT_DIR, 'README.md'), '# c3 cursor agent config e2e\n')

const CURSOR_AGENT_ID = 'cursor-config-e2e-agent'
// 一轮零工具的短对话,把花费压到最低。
const PROMPT = 'Reply with exactly: CURSOR-CONFIG-E2E-OK'

// Creates a cursor agent and makes it the system default — refuse before the
// first byte if the server reads the real ~/.c3/settings.json.
await assertIsolatedSettings(URL, { testScript: 'scripts/e2e/e2e-cursor-agent-config-test.mjs' })

/** @type {WebSocket} */
const ws = new WebSocket(URL)

let originalSettings = null
let workspaceId = null
let phase = 'init'
let sawText = false

const timeout = setTimeout(() => {
  console.error('[cursor-config-e2e] TIMEOUT')
  finish(2)
}, TIMEOUT_MS)

const send = (obj) => ws.send(JSON.stringify(obj))

function finish(code) {
  clearTimeout(timeout)
  try {
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

/** `settings` 回包里 vendor 中立可用性契约的断言。返回错误串,通过则返回 null。 */
function checkVendorRuntime(msg) {
  const runtime = msg.vendorRuntime
  if (!runtime) return 'settings 回包缺少 vendorRuntime'
  for (const vendor of ['claude', 'codex', 'cursor']) {
    const entry = runtime[vendor]
    if (!entry) return `vendorRuntime 缺少 ${vendor}`
    if (entry.vendor !== vendor) return `vendorRuntime.${vendor}.vendor 自述不一致`
    if (typeof entry.available !== 'boolean') return `vendorRuntime.${vendor}.available 非布尔`
  }
  for (const vendor of ['claude', 'codex', 'cursor']) {
    if (runtime[vendor].runtime !== 'host-cli') {
      return `${vendor} 应以宿主 CLI 作答,实际 runtime=${runtime[vendor].runtime}`
    }
  }
  // 每个被 c3 启动的 vendor 都要出现在 hostStatus 里,cursor 也不例外。
  const hostVendors = (msg.hostStatus ?? []).map((h) => h.vendor)
  if (!hostVendors.includes('cursor')) {
    return `cursor 应出现在 hostStatus 里,实际只有 ${hostVendors.join(',') || '(空)'}`
  }
  // 设置页所报状态必须与 adapter 能否构造同源:两者用同一条 CLI 解析链。
  if (runtime.cursor.available !== CLI_OK) {
    return `cursor 可用性(${runtime.cursor.available})与宿主 CLI 探测结果(${CLI_OK})不一致`
  }
  if (!CLI_OK && runtime.cursor.reason !== 'host-cli-missing') {
    return `CLI 找不到时原因码应为 host-cli-missing,实际 ${runtime.cursor.reason}`
  }
  return null
}

/** 保存回包里 Cursor agent 形态的断言。返回错误串,通过则返回 null。 */
function checkCursorAgent(settings) {
  const agent = (settings.agents ?? []).find((a) => a.id === CURSOR_AGENT_ID)
  if (!agent) return '保存后回包里没有该 Cursor agent'
  if (agent.vendor !== 'cursor') return `vendor 应为 cursor,实际 ${agent.vendor}`
  if (agent.configMode !== 'system') return `configMode 应恒为 system,实际 ${agent.configMode}`
  const keys = Object.keys(agent.config ?? {}).sort()
  if (keys.join(',') !== 'apiKey,model') return `config 键应为 {apiKey, model},实际 ${keys}`
  if ('baseUrl' in (agent.config ?? {})) return 'cursor agent 不应带 baseUrl'
  // 线上/内存里是明文 —— 密文只存在于磁盘(SEC-13)。
  if (API_KEY && agent.config.apiKey !== API_KEY) return '回包里的 apiKey 应为明文,可继续编辑'
  if (settings.defaultAgentId !== CURSOR_AGENT_ID) return '该 agent 未成为系统默认 agent'
  return null
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
      send({ type: 'get_settings' })
      break

    case 'settings': {
      if (phase === 'init') {
        const err = checkVendorRuntime(msg)
        if (err) return fail(err)
        log(`vendorRuntime 契约通过(cursor available=${msg.vendorRuntime.cursor.available})`)
        originalSettings = msg.settings
        phase = 'saving'
        const agents = (msg.settings.agents ?? []).filter((a) => a.id !== CURSOR_AGENT_ID)
        agents.push({
          id: CURSOR_AGENT_ID,
          vendor: 'cursor',
          configMode: 'system',
          displayName: 'Cursor Config E2E',
          enabled: true,
          // 空 key 时运行期回落到服务端环境的 CURSOR_API_KEY。
          config: { apiKey: API_KEY, model: '' },
        })
        send({
          type: 'save_settings',
          settings: { ...msg.settings, agents, defaultAgentId: CURSOR_AGENT_ID },
        })
        return
      }
      if (phase !== 'saving') return
      {
        const err = checkCursorAgent(msg.settings)
        if (err) return fail(err)
        log('Cursor agent 形态与默认 agent 设置均正确')
        if (!CLI_OK) {
          return pass('CLI 找不到:cursor 显式报不可用(host-cli-missing),配置仍可保存与查看')
        }
        phase = 'workspace'
        send({ type: 'add_workspace', path: PROJECT_DIR })
      }
      break
    }

    case 'workspaces':
      if (phase !== 'workspace') return
      workspaceId =
        msg.workspaces?.find((w) => w.name === PROJECT_DIR.split('/').pop())?.id ??
        msg.workspaces?.[0]?.id ??
        null
      if (!workspaceId) return fail('add_workspace 后没有工作区')
      phase = 'turn'
      // 不指定 agentId —— 走系统默认 agent,即刚建的 Cursor agent。
      log('以默认 agent(Cursor)创建会话')
      send({ type: 'create_session', workspaceId })
      break

    case 'session_selected':
      if (phase !== 'turn') return
      send({ type: 'set_mode', mode: 'full-access' })
      send({ type: 'user_prompt', text: PROMPT })
      break

    case 'assistant_text':
      if (phase === 'turn') sawText = true
      break

    case 'turn_end': {
      if (phase !== 'turn') return
      const error = String(msg.error ?? '')
      if (!API_KEY) {
        // key 是可选的:装了 CLI 又 `cursor-agent login` 过就该正常跑完。两种结局
        // 都合法,但失败必须可行动 —— 指出登录与填 key 这两条出路。
        if (msg.reason === 'complete') {
          if (!sawText) return fail('本轮没有 assistant_text')
          return pass('无 API key 时凭 cursor-agent 登录态完成一轮')
        }
        if (!/cursor-agent login/.test(error) && !/API key/i.test(error)) {
          return fail(`未登录且无 key 的报错不可行动(未指出任何一条出路):${error}`)
        }
        return pass('无 key 且未登录时以可行动错误失败,点名登录与 API key 两条出路')
      }
      if (msg.reason !== 'complete') return fail(`本轮 reason=${msg.reason} error=${error}`)
      if (!sawText) return fail('本轮没有 assistant_text')
      return pass('以 Cursor 默认 agent 启动会话并完成一轮')
    }
  }
})

ws.addEventListener('open', () => log(`连接 ${URL}`))
ws.addEventListener('error', () => fail('WebSocket 连接错误'))
