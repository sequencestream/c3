#!/usr/bin/env node
/**
 * Cursor agent 配置端到端验证 —— 走真实 WS 协议,复核「从设置面板建 Cursor agent
 * 并把它设为默认 agent 后能真正跑起来」这条链路。
 *
 * 覆盖的验收点:
 *   - `settings` 回包携带覆盖全部 vendor 的运行时可用性(vendorRuntime);cursor 以
 *     进程内 SDK 作答,不出现在 hostStatus(它没有宿主 CLI)。
 *   - 设置面板保存的 Cursor agent 形态原样落盘并回传:configMode 恒为 `system`、
 *     config 仅 `{apiKey, model}`、任何路径都不产生 `baseUrl`;非空 apiKey 在
 *     settings.json 里是密文,回包里是明文(SEC-13 磁盘边界)。
 *   - 该 Cursor agent 可被设为**系统默认 agent**,并以默认身份启动会话。
 *
 * 本脚本没有 SKIP 分支 —— 三种环境各自有确定的断言:
 *   A. `@cursor/sdk` 解析不到 ⇒ 断言 cursor 报不可用且原因码为 `sdk-unresolved`
 *      (显式降级,而非静默失败),配置形态断言照常执行。
 *   B. SDK 可用但没有 CURSOR_API_KEY ⇒ 启动必须以可行动错误失败,且错误同时点名
 *      agent 的 apiKey 字段与 CURSOR_API_KEY 环境变量。
 *   C. SDK 可用且有 key ⇒ 以默认 agent 起一轮真实短对话并完成(花费少量真实额度)。
 *
 * 用法:
 *   node scripts/e2e/e2e-cursor-agent-config-test.mjs [ws-url]
 */
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const URL = process.argv[2] || 'ws://localhost:13000/ws'
const TIMEOUT_MS = 300_000

const log = (s) => console.log(`[cursor-config-e2e] ${s}`)

// Resolve from the SERVER package, not from this script: `@cursor/sdk` is a
// server dependency, so a probe rooted at the repo root would answer "missing"
// on a perfectly healthy install and make this test lie about the contract.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
function sdkAvailable() {
  try {
    createRequire(join(REPO_ROOT, 'server', 'package.json')).resolve('@cursor/sdk')
    return true
  } catch {
    return false
  }
}
const SDK_OK = sdkAvailable()
const API_KEY = (process.env.CURSOR_API_KEY ?? '').trim()

const PROJECT_DIR = mkdtempSync(join(tmpdir(), 'c3-cursor-config-e2e-'))
writeFileSync(join(PROJECT_DIR, 'README.md'), '# c3 cursor agent config e2e\n')

const CURSOR_AGENT_ID = 'cursor-config-e2e-agent'
// 一轮零工具的短对话,把花费压到最低。
const PROMPT = 'Reply with exactly: CURSOR-CONFIG-E2E-OK'

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
  if (runtime.cursor.runtime !== 'embedded-sdk') {
    return `cursor 应以进程内 SDK 作答,实际 runtime=${runtime.cursor.runtime}`
  }
  if (runtime.claude.runtime !== 'host-cli' || runtime.codex.runtime !== 'host-cli') {
    return 'claude/codex 应保持宿主 CLI 语义'
  }
  // hostStatus 只讲宿主 CLI,不得把进程内 SDK 伪装成 CLI。
  if ((msg.hostStatus ?? []).some((h) => h.vendor === 'cursor')) {
    return 'cursor 不应出现在 hostStatus 里'
  }
  // 设置页所报状态必须与 adapter 能否构造同源:两者用同一个「SDK 能否解析」探针。
  if (runtime.cursor.available !== SDK_OK) {
    return `cursor 可用性(${runtime.cursor.available})与 server 包内的 SDK 解析结果(${SDK_OK})不一致`
  }
  if (!SDK_OK && runtime.cursor.reason !== 'sdk-unresolved') {
    return `SDK 不可解析时原因码应为 sdk-unresolved,实际 ${runtime.cursor.reason}`
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
        if (!SDK_OK) {
          return pass('SDK 不可解析:cursor 显式报不可用(sdk-unresolved),配置仍可保存与查看')
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
        if (msg.reason !== 'error') return fail('缺少 API key 时本轮不应成功')
        if (!/apiKey/.test(error) || !/CURSOR_API_KEY/.test(error)) {
          return fail(`缺少 key 的报错不可行动(未同时点名两处配置):${error}`)
        }
        return pass('缺少 key 时以可行动错误失败,同时指出 agent 字段与 CURSOR_API_KEY')
      }
      if (msg.reason !== 'complete') return fail(`本轮 reason=${msg.reason} error=${error}`)
      if (!sawText) return fail('本轮没有 assistant_text')
      return pass('以 Cursor 默认 agent 启动会话并完成一轮')
    }
  }
})

ws.addEventListener('open', () => log(`连接 ${URL}`))
ws.addEventListener('error', () => fail('WebSocket 连接错误'))
