#!/usr/bin/env node
/**
 * arapuca 能力端到端验证 — 独立、不依赖 c3 server。
 *
 * 直接对宿主上的 `arapuca run` 做一组能力探测,验证 c3 sandbox 依赖的
 * 进程级隔离语义是否在当前平台成立:
 *
 *   1. probe        arapuca 二进制存在且可执行(镜像 SandboxLauncher.probeArapuca
 *                   的「c3 管理版本 → 宿主 PATH」解析链,并报告命中来源)。
 *   2. basic        能在沙箱内起进程。
 *   3. rw           `-v <dir>` 可读可写。
 *   4. ro-read      `-v <dir>:ro` 可读。
 *   5. ro-deny      `-v <dir>:ro` 拒写。
 *   6. deny-default 未放行目录不可读(deny-by-default 安全底座)。
 *   7. canonicalize 沙箱内能 canonicalize / chdir 进挂载子目录。
 *                   这一项是 codex 启动的硬门槛:codex 启动即
 *                   `canonicalize(CODEX_HOME)`,失败则整个 run 以 exit 1 崩溃。
 *
 * 关键实现细节:
 *   - 用 argv 数组 spawn arapuca,不经 shell,避免 zsh 把 `"$dir:ro"` 误当成
 *     `:r`(去扩展名)修饰符而把挂载路径改成 `<dir>o`。
 *   - 沙箱内程序的产出一律写进已放行的 rw 挂载文件、再由宿主读取,而非依赖
 *     子进程 stdout(macOS Seatbelt 下部分工具写继承 stdout 会 EPERM)。
 *
 * 二进制来源镜像 SandboxLauncher 的解析链:
 *   managed    ~/.c3/sandbox/arapuca/current 指向的 c3 管理版本(优先)。
 *   host-path  宿主 PATH / ~/.cargo/bin 上使用方自装的二进制(兜底)。
 * 显式传入路径时来源记为 explicit。`--source=managed|host-path` 可强制只验证
 * 某一条链,该链不可用时以 SKIP(退出码 5)结束,便于 CI 分别覆盖两种场景。
 *
 * 用法:
 *   node scripts/e2e/e2e-arapuca-capability-test.mjs [/abs/path/to/arapuca]
 *   node scripts/e2e/e2e-arapuca-capability-test.mjs --source=managed
 *   node scripts/e2e/e2e-arapuca-capability-test.mjs --source=host-path
 *
 * 退出码:所有 MUST 项通过则 0;任一 MUST 失败则 1;二进制缺失 2;
 * 指定来源不可用 5(SKIP)。canonicalize 与 /tmp 两项作为平台能力门禁单独标注。
 */
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
  rmSync,
  readdirSync,
  accessSync,
  constants as fsConstants,
} from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, delimiter } from 'node:path'

// ─── arapuca 定位(镜像 SandboxLauncher 的解析链)────────────────────────────

