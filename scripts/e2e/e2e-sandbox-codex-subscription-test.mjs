#!/usr/bin/env node
/**
 * Sandbox codex 订阅登录(DIRECT)端到端验证 — 独立、不依赖 c3 server。
 *
 * 复核「配置了 sandbox 的 system 模式 codex 能否登录」这条链路。回归的 bug:
 * 订阅(system)模式 codex 走 DIRECT 路由,凭证在 `$CODEX_HOME/auth.json`(ChatGPT
 * OAuth token)。但 c3 sandbox 把 CODEX_HOME 指到隔离的
 * `~/.c3/sandbox-home/<ws>/.codex`(无 auth.json)→ codex 以空 bearer 直连
 * `wss://api.openai.com/v1/responses` → `401 Missing bearer or basic authentication`。
 *
 * 修复:system 模式 codex 的 CODEX_HOME 指向 HOST `~/.codex`(auth.json 在此)并挂载,
 * 会话 store scope 冻结 `host` 以对齐 rollout/resume/transcript(见 createSandboxWrapper
 * 的 codexSystemMode)。custom(relay)codex 仍用隔离 home + relay-token,不动。
 *
 * 本测试用【真实的 createSandboxWrapper】(经 tsx 导入 server 源码)生成一个
 * system 模式(allowKeychain:true)codex wrapper,再实跑 `codex exec`,断言:
 *   - 生成脚本把 CODEX_HOME 指向 HOST ~/.codex 且挂载它、不含隔离 sandbox-home(结构守卫);
 *   - codex 真正登录并回复,而非 401 Missing bearer(行为守卫)。
 *
 * 需要真实订阅登录(~/.codex/auth.json)+ 出网(codex 走宿主 proxy),因此非 CI 安全 ——
 * 前置不满足时一律 SKIP(退出码 5),与 e2e-sandbox-claude-keychain-test.mjs 同为本地/
 * 手动 e2e,不纳入 run-all.mjs 默认清单。OpenAI 对代理出口 IP 的瞬时地域拦截(403
 * "Unable to load site")按环境问题重试一次。
 *
 * 用法:
 *   node scripts/e2e/e2e-sandbox-codex-subscription-test.mjs
 *
 * 退出码:0 通过;1 失败(仍 401 / 无回复 / 结构守卫不符);5 SKIP(前置不满足)。
 */
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  accessSync,
  constants,
} from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

const C = {
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
}
const log = (s) => console.log(`${C.cyan}[codex-sub-e2e]${C.reset} ${s}`)
const pass = (s) => console.log(`${C.green}PASS${C.reset} ${s}`)
const fail = (s) => console.log(`${C.red}FAIL${C.reset} ${s}`)
const skip = (s) => {
  console.log(`${C.yellow}SKIP${C.reset} ${s}`)
  process.exit(5)
}

// ─── 前置探测(任一不满足 → SKIP) ───────────────────────────────────────────────

if (process.platform !== 'darwin') skip(`仅在 macOS 覆盖(当前 ${process.platform})`)

/** 在 PATH 上找可执行文件,返回绝对路径或 null。 */
function onPath(bin) {
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir) continue
    const p = join(dir, bin)
    try {
      accessSync(p, constants.X_OK)
      return p
    } catch {
      /* keep scanning */
    }
  }
  return null
}

if (!onPath('codex')) skip('宿主 PATH 上没有 codex CLI')

// arapuca:优先 c3 管理版本,兜底宿主 PATH / ~/.cargo/bin。
function hasArapuca() {
  for (const c of [onPath('arapuca'), join(homedir(), '.cargo', 'bin', 'arapuca')]) {
    if (!c) continue
    try {
      accessSync(c, constants.X_OK)
      return true
    } catch {
      /* keep looking */
    }
  }
  try {
    accessSync(join(homedir(), '.c3', 'sandbox', 'arapuca', 'current'), constants.F_OK)
    return true
  } catch {
    return false
  }
}
if (!hasArapuca()) skip('没有可用的 arapuca(c3 管理版本或宿主 PATH 均缺失)')

// 订阅登录:HOST ~/.codex/auth.json 必须存在,否则本机不是 DIRECT 订阅登录。
const hostCodex = process.env.CODEX_HOME
  ? resolve(process.env.CODEX_HOME)
  : join(homedir(), '.codex')
