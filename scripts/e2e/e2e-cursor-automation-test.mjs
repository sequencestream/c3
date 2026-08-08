#!/usr/bin/env node
/**
 * Cursor 自动化执行端到端验证 —— 走真实 WS 协议,复核「一条 vendor 为 cursor 的
 * `llm` 自动化能被创建、被手动触发,并由 cursor 的 dispatcher 分支真正执行」。
 *
 * 覆盖的验收点:
 *   - cursor 可作为自动化执行器保存(共享 `AUTOMATION_VENDORS` 已含 cursor,
 *     服务端不再以 `automation_vendor_unsupported` 拒绝分派);
 *   - 一次成功的 `llm_prompt` 运行:执行日志落 `success`,带非空 output,并绑定
 *     一个可回放的 agent session id;
 *   - 分派期失败分支:运行时不可用(`cursor_sdk_unresolved`)、凭据缺失、
 *     绑定 agent 被禁用 / 已不存在。每一条都必须以可行动的错误结束,且
 *     **不跨 vendor 回退** —— 失败后 automation 自身的 vendor 仍是 cursor。
 *
 * 与 cursor agent 配置 e2e 同样**没有 SKIP 分支**,三种环境各有确定断言:
 *   A. `@cursor/sdk` 解析不到 ⇒ 首轮必须以 `cursor_sdk_unresolved` 失败;
 *   B. SDK 可用但没有 CURSOR_API_KEY ⇒ 首轮必须失败,且错误同时点名 agent 的
 *      apiKey 字段与 CURSOR_API_KEY 环境变量;
 *   C. SDK 可用且有 key ⇒ 首轮跑完一轮真实短对话(花费少量真实额度)。
 * agent 禁用 / 缺失两条失败分支在所有环境下都断言。
 *
 * 用法:
 *   pnpm build && node scripts/e2e/isolated-server.mjs --port 13000   # 另一个终端
 *   node scripts/e2e/e2e-cursor-automation-test.mjs [ws-url]
 */
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertIsolatedSettings } from './settings-guard.mjs'

const URL = process.argv[2] || 'ws://localhost:13000/ws'
const TIMEOUT_MS = 300_000
const POLL_MS = 1000

const log = (s) => console.log(`[cursor-automation-e2e] ${s}`)

// 从 SERVER 包解析:`@cursor/sdk` 是服务端依赖,从仓库根探测会在健康安装上误报缺失。
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

const CURSOR_AGENT_ID = 'cursor-automation-e2e-agent'
const AUTOMATION_NAME = 'cursor automation e2e'
// 一轮零工具的短对话,把花费压到最低。
const PROMPT = 'Reply with exactly: CURSOR-AUTOMATION-E2E-OK'

// ---- 一个一次性 git 工作区 ----
const PROJECT_DIR = mkdtempSync(join(tmpdir(), 'c3-cursor-automation-e2e-'))
writeFileSync(join(PROJECT_DIR, 'README.md'), '# c3 cursor automation e2e\n')
try {
  execFileSync('git', ['init', '-q'], { cwd: PROJECT_DIR })
} catch {
  /* git 不是硬性前提:自动化只需要一个可解析的工作区路径 */
}

// Rewrites the agent list (disable / remove) mid-run — refuse before the first
// byte if the server reads the real ~/.c3/settings.json.
await assertIsolatedSettings(URL, { testScript: 'scripts/e2e/e2e-cursor-automation-test.mjs' })

/** @type {WebSocket} */
const ws = new WebSocket(URL)

let originalSettings = null
let workspaceId = null
let automationId = null
let phase = 'init'
const failures = []
let finished = false
/** 每个消息类型的最近一次回包,供轮询读取。 */
const last = { settings: null, automations: null, detail: null }

const timeout = setTimeout(() => {
  failures.push(`TIMEOUT in phase "${phase}"`)
  finish()
}, TIMEOUT_MS)

const send = (obj) => ws.send(JSON.stringify(obj))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (ok, label) => {
  console.log(`[cursor-automation-e2e] ${ok ? 'ok  ' : 'FAIL'} — ${label}`)
  if (!ok) failures.push(label)
}

