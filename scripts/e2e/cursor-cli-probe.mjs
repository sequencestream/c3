#!/usr/bin/env node
/**
 * Cursor Agent CLI 能力探针 — 独立、不依赖 c3 server。
 *
 * 直接对宿主上的 `cursor-agent` 做一组能力探测,为「接入 Cursor 并交付可续聊
 * MVP」提供准入证据。探针结论是能力台账与契约测试的唯一事实来源:未被本探针
 * 证明的能力一律不得在 c3 中标记为支持。
 *
 * 两个阻断项(go/no-go):
 *   G1 resume-after-SIGTERM  运行收到 SIGTERM 后,`--resume <chatId>` 仍能续聊。
 *   G2 data-root-persistence 持久化完整 `~/.cursor` 数据根后,同一 chatId 仍能续聊。
 * 任一失败即判定 no-go:停止 Cursor 产品注册与完整实现,而不是用 c3 镜像伪造恢复。
 *
 * 其余记录项(不阻断,但决定能力台账如何声明):
 *   binary/version   二进制定位链(CURSOR_AGENT_PATH → PATH)与版本输出格式。
 *   auth             认证落点:`~/.cursor` 内的凭据文件,还是 macOS 钥匙串/env。
 *                    决定沙箱 profile 该挂载什么(仅挂数据根是否够)。
 *   single-turn      `-p` 单轮是否自然退出、退出码与终止事件形态。
 *   stream-events    stream-json 的事件种类、chatId 落点、文本聚合单位。
 *   tool-id          工具调用是否带稳定 id,结果能否按 id 回填(决定归一化策略:
 *                    稳定 id 优先,否则确定性合成 id + vendorExtra 降级标记)。
 *   native-tools     原生工具清单(freezeTools 静态表的证据)。
 *   mcp              注入 `~/.cursor/mcp.json` 后 `mcp list` 是否可见、`-p` 下是否可用。
 *                    若 `-p` 根本看不见注入的 MCP,则 Cursor 不得参与依赖 c3 MCP
 *                    的 intent/spec 流程(条件交付)。
 *   session-list     是否存在非交互的会话列表/读取通道(决定 sessions 能力等级)。
 *   hooks            是否存在 hooks 配置面(c3 不得修改用户 hooks.json,仅记录)。
 *
 * 用法:
 *   node scripts/e2e/cursor-cli-probe.mjs                 # 全量探针
 *   node scripts/e2e/cursor-cli-probe.mjs --gates-only    # 只跑两个阻断项
 *   node scripts/e2e/cursor-cli-probe.mjs --json          # 机器可读结论
 *   node scripts/e2e/cursor-cli-probe.mjs --keep          # 保留临时 HOME 与原始 NDJSON
 *   CURSOR_AGENT_PATH=/abs/path node scripts/e2e/cursor-cli-probe.mjs
 *
 * 退出码:两个阻断项均通过 0;任一阻断项失败(no-go)1;二进制缺失 2;
 * 未认证或无法在当前环境完成真实运行 5(SKIP)。
 *
 * 真实运行会消耗 Cursor 额度(数轮短对话)。
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const GATES_ONLY = args.includes('--gates-only')
const AS_JSON = args.includes('--json')
const KEEP = args.includes('--keep')

/** 单轮运行的宽限时间;真实模型调用有网络抖动,给足余量。 */
const RUN_TIMEOUT_MS = 180_000
/** 探针工件目录:原始 NDJSON 与临时 HOME 均落在这里,便于复查证据。 */
const ARTIFACT_DIR = mkdtempSync(join(tmpdir(), 'cursor-probe-'))

const results = []
const notes = {}

/** 记录一条探针结论。`gate` 为 true 表示阻断项。 */
function record(id, status, detail, gate = false) {
  results.push({ id, status, detail, gate })
  if (!AS_JSON) {
    const tag = { PASS: 'PASS', FAIL: 'FAIL', SKIP: 'SKIP', INFO: 'INFO' }[status] ?? status
    console.log(`${gate ? '[GATE] ' : '       '}${tag.padEnd(4)}  ${id}  ${detail}`)
  }
}

// ─── 二进制定位(镜像 c3 将实现的 external 解析链)──────────────────────────