/** c3 管理版本:~/.c3/sandbox/arapuca/current 指向的目录内的可执行文件。 */
function findManagedArapuca() {
  const root = join(homedir(), '.c3', 'sandbox', 'arapuca')
  let target
  try {
    target = realpathSync(join(root, 'current'))
  } catch {
    return null // 未安装或断链
  }
  // 归档内层目录名随版本变化,不硬编码版本号:取 current 下唯一的 arapuca[.exe]。
  const exe = process.platform === 'win32' ? 'arapuca.exe' : 'arapuca'
  for (const rel of [exe, join(`arapuca-${target.split(/[\\/]/).pop()}`, exe)]) {
    const candidate = join(target, rel)
    try {
      accessSync(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      // 继续尝试下一种布局
    }
  }
  // 兜底:扫一层子目录(上游归档统一形如 arapuca-<version>/arapuca)。
  let entries
  try {
    entries = readdirSync(target)
  } catch {
    return null // current 指向的不是目录
  }
  for (const entry of entries) {
    const candidate = join(target, entry, exe)
    try {
      accessSync(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      // keep scanning
    }
  }
  return null
}

/** 宿主 PATH(外加 cargo 默认安装位置)上的 arapuca。 */
function findHostPathArapuca() {
  const dirs = (process.env.PATH ?? '').split(delimiter)
  // c3 server 常从登录 shell 继承更全的 PATH;补上 cargo 默认安装位置。
  dirs.push(join(homedir(), '.cargo', 'bin'))
  for (const dir of dirs) {
    if (!dir) continue
    const candidate = join(dir, 'arapuca')
    try {
      accessSync(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      // keep scanning
    }
  }
  return null
}

/** 解析要验证的二进制及其来源,顺序与 SandboxLauncher.probeArapuca 一致。 */
function findArapuca() {
  const explicit = process.argv.slice(2).find((a) => !a.startsWith('--'))
  if (explicit) {
    try {
      accessSync(explicit, fsConstants.X_OK)
      return { bin: explicit, source: 'explicit' }
    } catch {
      fail(`指定的 arapuca 不可执行: ${explicit}`)
    }
  }
  const wanted = (process.argv.find((a) => a.startsWith('--source=')) ?? '').split('=')[1]
  const managed = findManagedArapuca()
  const hostPath = findHostPathArapuca()
  if (wanted === 'managed') {
    if (!managed)
      skip('未找到 c3 管理版本(~/.c3/sandbox/arapuca/current);启动 c3 让其后台安装后重试。')
    return { bin: managed, source: 'managed' }
  }
  if (wanted === 'host-path') {
    if (!hostPath) skip('宿主 PATH / ~/.cargo/bin 上没有 arapuca。')
    return { bin: hostPath, source: 'host-path' }
  }
  if (wanted) fail(`未知 --source=${wanted}(可选 managed | host-path)`)
  // 默认:与 probeArapuca 同序——管理版本优先,PATH 兜底。
  if (managed) return { bin: managed, source: 'managed' }
  if (hostPath) return { bin: hostPath, source: 'host-path' }
  return { bin: null, source: null }
}

// ─── 运行器 ────────────────────────────────────────────────────────────────

let ARAPUCA = ''

/** 以 argv 数组运行 `arapuca run <runArgs> -- <cmd...>`,返回 {code, stdout, stderr}。 */
function arapucaRun(runArgs, cmd) {
  const r = spawnSync(ARAPUCA, ['run', ...runArgs, '--', ...cmd], {
    encoding: 'utf-8',
    timeout: 30_000,
  })
  return {
    code: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
  }
}

// ─── 报告 ──────────────────────────────────────────────────────────────────

const results = []
// pass: true=PASS, false=FAIL(MUST)/LIMIT(非MUST), null=SKIP(前置条件缺失,不计入统计)。
function record(name, must, pass, detail) {
  results.push({ name, must, pass, detail })
  const tag = pass === null ? '  ⏭️  SKIP' : pass ? '  ✅ PASS' : must ? '  ❌ FAIL' : '  ⚠️  LIMIT'
  console.log(`${tag}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 在 PATH + 常见宿主位置找一个可执行文件。 */
function findBin(name, extraDirs = []) {
  const dirs = (process.env.PATH ?? '').split(delimiter).concat(extraDirs)
  for (const dir of dirs) {
    if (!dir) continue
    const candidate = join(dir, name)
    try {
      accessSync(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      // keep scanning
    }
  }
  return null
}
function fail(msg) {
  console.error(`\n[fatal] ${msg}`)
  process.exit(2)
}
/** 前置条件不满足(如指定来源不存在):不是失败,按 e2e 约定退出 5。 */
function skip(msg) {
  console.log(`\n[skip] ${msg}`)
  process.exit(5)
}

// ─── 主流程 ────────────────────────────────────────────────────────────────

console.log('=== arapuca 能力端到端验证 ===\n')

const located = findArapuca()
ARAPUCA = located.bin
if (!ARAPUCA) {
  fail(
    '两条解析链都没有 arapuca:既无 c3 管理版本(~/.c3/sandbox/arapuca/current),' +
      '宿主 PATH / ~/.cargo/bin 上也没有。启动 c3 触发后台安装,或自行安装后重试。',
  )
}
// `arapuca --version` 以非零码退出但会把版本打到 stdout;直接读输出,不看退出码。
const verProc = spawnSync(ARAPUCA, ['--version'], { encoding: 'utf-8' })
const version = ((verProc.stdout || '') + (verProc.stderr || '')).trim().split('\n')[0]
console.log(`arapuca 二进制: ${ARAPUCA}`)
console.log(`来源: ${located.source}`)
console.log(`版本: ${version}`)
console.log(`平台: ${process.platform}\n`)
record(
  `probe: 二进制可执行 + --version (来源 ${located.source})`,
  true,
  /arapuca\s+\d/.test(version),
  version,
)

// 工作区:一个 rw 挂载(worktree 代理)、一个 ro 挂载(项目原目录代理)、
// 一个未放行的 secret(deny-by-default 代理)。
// canonicalize:c3 的 resolvePaths 用 realpathSync 挂载路径。macOS 上 /var 是
// 指向 /private/var 的 firmlink,若按未解析路径挂载,kernel 解析后的目标与放行
// 的 subpath 不匹配会导致 EPERM。此处对齐 c3 语义,消除 firmlink 干扰。
const base = realpathSync(mkdtempSync(join(tmpdir(), 'arap-e2e-')))
const RW = join(base, 'rw')
const RO = join(base, 'ro')
const SECRET = join(base, 'secret')
mkdirSync(RW, { recursive: true })
mkdirSync(join(RW, 'sub', 'deep'), { recursive: true }) // 供 canonicalize 项使用
mkdirSync(RO, { recursive: true })
mkdirSync(SECRET, { recursive: true })
writeFileSync(join(RO, 'base.txt'), 'ro-baseline\n')
writeFileSync(join(SECRET, 'creds.txt'), 'top-secret\n')

/** 读回宿主侧 rw 挂载内的产出文件(沙箱产出的可靠通道)。 */
const outPath = join(RW, 'out.txt')
function readOut() {
  try {
    return readFileSync(outPath, 'utf-8')
  } catch {
    return null
  }
}
function clearOut() {
  try {
    rmSync(outPath, { force: true })
  } catch {
    /* ignore */
  }
}

try {
  // 2. basic —— 能起进程
  {
    const r = arapucaRun(['-v', RW, '--cwd', RW], ['/bin/echo', 'arapuca-ok'])
    record(
      'basic: 沙箱内起进程 (echo)',
      true,
      r.code === 0 && r.stdout === 'arapuca-ok',
      `code=${r.code}`,
    )
  }

  // 3. rw —— 写 + 读回
  {
    clearOut()
    const r = arapucaRun(
      ['-v', RW, '--cwd', RW],
      ['/bin/sh', '-c', `printf write-ok > '${outPath}'`],
    )
    const back = readOut()
    record(
      'rw: 挂载内可写并读回',
      true,
      r.code === 0 && back === 'write-ok',
      `back=${JSON.stringify(back)}`,
    )
  }

  // 4. ro-read —— ro 挂载可读(把内容拷进 rw 再由宿主校验)
  {
    clearOut()
    const r = arapucaRun(
      ['-v', RW, '-v', `${RO}:ro`, '--cwd', RW],
      ['/bin/sh', '-c', `cat '${join(RO, 'base.txt')}' > '${outPath}'`],
    )
    const back = readOut()
    record(
      'ro-read: :ro 挂载可读',
      true,
      r.code === 0 && back === 'ro-baseline\n',
      `back=${JSON.stringify(back)}`,
    )
  }

  // 5. ro-deny —— ro 挂载拒写
  {
    const target = join(RO, 'hack.txt')
    const r = arapucaRun(
      ['-v', RW, '-v', `${RO}:ro`, '--cwd', RW],
      ['/bin/sh', '-c', `echo hack > '${target}'`],
    )
    const blocked = r.code !== 0 && !existsSync(target)
    record('ro-deny: :ro 挂载拒写', true, blocked, `code=${r.code}, created=${existsSync(target)}`)
  }

  // 6. deny-default —— 未放行目录不可读
  {
    clearOut()
    const r = arapucaRun(
      ['-v', RW, '--cwd', RW],
      ['/bin/sh', '-c', `cat '${join(SECRET, 'creds.txt')}' > '${outPath}' 2>/dev/null`],
    )
    const back = readOut()
    const blocked = r.code !== 0 && (back === null || !back.includes('top-secret'))
    record('deny-default: 未放行目录不可读', true, blocked, `code=${r.code}`)
  }

  // 7. canonicalize / chdir —— codex 启动硬门槛
  //    codex 启动即 canonicalize(CODEX_HOME);等价探测:能否 chdir 进挂载子目录。
  //    macOS arapuca 0.2.4:Seatbelt profile 只放行挂载点 subpath,未放行祖先目录
  //    的遍历权限 → chdir/realpath 对任何挂载路径失败 → codex exit 1。
  {
    const deep = join(RW, 'sub', 'deep')
    const r = arapucaRun(['-v', RW, '--cwd', RW], ['/bin/sh', '-c', `cd '${deep}'`])
    const canCanonicalize = r.code === 0
    record(
      'canonicalize: 沙箱内可 chdir/realpath 进挂载子目录 (codex 启动门槛)',
      false, // 非 MUST:标为平台能力门禁,失败时明确提示这是 codex 阻断点
      canCanonicalize,
      canCanonicalize
        ? 'OK'
        : `chdir 失败 (${(r.stderr || '').split('\n').pop()}) — codex canonicalize(CODEX_HOME) 将失败`,
    )
  }

  // 8. vendor CLI 启动探测 —— claude / codex 能否在沙箱内、深层 worktree cwd 下起来。
  //    token-free:只跑 `<bin> --version`。真实 turn 需认证 + 花 token,不在此列。
  //    找不到二进制则 SKIP。深层 cwd 正是 canonicalize 补丁修复价值的体现。
  for (const vendor of ['claude', 'codex']) {
    const bin = findBin(vendor, ['/opt/homebrew/bin', '/usr/local/bin'])
    if (!bin) {
      record(`vendor:${vendor} 沙箱内 --version`, false, null, '宿主未装该 CLI,跳过')
      continue
    }
    const deep = join(RW, 'sub', 'deep')
    const r = arapucaRun(['-v', RW, '--cwd', deep], [bin, '--version'])
    const ok = r.code === 0 && /\d+\.\d+/.test(r.stdout)
    record(
      `vendor:${vendor} 沙箱内 --version (深层 cwd)`,
      false,
      ok,
      ok ? r.stdout.split('\n')[0] : `code=${r.code} ${(r.stderr || '').split('\n').pop()}`,
    )
  }

  // 9. /tmp symlink 门槛 —— claude 硬编码把运行时目录建在 /tmp/claude-<uid>。
  //    /tmp 是指向 /private/tmp 的 symlink;若 profile 未放行 /tmp 入口,claude
  //    的 `mkdir /tmp/claude-<uid>` 会 EPERM(即便放行了 canonical /private/tmp)。
  //    arapuca 锁定 TMPDIR、claude 不尊重 TMPDIR,故无法用 env 重定向绕开。
  {
    const r = arapucaRun(['-v', RW, '--cwd', RW], ['/bin/sh', '-c', 'ls -ld /tmp'])
    const ok = r.code === 0
    record(
      'tmp-symlink: /tmp 可解析 (claude 运行时目录门槛)',
      false,
      ok,
      ok ? 'OK' : '/tmp symlink 不可解析 — claude mkdir /tmp/claude-<uid> 将 EPERM',
    )
  }
} finally {
  try {
    rmSync(base, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}

// ─── 汇总 ──────────────────────────────────────────────────────────────────

// pass===false 计为未通过;pass===null(SKIP)不计入。
const mustFailed = results.filter((r) => r.must && r.pass === false)
const limits = results.filter((r) => !r.must && r.pass === false)
const skipped = results.filter((r) => r.pass === null)

console.log('\n=== 汇总 ===')
console.log(`MUST 项: ${results.filter((r) => r.must).length}, 失败 ${mustFailed.length}`)
if (skipped.length) {
  console.log(`跳过(前置条件缺失): ${skipped.map((r) => r.name.split(/[:：]/)[0]).join(', ')}`)
}
if (limits.length) {
  console.log(`平台能力门禁未通过: ${limits.map((r) => r.name.split(/[:：]/)[0]).join(', ')}`)
  console.log(
    '  → 逐行 detail 已说明各门禁对哪个 vendor 启动的影响(canonicalize→codex,tmp→claude)。',
  )
}
if (mustFailed.length) {
  console.log('\n结论: arapuca 基础隔离能力不完整,sandbox 不可用。')
  process.exit(1)
}
console.log('\n结论: arapuca 基础隔离能力(rw/ro/deny)正常。')
process.exit(0)