function finish() {
  if (finished) return
  finished = true
  clearTimeout(timeout)
  try {
    if (originalSettings && ws.readyState === WebSocket.OPEN) {
      send({ type: 'save_settings', settings: originalSettings })
    }
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    try {
      ws.close()
    } catch {
      /* already closed */
    }
    rmSync(PROJECT_DIR, { recursive: true, force: true })
    if (failures.length > 0) {
      console.error(`\n[cursor-automation-e2e] ${failures.length} 条断言失败:`)
      for (const f of failures) console.error(`  - ${f}`)
      console.error('RESULT: FAIL')
      process.exit(1)
    }
    console.log('\nRESULT: PASS')
    process.exit(0)
  }, 300)
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
    case 'settings':
      last.settings = msg
      if (phase === 'init') {
        phase = 'seed'
        originalSettings = msg.settings
        void runAssertions()
      }
      break
    case 'automations':
      last.automations = msg
      break
    case 'automation_detail':
      last.detail = msg
      break
    case 'workspaces':
      workspaceId =
        msg.workspaces?.find((w) => w.name === PROJECT_DIR.split('/').pop())?.id ??
        msg.workspaces?.[0]?.id ??
        workspaceId
      break
    case 'error':
      // 保存/创建阶段的服务端拒绝必须显式暴露,不能被轮询默默吞掉。
      failures.push(`server error in phase "${phase}": ${msg.error?.code ?? '?'}`)
      break
  }
})

/** 写一份带 cursor agent 的 settings(`enabled` 可控),并等待回包生效。 */
async function writeCursorAgent({ enabled = true, present = true } = {}) {
  const base = originalSettings
  const agents = (base.agents ?? []).filter((a) => a.id !== CURSOR_AGENT_ID)
  if (present) {
    agents.push({
      id: CURSOR_AGENT_ID,
      vendor: 'cursor',
      configMode: 'system',
      displayName: 'Cursor Automation E2E',
      enabled,
      // 空 key 时运行期回落到服务端环境的 CURSOR_API_KEY。
      config: { apiKey: API_KEY, model: '' },
    })
  }
  last.settings = null
  send({ type: 'save_settings', settings: { ...base, agents } })
  for (let i = 0; i < 20 && !last.settings; i++) await sleep(200)
  const stored = (last.settings?.settings?.agents ?? []).find((a) => a.id === CURSOR_AGENT_ID)
  return stored ?? null
}

/** 触发一次运行,轮询到最新执行日志落终态并返回它。 */
async function runOnceAndReadLog(label) {
  last.detail = null
  send({ type: 'automation_run_now', automationId })
  for (let i = 0; i < 240; i++) {
    send({ type: 'get_automation_detail', automationId })
    await sleep(POLL_MS)
    const logs = last.detail?.logs ?? []
    const latest = logs[0]
    if (latest && latest.status && latest.status !== 'running') return latest
  }
  failures.push(`${label}: 执行日志始终没有落终态`)
  return null
}