/** CURSOR_AGENT_PATH 显式指定优先,其次宿主 PATH —— Cursor 只支持用户自装。 */
function findCursorAgent() {
  const override = process.env.CURSOR_AGENT_PATH
  if (override) {
    return existsSync(override) ? { path: override, source: 'env-override' } : null
  }
  const probe =
    process.platform === 'win32'
      ? spawnSync('where', ['cursor-agent'], { encoding: 'utf8' })
      : spawnSync('sh', ['-c', 'command -v cursor-agent'], { encoding: 'utf8' })
  const hit = (probe.stdout ?? '').split('\n')[0]?.trim()
  return hit ? { path: hit, source: 'host-path' } : null
}

// ─── CLI 执行助手 ────────────────────────────────────────────────────────────

/**
 * 同步跑一条 cursor-agent 子命令(非流式,用于 status/mcp list/--version)。
 */
function cli(bin, argv, env = {}, timeout = 60_000, cwd) {
  const r = spawnSync(bin, argv, {
    encoding: 'utf8',
    timeout,
    env: { ...process.env, ...env },
    ...(cwd ? { cwd } : {}),
  })
  return {
    code: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    timedOut: r.error?.code === 'ETIMEDOUT',
  }
}

/**
 * 异步跑一条子命令并收集合并输出。用于任何在本进程还需响应网络请求时的调用
 * (见 probeMcp:`spawnSync` 会阻塞事件循环,探针自带的 MCP 服务器将无法应答)。
 */
function cliAsync(bin, argv, env = {}, cwd, timeout = 60_000) {
  return new Promise((resolve) => {
    const child = spawn(bin, argv, { env: { ...process.env, ...env }, ...(cwd ? { cwd } : {}) })
    let out = ''
    child.stdout.on('data', (d) => {
      out += d
    })
    child.stderr.on('data', (d) => {
      out += d
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve(String(err))
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve(out.trim())
    })
  })
}

/**
 * 流式跑一轮 `-p --output-format stream-json`,增量解析 NDJSON。
 *
 * 关键点:CLI 的 chunk 边界与行边界无关,必须缓冲跨 chunk 的残行 —— 这正是
 * c3 driver 必须实现的解码语义,探针先在这里验证一遍。
 *
 * `onEvent(evt, rawLine)` 返回 'kill' 时,向整个进程组发送 SIGTERM(用于 G1)。
 */
function streamRun(
  bin,
  argv,
  { env = {}, label = 'run', timeout = RUN_TIMEOUT_MS, onEvent, cwd } = {},
) {
  return new Promise((resolve) => {
    const child = spawn(bin, argv, {
      env: { ...process.env, ...env },
      // 自成进程组:探针要验证「向整个进程组发信号」这条 c3 abort 语义。
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(cwd ? { cwd } : {}),
    })
    const events = []
    const rawLines = []
    const badLines = []
    let stderr = ''
    let buf = ''
    let killed = false
    let killedAt = 0

    const decoder = new TextDecoder('utf-8')

    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* 进程组已消失 */
      }
    }, timeout)

    /** 只解析完整行;EOF 时再解析一条非空残行。 */
    const consume = (chunk, isFinal = false) => {
      buf += decoder.decode(chunk, { stream: !isFinal })
      const lines = buf.split('\n')
      buf = isFinal ? '' : lines.pop()
      const tail = isFinal && buf ? [buf] : []
      for (const line of [...lines, ...tail]) {
        const trimmed = line.trim()
        if (!trimmed) continue
        rawLines.push(trimmed)
        let evt
        try {
          evt = JSON.parse(trimmed)
        } catch {
          badLines.push(trimmed)
          continue
        }
        events.push(evt)
        if (!killed && onEvent?.(evt, trimmed) === 'kill') {
          killed = true
          killedAt = Date.now()
          try {
            process.kill(-child.pid, 'SIGTERM')
          } catch {
            /* 已退出 */
          }
        }
      }
    }

    child.stdout.on('data', (c) => consume(c))
    child.stderr.on('data', (c) => {
      stderr += c.toString()
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ spawnError: String(err), events, rawLines, badLines, stderr, killed })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      consume(Buffer.alloc(0), true)
      if (KEEP) {
        writeFileSync(join(ARTIFACT_DIR, `${label}.ndjson`), rawLines.join('\n'))
      }
      resolve({
        code,
        signal,
        events,
        rawLines,
        badLines,
        stderr,
        killed,
        killLatencyMs: killed ? Date.now() - killedAt : null,
      })
    })
  })
}

