#!/usr/bin/env node
/**
 * Sandbox vendor token E2E — 真实验证 vendor CLI 在 arapuca 沙箱内发出 token 请求。
 *
 * 与纯能力探测(`e2e-arapuca-capability-test.mjs`,token-free)互补:这一支用
 * `~/.c3/settings.json` 里的真实 agent 配置(默认 `claude-deepseek` /
 * `codex-deepseek`),在补丁版 arapuca 沙箱内**实际发送一次带 token 的请求**,
 * 复刻 `SandboxLauncher.createSandboxWrapper` 生成的 arapuca 命令形态:
 *   - `--seccomp baseline`(开网,provider 调用需要)
 *   - claude 运行时目录 `/tmp/claude-<uid>` 放行
 *   - CODEX_HOME 指向沙箱内隔离目录
 * 认证严格走 env(agent 的 baseUrl + 解密后的 apiKey),**不碰订阅 / keychain**。
 *
 * 判定:
 *   - claude:`-p` 干净输出模型回复(不 echo prompt),收到约定词即真实成功。
 *   - codex:直连 provider 用的是 OpenAI Responses API(`/responses`);多数
 *     OpenAI 兼容网关(如 deepseek)不提供该端点,c3 生产靠 CodexRelay 适配。
 *     故独立脚本对 codex 只验证到"沙箱网络可达 + 认证被接受"(非 ConnectionRefused
 *     / 非 401),真正的完成留给经 c3 server 的完整 run e2e。
 *
 * 前置:宿主装有对应 vendor CLI + arapuca(补丁版,含 mount-ancestor / /tmp fix)+
 * `~/.c3/settings.json` 里存在目标 agent。缺任一项对该 vendor SKIP。
 *
 * 用法:node scripts/e2e/e2e-sandbox-vendor-token-test.mjs [claude-agent] [codex-agent]
 * 退出码:0 = claude 真实请求成功;5 = claude SKIP(配置/二进制缺失);1 = FAIL。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, mkdirSync, mkdtempSync, realpathSync, accessSync, constants } from 'node:fs'
import { createDecipheriv } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'

const CLAUDE_AGENT = process.argv[2] || 'claude-deepseek'
const CODEX_AGENT = process.argv[3] || 'codex-deepseek'
const PROMPT = 'Reply with exactly one word: PONG'
const SENTINEL = /PONG/i

// ─── c3 at-rest 解密(内联自 server/src/kernel/config/encryption.ts)──────────

function buildKeyV1() {
  const A = Buffer.from('7b1c4af93e62d50819a7c3f4e0b29d6c54871af2db390e6c25a7f10934bd8e72', 'hex')
  const B = Buffer.from('2f9a08e1c47b36d5a01e9f23748cb6d0193ae7f25c0d8b41ef6273a9c108d54b', 'hex')
  const C = Buffer.from('c4e371a6082f9bd34e57c10ab9f6234d7a8e0c5193b27f6a04ec8d3915ba62c08', 'hex')
  const k = Buffer.alloc(32)
  for (let i = 0; i < 32; i++) k[i] = A[i] ^ B[i] ^ C[i]
  return k
}
function decryptSecret(stored) {
  if (!stored || !stored.startsWith('c3secret')) return stored || ''
  const sep = stored.indexOf(':')
  const version = stored.slice('c3secret'.length, sep)
  if (version !== 'v1') throw new Error(`unknown c3secret key version: ${version}`)
  const body = Buffer.from(stored.slice(sep + 1), 'base64url')
  const iv = body.subarray(0, 12)
  const tag = body.subarray(body.length - 16)
  const ct = body.subarray(12, body.length - 16)
  const d = createDecipheriv('aes-256-gcm', buildKeyV1(), iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function findBin(name, extraDirs = []) {
  for (const dir of (process.env.PATH ?? '').split(delimiter).concat(extraDirs)) {
    if (!dir) continue
    try {
      accessSync(join(dir, name), constants.X_OK)
      return join(dir, name)
    } catch {
      /* keep scanning */
    }
  }
  return null
}

const ARAPUCA = findBin('arapuca', [join(homedir(), '.cargo', 'bin')])
let settings
try {
  settings = JSON.parse(readFileSync(join(homedir(), '.c3', 'settings.json'), 'utf8'))
} catch {
  settings = { agents: [] }
}
function agentByName(name) {
  return (settings.agents || []).find((a) => a.displayName === name)
}

/** 一个 rw worktree 挂载(深层路径,复刻 ~/.c3/worktrees/<proj>/<run>)。 */
function makeWorktree() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'arap-token-')))
  const wt = join(base, '.c3', 'worktrees', 'proj', 'run1')
  mkdirSync(wt, { recursive: true })
  return { base, wt }
}

let exitCode = 5 // 默认 SKIP;claude 成功后置 0,失败置 1

// ─── claude:真实 token 请求 ───────────────────────────────────────────────────

