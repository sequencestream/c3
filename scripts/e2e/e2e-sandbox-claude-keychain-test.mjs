#!/usr/bin/env node
/**
 * Sandbox claude 订阅登录(keychain)端到端验证 — 独立、不依赖 c3 server。
 *
 * 复核 macOS 上「配置了 sandbox 的 system 模式 claude 能否登录」这条链路。回归的
 * bug:arapuca `--allow-keychain` 会把 HOME 设成真实家目录、Keychain 可读,但
 *   1. arapuca env deny-by-default 把 `USER`/`LOGNAME` 抹成空,而 Claude Code 的
 *      Keychain 凭证查找按登录名索引 → 找不到 token;
 *   2. 一旦 wrapper 注入 `CLAUDE_CONFIG_DIR`,Claude Code 就从 Keychain 切换到
 *      文件型凭证 `$CLAUDE_CONFIG_DIR/.credentials.json`(不存在)→ 判定未登录。
 * 两者叠加使 sandbox 下 claude 启动即「Not logged in · Please run /login」。
 *
 * 本测试用【真实的 createSandboxWrapper】(经 tsx 导入 server 源码)生成一个
 * system 模式(allowKeychain:true)claude wrapper,再实跑 `claude -p`,断言:
 *   - 生成脚本转发了 USER/LOGNAME 且【不】含 CLAUDE_CONFIG_DIR(结构守卫);
 *   - claude 真正登录并回复,而非「Not logged in」(行为守卫)。
 *
 * 需要真实订阅登录 + 出网(claude 走宿主 proxy),因此非 CI 安全 —— 前置不满足时
 * 一律 SKIP(退出码 5),与 e2e-arapuca-capability-test.mjs 同样是本地/手动 e2e,
 * 不纳入 run-all.mjs 默认清单。
 *
 * 用法:
 *   node scripts/e2e/e2e-sandbox-claude-keychain-test.mjs
 *
 * 退出码:0 通过;1 失败(仍未登录 / 无回复 / 结构守卫不符);5 SKIP(前置不满足)。
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
const MODEL = process.env.C3_E2E_MODEL || 'claude-sonnet-4-5'

const C = {
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
}
const log = (s) => console.log(`${C.cyan}[keychain-e2e]${C.reset} ${s}`)
const pass = (s) => console.log(`${C.green}PASS${C.reset} ${s}`)
const fail = (s) => console.log(`${C.red}FAIL${C.reset} ${s}`)
const skip = (s) => {
  console.log(`${C.yellow}SKIP${C.reset} ${s}`)
  process.exit(5)
}

// ─── 前置探测(任一不满足 → SKIP) ───────────────────────────────────────────────

if (process.platform !== 'darwin') skip(`仅 macOS 覆盖 keychain 路径(当前 ${process.platform})`)

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

const claudeBin = onPath('claude')
if (!claudeBin) skip('宿主 PATH 上没有 claude CLI')

// arapuca:优先 c3 管理版本,兜底宿主 PATH / ~/.cargo/bin(镜像 SandboxLauncher 解析链)。
function resolveArapuca() {
  const managedCurrent = join(homedir(), '.c3', 'sandbox', 'arapuca', 'current')
  // current -> <version>/…;真实二进制在 <version>/arapuca-<version>/arapuca,交给 c3 代码解析,
  // 这里只判断有没有可用的 arapuca 供运行,能力细节由 e2e-arapuca-capability-test 覆盖。
  for (const c of [onPath('arapuca'), join(homedir(), '.cargo', 'bin', 'arapuca')]) {
    if (!c) continue
    try {
      accessSync(c, constants.X_OK)
      return c
    } catch {
      /* keep looking */
    }
  }
  try {
    accessSync(managedCurrent, constants.F_OK)
    return managedCurrent // 存在即可,真实路径由 resolveManagedArapuca 决定
  } catch {
    return null
  }
}
if (!resolveArapuca()) skip('没有可用的 arapuca(c3 管理版本或宿主 PATH 均缺失)')

// 订阅登录:Keychain 里必须有 Claude Code 凭证项,否则本机不是 system 模式登录。
const kc = spawnSync(
  '/usr/bin/security',
  ['find-generic-password', '-s', 'Claude Code-credentials'],
  {
    encoding: 'utf-8',
  },
)
if (kc.status !== 0) skip('Keychain 无 "Claude Code-credentials" 项(本机非订阅登录)')

// ─── 用真实 createSandboxWrapper 生成 system 模式 wrapper ────────────────────────

const work = mkdtempSync(join(tmpdir(), 'c3-kc-e2e-'))
let failed = false
try {
  const ws = join(work, 'ws')
  mkdirSync(ws, { recursive: true })
  const genTs = join(work, 'gen.mts')
  // 经 tsx 导入 server 源码,调用【真实】的 resolvePaths + createSandboxWrapper,
  // 打印 wrapper 路径 —— 从而真正覆盖被修复的代码,而非复刻其 flag 布局。
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
      `const script = createSandboxWrapper(paths, 'claude', tmp, { allowKeychain: true })`,
      `process.stdout.write(script)`,
    ].join('\n'),
  )

  log('用真实 createSandboxWrapper 生成 system 模式 wrapper …')
  const gen = spawnSync('pnpm', ['exec', 'tsx', genTs], { cwd: ROOT, encoding: 'utf-8' })
  if (gen.status !== 0 || !gen.stdout.trim()) {
    fail(`wrapper 生成失败:\n${gen.stdout}\n${gen.stderr}`)
    process.exit(1)
  }
  const wrapperPath = gen.stdout.trim()
  const wrapperText = readFileSync(wrapperPath, 'utf-8')

  // 结构守卫:修复的两个要点必须体现在生成脚本里。
  if (/CLAUDE_CONFIG_DIR/.test(wrapperText)) {
    fail('生成脚本仍注入 CLAUDE_CONFIG_DIR —— 会把 claude 切到文件型凭证')
    failed = true
  } else {
    pass('生成脚本未注入 CLAUDE_CONFIG_DIR(system 模式)')
  }
  if (/--env 'USER=/.test(wrapperText) && /--env 'LOGNAME=/.test(wrapperText)) {
    pass('生成脚本转发了 USER/LOGNAME')
  } else {
    fail('生成脚本未转发 USER/LOGNAME —— keychain 查找会按空登录名 miss')
    failed = true
  }

  // 行为守卫:实跑 claude,必须真正登录并回复,而非「Not logged in」。
  log(`实跑 claude(model=${MODEL})…`)
  const run = spawnSync(
    wrapperPath,
    ['-p', 'reply with exactly the word PONG and nothing else', '--model', MODEL],
    {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    },
  )
  const out = `${run.stdout || ''}${run.stderr || ''}`.trim()
  console.log(`${C.dim}${out}${C.reset}`)
  if (/Not logged in|Please run \/login/i.test(out)) {
    fail('claude 仍报「Not logged in」—— 沙箱登录未恢复')
    failed = true
  } else if (/PONG/.test(out)) {
    pass('claude 在 sandbox 内成功登录并回复 PONG')
  } else {
    fail(`claude 未按预期回复(可能出网/proxy 问题):${out.slice(0, 200)}`)
    failed = true
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

process.exit(failed ? 1 : 0)