/** 深度搜一个事件里第一个像 chat/session id 的值。 */
function findChatId(evt) {
  const keys = ['chatId', 'chat_id', 'sessionId', 'session_id', 'threadId', 'thread_id']
  const walk = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 4) return null
    for (const k of keys) {
      const v = node[k]
      if (typeof v === 'string' && v.length >= 8) return v
    }
    for (const v of Object.values(node)) {
      const hit = walk(v, depth + 1)
      if (hit) return hit
    }
    return null
  }
  return walk(evt)
}

/** 汇总一次流式运行里出现过的事件种类,作为归一化设计依据。 */
function eventShape(events) {
  const kinds = new Map()
  for (const e of events) {
    const kind = e.type ?? e.event ?? e.kind ?? '(untyped)'
    const sub = e.subtype ?? e.role ?? ''
    const key = sub ? `${kind}/${sub}` : String(kind)
    kinds.set(key, (kinds.get(key) ?? 0) + 1)
  }
  return [...kinds.entries()].map(([k, n]) => `${k}×${n}`).join(', ')
}

/**
 * 从一轮事件里抽取工具调用 id 与工具种类,判断能否按稳定 id 回填。
 *
 * Cursor 的工具种类不是 `name` 字段,而是 `tool_call` 下的**包装键**
 * (`readToolCall` / `shellToolCall` / `mcpToolCall` …),结果在同一包装键的
 * `result.success|error` 内。稳定 id 为 `call_id`(started 与 completed 相同),
 * 注意其中含换行,不能当单行标识直接拼接。
 */
function toolCorrelation(events) {
  const ids = new Set()
  const kinds = new Set()
  let toolEvents = 0
  let withId = 0
  for (const e of events) {
    if (e.type !== 'tool_call') continue
    toolEvents += 1
    if (typeof e.call_id === 'string' && e.call_id) {
      ids.add(e.call_id)
      withId += 1
    }
    for (const k of Object.keys(e.tool_call ?? {})) {
      if (k.endsWith('ToolCall')) kinds.add(k)
    }
  }
  return { toolEvents, withId, ids: [...ids], kinds: [...kinds] }
}

// ─── 探针主体 ────────────────────────────────────────────────────────────────