function runClaude() {
  const bin = findBin('claude', ['/opt/homebrew/bin', '/usr/local/bin'])
  const agent = agentByName(CLAUDE_AGENT)
  if (!ARAPUCA || !bin || !agent) {
    console.log(
      `⏭️  SKIP claude — ${!ARAPUCA ? 'arapuca 缺失' : !bin ? 'claude 缺失' : `agent ${CLAUDE_AGENT} 未配置`}`,
    )
    return
  }
  const { baseUrl, model } = agent.config
  const apiKey = decryptSecret(agent.config.apiKey)
  const { wt } = makeWorktree()
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  const rt = `${realpathSync('/tmp')}/claude-${uid}`
  mkdirSync(rt, { recursive: true })
  console.log(`▶ claude via ${CLAUDE_AGENT} (baseUrl=${baseUrl}, model=${model || 'default'})`)
  const args = [
    'run',
    '--seccomp',
    'baseline',
    '--cwd',
    wt,
    '--env',
    `ANTHROPIC_BASE_URL=${baseUrl}`,
    '--env',
    `ANTHROPIC_API_KEY=${apiKey}`,
    '--env',
    `ANTHROPIC_AUTH_TOKEN=${apiKey}`,
    '-v',
    `${wt}:rw`,
    '-v',
    `${rt}:rw`,
    '--',
    bin,
    '-p',
    PROMPT,
    ...(model ? ['--model', model] : []),
  ]
  const r = spawnSync(ARAPUCA, args, { encoding: 'utf8', timeout: 90_000, input: '' })
  const out = (r.stdout || '').trim()
  const err = (r.stderr || '').trim()
  // claude -p 只输出模型回复,不 echo prompt → 命中 SENTINEL 即真实成功。
  const ok = r.status === 0 && SENTINEL.test(out)
  console.log(`  stdout: ${out.slice(0, 200) || '(空)'}`)
  if (err) console.log(`  stderr: ${err.slice(0, 200)}`)
  console.log(ok ? '  ✅ claude 沙箱内真实 token 请求成功' : `  ❌ claude 失败 (exit=${r.status})`)
  exitCode = ok ? 0 : 1
}

// ─── codex:网络 / 认证可达性(真正完成需 c3 relay)──────────────────────────

function runCodex() {
  const bin = findBin('codex', ['/opt/homebrew/bin', '/usr/local/bin'])
  const agent = agentByName(CODEX_AGENT)
  if (!ARAPUCA || !bin || !agent) {
    console.log(
      `⏭️  SKIP codex — ${!ARAPUCA ? 'arapuca 缺失' : !bin ? 'codex 缺失' : `agent ${CODEX_AGENT} 未配置`}`,
    )
    return
  }
  const { baseUrl, model } = agent.config
  const apiKey = decryptSecret(agent.config.apiKey)
  const { wt } = makeWorktree()
  const codexHome = join(wt, '.c3-sb', 'home', '.codex')
  mkdirSync(codexHome, { recursive: true })
  console.log(`▶ codex via ${CODEX_AGENT} (baseUrl=${baseUrl}, model=${model || 'default'})`)
  const args = [
    'run',
    '--seccomp',
    'baseline',
    '--cwd',
    wt,
    '--env',
    `CODEX_HOME=${codexHome}`,
    '--env',
    `OPENAI_API_KEY=${apiKey}`,
    '-v',
    `${wt}:rw`,
    '--',
    bin,
    'exec',
    '--skip-git-repo-check',
    '-c',
    'model_provider=deepseek',
    '-c',
    'model_providers.deepseek.name=deepseek',
    '-c',
    `model_providers.deepseek.base_url=${baseUrl}`,
    '-c',
    'model_providers.deepseek.env_key=OPENAI_API_KEY',
    ...(model ? ['-c', `model=${model}`] : []),
    PROMPT,
  ]
  const r = spawnSync(ARAPUCA, args, { encoding: 'utf8', timeout: 90_000, input: '' })
  const all = `${r.stdout || ''}\n${r.stderr || ''}`
  const netBlocked = /ConnectionRefused|network is unreachable/i.test(all)
  const authRejected = /401|unauthorized|invalid.*key/i.test(all)
  const reached = !netBlocked && !authRejected && /provider|session id|responses|stream/i.test(all)
  console.log(`  ${(r.stdout || '').trim().split('\n').slice(-3).join(' | ').slice(0, 220)}`)
  if (netBlocked) console.log('  ❌ 沙箱网络被禁(应加 --seccomp baseline)')
  else if (authRejected) console.log('  ❌ 认证被拒')
  else if (reached)
    console.log(
      '  ✅ 沙箱网络可达 + 认证被接受(直连 provider 的 Responses API 完成需 c3 relay 适配)',
    )
  else console.log('  ⚠️  结果不明确,见上方输出')
}

// ─── main ──────────────────────────────────────────────────────────────────

console.log('=== Sandbox vendor token E2E ===')
console.log(`arapuca: ${ARAPUCA || '(未找到)'}\n`)
runClaude()
console.log()
runCodex()
console.log(`\n退出码 ${exitCode}(0=claude真实成功, 5=SKIP, 1=FAIL)`)
process.exit(exitCode)