try {
  accessSync(join(hostCodex, 'auth.json'), constants.R_OK)
} catch {
  skip(`${join(hostCodex, 'auth.json')} 不存在/不可读(本机非 codex 订阅登录)`)
}

// ─── 用真实 createSandboxWrapper 生成 system 模式 codex wrapper ──────────────────

const work = mkdtempSync(join(tmpdir(), 'c3-cx-e2e-'))
let failed = false
try {
  const ws = join(work, 'ws')
  mkdirSync(ws, { recursive: true })
  const genTs = join(work, 'gen.mts')
  writeFileSync(
    genTs,
    [
      `import { mkdtempSync, mkdirSync } from 'node:fs'`,
      `import { join } from 'node:path'`,
      `import { resolvePaths, createSandboxWrapper, probeArapuca } from ${JSON.stringify(
        join(ROOT, 'server', 'src', 'kernel', 'sandbox', 'SandboxLauncher.ts'),
      )}`,
      `const ws = ${JSON.stringify(ws)}`,
      `const probe = probeArapuca()`,
      `if (!probe.ok) { console.error('probe failed: ' + probe.uiCode); process.exit(7) }`,
      `const paths = resolvePaths(ws, ws, [], probe.path)`,
      `const tmp = mkdtempSync(join(${JSON.stringify(work)}, 'wrap-'))`,
      `const script = createSandboxWrapper(paths, 'codex', tmp, { allowKeychain: true })`,
      `process.stdout.write(script)`,
    ].join('\n'),
  )

  log('用真实 createSandboxWrapper 生成 system 模式 codex wrapper …')
  const gen = spawnSync('pnpm', ['exec', 'tsx', genTs], { cwd: ROOT, encoding: 'utf-8' })
  if (gen.status !== 0 || !gen.stdout.trim()) {
    fail(`wrapper 生成失败:\n${gen.stdout}\n${gen.stderr}`)
    process.exit(1)
  }
  const wrapperPath = gen.stdout.trim()
  const wrapperText = readFileSync(wrapperPath, 'utf-8')

  // 结构守卫:CODEX_HOME 指向 HOST ~/.codex 并挂载它,且不含隔离 sandbox-home。
  if (
    wrapperText.includes(`--env 'CODEX_HOME=${hostCodex}'`) &&
    wrapperText.includes(`-v '${hostCodex}:rw'`)
  ) {
    pass('CODEX_HOME 指向 HOST ~/.codex 且已挂载')
  } else {
    fail('CODEX_HOME 未指向 HOST ~/.codex —— auth.json 不可达')
    failed = true
  }
  if (/sandbox-home/.test(wrapperText)) {
    fail('生成脚本仍挂载隔离的 sandbox-home(system codex 不应使用它)')
    failed = true
  } else {
    pass('未使用隔离 sandbox-home')
  }

  // 行为守卫:实跑 codex,必须真正登录(无 401 Missing bearer);OpenAI 地域拦截时重试一次。
  const runOnce = () => {
    const r = spawnSync(
      wrapperPath,
      ['exec', '--skip-git-repo-check', 'reply with exactly the word PONG and nothing else'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 },
    )
    return `${r.stdout || ''}${r.stderr || ''}`
  }
  log('实跑 codex exec …')
  let out = runOnce()
  if (/Unable to load site|try again later|status\.openai\.com/i.test(out) && !/PONG/.test(out)) {
    log('OpenAI 返回地域拦截页(环境问题),重试一次 …')
    out = runOnce()
  }
  const tail = out.trim().slice(-400)
  console.log(`${C.dim}${tail}${C.reset}`)
  if (/401|Missing bearer|Unauthorized/i.test(out)) {
    fail('codex 仍报 401 Missing bearer —— 沙箱订阅认证未恢复')
    failed = true
  } else if (/PONG/.test(out)) {
    pass('codex 在 sandbox 内成功登录并回复 PONG')
  } else if (/Unable to load site|try again later|status\.openai\.com/i.test(out)) {
    // 认证已通过(无 401),仅被 OpenAI 地域拦截 —— 判为环境 SKIP,不失败。
    skip('认证已通过但被 OpenAI 地域拦截(代理出口 IP),属环境问题')
  } else {
    fail(`codex 未按预期回复:${tail}`)
    failed = true
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

process.exit(failed ? 1 : 0)