async function main() {
  // 1) 二进制 ---------------------------------------------------------------
  const found = findCursorAgent()
  if (!found) {
    record(
      'binary',
      'FAIL',
      'cursor-agent 不在 CURSOR_AGENT_PATH / PATH 上;请先自行安装 Cursor CLI',
    )
    finish(2)
    return
  }
  const bin = found.path
  const ver = cli(bin, ['--version'])
  const versionText = ver.stdout.trim() || ver.stderr.trim()
  record('binary', 'INFO', `${bin} (source=${found.source})`)
  record('version', 'INFO', `--version → ${JSON.stringify(versionText)}`)
  notes.binary = { path: bin, source: found.source, version: versionText }

  // 2) 认证落点 -------------------------------------------------------------
  const statusJson = cli(bin, ['status', '--format', 'json'])
  const statusText = cli(bin, ['status'])
  const loggedIn = !/not logged in/i.test(statusText.stdout + statusText.stderr)
  notes.auth = {
    statusJson: statusJson.stdout.trim().slice(0, 400),
    statusText: statusText.stdout.trim().slice(0, 200),
    loggedIn,
    hasApiKeyEnv: Boolean(process.env.CURSOR_API_KEY),
  }
  record(
    'auth',
    loggedIn ? 'INFO' : 'SKIP',
    loggedIn ? `已认证:${statusText.stdout.trim().split('\n')[0]}` : '未认证',
  )

  // 认证落点:真实 ~/.cursor 下有哪些文件(判断凭据是否落盘,决定沙箱挂载策略)
  const hostCursorHome = join(homedir(), '.cursor')
  const hostEntries = existsSync(hostCursorHome) ? readdirSync(hostCursorHome) : []
  record('auth-landing', 'INFO', `~/.cursor 内容:${hostEntries.join(', ') || '(空/不存在)'}`)
  notes.authLanding = hostEntries

  // 3) hooks / MCP 配置面(静态记录,c3 绝不改用户 hooks.json)---------------
  const mcpList = cli(bin, ['mcp', 'list'])
  record(
    'mcp-surface',
    'INFO',
    `mcp list → ${(mcpList.stdout + mcpList.stderr).trim().split('\n')[0]}`,
  )
  record(
    'hooks-surface',
    'INFO',
    existsSync(join(hostCursorHome, 'hooks.json'))
      ? '存在用户 hooks.json(c3 只读不改)'
      : '无用户 hooks.json',
  )

  // 4) 非交互会话列表通道 ---------------------------------------------------
  // `--resume` 不带参数是交互式选择器,不能作为 c3 的列表通道;这里确认是否存在
  // 任何非交互列表子命令。结论直接决定 sessions.list/read 的能力等级。
  const help = cli(bin, ['--help'])
  const hasListCmd = /^\s*(ls|list|sessions|chats)\b/m.test(help.stdout)
  record(
    'session-list',
    'INFO',
    hasListCmd
      ? '存在非交互会话列表子命令'
      : '无非交互列表子命令 → sessions.list/read 只能靠 c3 自有镜像',
  )
  notes.sessionList = { hasListCmd }

  if (!loggedIn && !process.env.CURSOR_API_KEY) {
    record(
      'gate-G1',
      'SKIP',
      '未认证,无法完成真实运行 → 两个阻断项均无法判定。请先 `cursor-agent login` 或设置 CURSOR_API_KEY',
      true,
    )
    record('gate-G2', 'SKIP', '未认证,无法完成真实运行', true)
    finish(5)
    return
  }

  // 5) 单轮运行 + 事件形态 + 工具 id ---------------------------------------
  // 用一个必然触发工具调用的提示,同时观察文本聚合与工具关联。
  const workRoot = join(ARTIFACT_DIR, 'work')
  mkdirSync(workRoot, { recursive: true })
  writeFileSync(join(workRoot, 'probe-marker.txt'), 'cursor-probe\n')

  const firstArgs = [
    '-p',
    '--output-format',
    'stream-json',
    '--force',
    '--trust',
    '--workspace',
    workRoot,
    'List the files in this directory using a tool, then reply with exactly: PROBE-ONE-DONE',
  ]
  const first = await streamRun(bin, firstArgs, { label: 'single-turn' })
  const firstChatId = first.events.map(findChatId).find(Boolean) ?? null
  notes.singleTurn = {
    exitCode: first.code,
    signal: first.signal,
    eventKinds: eventShape(first.events),
    eventCount: first.events.length,
    malformedLines: first.badLines.length,
    chatId: firstChatId,
  }

  if (first.spawnError || (first.events.length === 0 && first.code !== 0)) {
    record(
      'single-turn',
      'FAIL',
      `运行失败:${first.spawnError ?? first.stderr.trim().slice(0, 200)}`,
    )
    record('gate-G1', 'SKIP', '基础单轮运行不可用,阻断项无法判定', true)
    record('gate-G2', 'SKIP', '基础单轮运行不可用,阻断项无法判定', true)
    finish(5)
    return
  }

  record(
    'single-turn',
    first.code === 0 ? 'PASS' : 'FAIL',
    `退出码=${first.code} 事件数=${first.events.length}`,
  )
  record('stream-events', 'INFO', `事件种类:${notes.singleTurn.eventKinds}`)
  record(
    'ndjson-integrity',
    first.badLines.length === 0 ? 'PASS' : 'FAIL',
    `不可解析行=${first.badLines.length}`,
  )
  record(
    'chat-id',
    firstChatId ? 'PASS' : 'FAIL',
    firstChatId ? `首个 chatId=${firstChatId}` : '流中未发现 chat id',
  )

  const corr = toolCorrelation(first.events)
  notes.toolCorrelation = corr
  record(
    'tool-id',
    corr.toolEvents === 0 ? 'INFO' : corr.withId === corr.toolEvents ? 'PASS' : 'FAIL',
    `工具事件=${corr.toolEvents} 带 id=${corr.withId} 唯一 id=${corr.ids.length}`,
  )
  record('native-tools', 'INFO', `观察到的工具包装键:${corr.kinds.join(', ') || '(本轮无)'}`)

  // 6) GATE G1:SIGTERM 后原生 resume ---------------------------------------
  let g1 = false
  let g1Detail
  if (!firstChatId) {
    g1Detail = '无 chatId,无法验证 resume'
  } else {
    const longArgs = [
      '-p',
      '--output-format',
      'stream-json',
      '--force',
      '--trust',
      '--workspace',
      workRoot,
      'The secret word is BANANA. Remember it. Then count slowly from 1 to 40, one number per line.',
    ]
    // 必须等模型真正开始应答(assistant / tool_call)后再 SIGTERM:`system/init`
    // 只是 CLI 自报会话,此时模型尚未收到提示,杀在这里等于测了个空会话。
    let killChatId = null
    const interrupted = await streamRun(bin, longArgs, {
      label: 'sigterm-run',
      onEvent: (evt) => {
        killChatId ||= findChatId(evt)
        const engaged = evt.type === 'assistant' || evt.type === 'tool_call'
        return engaged && killChatId ? 'kill' : undefined
      },
    })
    notes.sigterm = {
      chatId: killChatId,
      exitCode: interrupted.code,
      signal: interrupted.signal,
      killLatencyMs: interrupted.killLatencyMs,
    }
    record(
      'sigterm-exit',
      interrupted.killed ? 'PASS' : 'FAIL',
      `killed=${interrupted.killed} 退出码=${interrupted.code} signal=${interrupted.signal}`,
    )

    if (killChatId) {
      const resumed = await streamRun(
        bin,
        [
          '-p',
          '--output-format',
          'stream-json',
          '--force',
          '--trust',
          '--workspace',
          workRoot,
          '--resume',
          killChatId,
          'What was the secret word I asked you to remember? Reply with just that word.',
        ],
        { label: 'resume-after-sigterm' },
      )
      const text = JSON.stringify(resumed.events)
      const recalled = /BANANA/i.test(text)
      g1 = resumed.code === 0 && resumed.events.length > 0 && recalled
      g1Detail = `resume 退出码=${resumed.code} 事件数=${resumed.events.length} 记忆命中=${recalled}`
      notes.g1 = { chatId: killChatId, exitCode: resumed.code, recalled }
    } else {
      g1Detail = 'SIGTERM 前未取得 chatId'
    }
  }
  record('gate-G1', g1 ? 'PASS' : 'FAIL', `SIGTERM 后 --resume 续聊:${g1Detail}`, true)

  // 7) GATE G2:持久化完整 ~/.cursor 数据根后仍可续聊 -----------------------
  // 用独立 HOME 复现沙箱:把宿主 ~/.cursor 整体复制进去(= 持久化数据根),
  // 在其中开一轮取得 chatId,再在同一数据根上 resume。
  //
  // 关键:cursor-agent 无 CURSOR_HOME 之类覆盖,数据根恒为 `$HOME/.cursor`,
  // 而登录凭据在 macOS 登录钥匙串(cursor-access-token / cursor-refresh-token),
  // 不在数据根内。换 HOME 会一并换掉 ~/Library/Keychains,导致「未认证」——
  // 那是探针自身的假象,不是 CLI 限制。因此这里同时链回钥匙串,精确对应沙箱
  // profile 必须做的两件事:持久化数据根 + allowKeychain。
  let g2 = false
  let g2Detail
  const sandboxHome = join(ARTIFACT_DIR, 'home')
  mkdirSync(sandboxHome, { recursive: true })
  if (existsSync(hostCursorHome)) {
    // worker.sock 等套接字不可复制,跳过(沙箱挂载同样只关心常规文件)。
    cpSync(hostCursorHome, join(sandboxHome, '.cursor'), {
      recursive: true,
      filter: (src) => {
        try {
          return !statSync(src).isSocket()
        } catch {
          return false
        }
      },
    })
  }
  if (process.platform === 'darwin') {
    const keychains = join(homedir(), 'Library', 'Keychains')
    if (existsSync(keychains)) {
      mkdirSync(join(sandboxHome, 'Library'), { recursive: true })
      try {
        symlinkSync(keychains, join(sandboxHome, 'Library', 'Keychains'))
      } catch {
        /* 已存在 */
      }
    }
  }
  const scopedEnv = { HOME: sandboxHome, XDG_CONFIG_HOME: join(sandboxHome, '.config') }

  const scopedStatus = cli(bin, ['status'], scopedEnv)
  const scopedLoggedIn = !/not logged in/i.test(scopedStatus.stdout + scopedStatus.stderr)
  // 数据根 + 钥匙串两者齐备才应认证成功;失败说明沙箱 profile 还缺一块授权。
  record(
    'auth-portability',
    scopedLoggedIn ? 'PASS' : 'FAIL',
    scopedLoggedIn
      ? '持久化数据根 + 钥匙串授权后,独立 HOME 下仍认证 → 沙箱 profile 需 mount(~/.cursor) + allowKeychain'
      : '独立 HOME 下未认证 → 沙箱 profile 授权不足(检查钥匙串访问)',
  )
  notes.authPortability = {
    scopedLoggedIn,
    credentialStore: 'macos-login-keychain',
    dataRootEnvOverride: null,
  }

  if (scopedLoggedIn || process.env.CURSOR_API_KEY) {
    const scopedFirst = await streamRun(
      bin,
      [
        '-p',
        '--output-format',
        'stream-json',
        '--force',
        '--trust',
        '--workspace',
        workRoot,
        'The secret word is MANGO. Remember it and reply with exactly: PROBE-SCOPED-DONE',
      ],
      { label: 'scoped-first', env: scopedEnv },
    )
    const scopedChatId = scopedFirst.events.map(findChatId).find(Boolean) ?? null
    if (scopedChatId) {
      const scopedResume = await streamRun(
        bin,
        [
          '-p',
          '--output-format',
          'stream-json',
          '--force',
          '--trust',
          '--workspace',
          workRoot,
          '--resume',
          scopedChatId,
          'What was the secret word? Reply with just that word.',
        ],
        { label: 'scoped-resume', env: scopedEnv },
      )
      const recalled = /MANGO/i.test(JSON.stringify(scopedResume.events))
      g2 = scopedResume.code === 0 && recalled
      g2Detail = `数据根=${join(sandboxHome, '.cursor')} resume 退出码=${scopedResume.code} 记忆命中=${recalled}`
      // 记录 chat 数据确实落在被持久化的数据根内(而非其他位置)。
      const chatsDir = join(sandboxHome, '.cursor', 'chats')
      notes.g2 = {
        chatId: scopedChatId,
        recalled,
        chatsDirExists: existsSync(chatsDir),
        dataRootEntries: existsSync(join(sandboxHome, '.cursor'))
          ? readdirSync(join(sandboxHome, '.cursor'))
          : [],
      }
    } else {
      g2Detail = '独立 HOME 下未取得 chatId'
    }
  } else {
    g2Detail = '独立 HOME 下不可认证,无法判定(需先解决沙箱认证:钥匙串或 CURSOR_API_KEY)'
  }
  record('gate-G2', g2 ? 'PASS' : 'FAIL', `持久化 ~/.cursor 后续聊:${g2Detail}`, true)

  if (GATES_ONLY) {
    finish(g1 && g2 ? 0 : 1)
    return
  }

  // 8) MCP 注入 + 自检 -------------------------------------------------------
  // 起一个回环 HTTP MCP,写入被持久化数据根的 mcp.json,再用 `mcp list` 自检
  // 可见性 —— 这正是 c3 启动后要做的那次自检。
  const mcpProbe = await probeMcp(bin, sandboxHome, scopedEnv, workRoot)
  record('mcp-inject', mcpProbe.listed ? 'PASS' : 'FAIL', mcpProbe.listDetail)
  record(
    'mcp-list-tools',
    /c3_probe_ping/.test(mcpProbe.toolsDetail) ? 'PASS' : 'FAIL',
    mcpProbe.toolsDetail,
  )
  record('mcp-in-print', mcpProbe.reachable ? 'PASS' : 'FAIL', mcpProbe.runDetail)
  notes.mcp = mcpProbe

  finish(g1 && g2 ? 0 : 1)
}