async function runAssertions() {
  // ── 准备:cursor agent + 工作区 + 一条 cursor 自动化 ────────────────────
  phase = 'seed-agent'
  const agent = await writeCursorAgent()
  if (!agent) {
    failures.push('cursor agent 未能保存')
    return finish()
  }
  check(agent.vendor === 'cursor', 'cursor agent 已保存')

  phase = 'seed-workspace'
  send({ type: 'add_workspace', path: PROJECT_DIR })
  for (let i = 0; i < 20 && !workspaceId; i++) await sleep(200)
  if (!workspaceId) {
    failures.push('add_workspace 后没有工作区')
    return finish()
  }

  phase = 'create-automation'
  last.automations = null
  send({
    type: 'create_automation',
    workspaceId,
    input: {
      type: 'llm',
      workspaceId,
      vendor: 'cursor',
      agentId: CURSOR_AGENT_ID,
      config: { prompt: PROMPT },
      triggerType: 'cron',
      // 一年触发一次,并以 paused 落库:本测试只走手动触发,不受调度打扰。
      cronExpression: '0 0 1 1 *',
      initialStatus: 'paused',
      initialName: AUTOMATION_NAME,
      mode: 'agent',
      toolAllowlist: [],
      toolDenylist: [],
      maxWallClockMs: 240_000,
    },
  })
  for (let i = 0; i < 40 && !automationId; i++) {
    await sleep(250)
    automationId =
      (last.automations?.items ?? []).find((s) => s.vendor === 'cursor' && s.type === 'llm')?.id ??
      null
    if (!automationId) send({ type: 'list_automations', workspaceId })
  }
  if (!automationId) {
    failures.push('cursor 自动化未能创建(服务端拒绝了 cursor 作为执行器?)')
    return finish()
  }
  check(true, 'vendor=cursor 的 LLM 自动化被接受并落库')

  // ── 主运行:按环境断言成功或分派期失败 ─────────────────────────────────
  phase = 'run-main'
  log(`触发运行(SDK 可解析=${SDK_OK}, 有 API key=${!!API_KEY})`)
  const main = await runOnceAndReadLog('主运行')
  if (main) {
    if (!SDK_OK) {
      check(main.status === 'failed', 'SDK 不可解析:执行失败而不是静默成功')
      check(
        main.error === 'cursor_sdk_unresolved',
        `失败原因可定位为 cursor_sdk_unresolved(实际 ${main.error})`,
      )
      check(main.sessionId === null, '分派期失败没有产生会话')
    } else if (!API_KEY) {
      check(main.status === 'failed', '缺少凭据:执行失败')
      const err = String(main.error ?? '')
      check(
        /apiKey/.test(err) && /CURSOR_API_KEY/.test(err),
        `缺少 key 的报错同时点名 agent 字段与环境变量(实际 ${err})`,
      )
    } else {
      check(main.status === 'success', `一次真实 cursor 自动化运行成功(实际 ${main.status})`)
      check(String(main.output ?? '').length > 0, '执行日志记录了模型输出')
      check(!!main.sessionId, '执行绑定了可回放的 agent session id')
    }
  }

  // ── 失败分支:绑定 agent 被禁用 ────────────────────────────────────────
  phase = 'run-agent-disabled'
  await writeCursorAgent({ enabled: false })
  const disabled = await runOnceAndReadLog('agent 禁用')
  if (disabled) {
    check(disabled.status === 'failed', '绑定 agent 被禁用:执行失败')
    check(
      disabled.error === 'automation_agent_disabled',
      `失败原因为 automation_agent_disabled(实际 ${disabled.error})`,
    )
  }

  // ── 失败分支:绑定 agent 已不存在 ──────────────────────────────────────
  phase = 'run-agent-missing'
  await writeCursorAgent({ present: false })
  const missing = await runOnceAndReadLog('agent 缺失')
  if (missing) {
    check(missing.status === 'failed', '绑定 agent 已删除:执行失败')
    check(
      missing.error === 'automation_agent_not_found',
      `失败原因为 automation_agent_not_found(实际 ${missing.error})`,
    )
  }

  // ── 失败不改写执行身份 ────────────────────────────────────────────────
  phase = 'no-vendor-fallback'
  send({ type: 'get_automation_detail', automationId })
  await sleep(POLL_MS)
  check(
    last.detail?.automation?.vendor === 'cursor',
    '多次失败后 automation 的 vendor 仍是 cursor —— 没有跨 vendor 回退',
  )
  check(
    last.detail?.automation?.agentId === CURSOR_AGENT_ID,
    '失败也不会替换掉记录指定的执行 agent',
  )

  phase = 'cleanup'
  send({ type: 'delete_automation', automationId })
  await sleep(500)
  finish()
}

ws.addEventListener('open', () => log(`连接 ${URL}`))
ws.addEventListener('error', () => {
  failures.push('WebSocket 连接错误')
  finish()
})
ws.addEventListener('close', () => {
  if (!finished) {
    failures.push(`连接在阶段 "${phase}" 断开`)
    finish()
  }
})