/**
 * 注入一个回环 HTTP MCP 并自检可见性 / `-p` 下可达性。
 * 只实现 MCP 所需的最小 JSON-RPC 面:initialize / tools/list / tools/call。
 */
async function probeMcp(bin, sandboxHome, scopedEnv, workRoot) {
  let called = false
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      let msg = {}
      try {
        msg = JSON.parse(body || '{}')
      } catch {
        /* 忽略非 JSON 探测请求 */
      }
      const reply = (result) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, result }))
      }
      if (msg.method === 'initialize') {
        reply({
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'c3-probe', version: '0.0.1' },
        })
      } else if (msg.method === 'tools/list') {
        reply({
          tools: [
            {
              name: 'c3_probe_ping',
              description: 'Returns the probe token. Call this when asked for the probe token.',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        })
      } else if (msg.method === 'tools/call') {
        called = true
        reply({ content: [{ type: 'text', text: 'C3-MCP-PONG' }] })
      } else {
        reply({})
      }
    })
  })

  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
  const url = `http://127.0.0.1:${port}/mcp`

  // 注入到 workspace 的项目级 `.cursor/mcp.json`(与宿主全局配置解耦,探针不污染
  // 用户配置;c3 实际注入点同理)。注入后必须 `mcp enable` 批准,否则 `mcp list`
  // 恒为 `not loaded (needs approval)` —— 这一步就是启动后自检要断言的状态。
  const cursorDir = join(workRoot, '.cursor')
  mkdirSync(cursorDir, { recursive: true })
  writeFileSync(
    join(cursorDir, 'mcp.json'),
    JSON.stringify({ mcpServers: { c3probe: { url } } }, null, 2),
  )

  // 回环地址必须绕开宿主代理,否则 MCP 请求会被代理吞掉。
  const mcpEnv = {
    ...scopedEnv,
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
  }
  // 项目级 `.cursor/mcp.json` 只在以该目录为 cwd 时生效。
  //
  // 必须用**异步** spawn:MCP 服务器就跑在本进程里,`spawnSync` 会占死事件循环,
  // 导致 CLI 的握手请求永远得不到应答,`mcp list` 假报 `Connection failed`。
  const inWorkspace = (argv) => cliAsync(bin, argv, mcpEnv, workRoot)

  await inWorkspace(['mcp', 'enable', 'c3probe'])
  const listOut = await inWorkspace(['mcp', 'list'])
  // `ready` 才算真正可达:`needs approval` / `Connection failed` 都不是。
  const listed = /c3probe:\s*ready/i.test(listOut)

  // 工具枚举自检:c3 的 listTools() 要靠这一步确认 MCP 工具真实可见。
  const toolsOut = await inWorkspace(['mcp', 'list-tools', 'c3probe'])

  let runDetail = '未执行(mcp list 未 ready)'
  let reachable = false
  if (listed) {
    const run = await streamRun(
      bin,
      [
        '-p',
        '--output-format',
        'stream-json',
        '--force',
        '--trust',
        '--approve-mcps',
        '--workspace',
        workRoot,
        'Call the c3_probe_ping tool and reply with exactly what it returns.',
      ],
      { label: 'mcp-run', env: mcpEnv, cwd: workRoot },
    )
    reachable = called || /C3-MCP-PONG/.test(JSON.stringify(run.events))
    runDetail = `-p 下 MCP 被调用=${called} 退出码=${run.code}`
  }

  server.close()
  return {
    url,
    listed,
    listDetail: `mcp list → ${listOut.split('\n')[0] || '(空)'}`,
    toolsDetail: toolsOut.split('\n').slice(0, 3).join(' | '),
    reachable,
    runDetail,
  }
}

function finish(code) {
  const gates = results.filter((r) => r.gate)
  const verdict = code === 0 ? 'GO' : code === 1 ? 'NO-GO' : code === 2 ? 'BINARY-MISSING' : 'SKIP'
  if (AS_JSON) {
    console.log(
      JSON.stringify(
        { verdict, exitCode: code, results, notes, artifactDir: ARTIFACT_DIR },
        null,
        2,
      ),
    )
  } else {
    console.log('')
    console.log(`VERDICT: ${verdict}`)
    for (const g of gates) console.log(`  ${g.id}: ${g.status}`)
    if (KEEP) console.log(`工件保留在 ${ARTIFACT_DIR}`)
  }
  if (!KEEP) rmSync(ARTIFACT_DIR, { recursive: true, force: true })
  process.exit(code)
}

main().catch((err) => {
  record('probe', 'FAIL', `探针自身异常:${String(err?.stack ?? err)}`)
  finish(1)
})
