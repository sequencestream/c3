#!/usr/bin/env node
/**
 * 多 base 建 PR 行为验证（可重跑实验脚本）。
 *
 * 目标：分别对 `gh`（GitHub）与 `glab`（GitLab）验证「同一 head 分支、两个不同
 * base 分支」能否同时保持开放状态的 PR/MR——这是 M1 将单条意图上的
 * pr_id/pr_url/pr_status 拆为多 PR 关系时 `UNIQUE(forge, repo, number)` 唯一键
 * 成立的前提。
 *
 * 使用方式（仓库 / 分支全部显式传入，绝不默认操作当前生产仓库）：
 *   node scripts/verify-multi-base-pr.mjs \
 *     --github-repo owner/repo [--gitlab-repo owner/repo] \
 *     --head feature/x --base-a main --base-b develop \
 *     [--label c3-multibase-verify] [--out result.json] [--cleanup] [--dry-run]
 *
 * 也可用环境变量 GITHUB_REPO / GITLAB_REPO / HEAD_BRANCH / BASE_A / BASE_B /
 * C3_MULTIBASE_LABEL 传入；命令行参数优先。
 *
 * 行为约定（对齐 spec 的 F4 实验）：
 *   1. 前置检查：CLI 是否安装、是否已认证、远端仓库是否可访问、head/base-a/base-b
 *      三个分支是否存在于远端。任一前置失败 → 该 forge 记 SKIP + 原因，不制造任何
 *      请求。
 *   2. 幂等复用：创建前先按「head + 脚本唯一标记（label）」检索本脚本既有实验请求；
 *      已存在的复用、只补缺失的，绝不因「已存在」误报失败或继续制造重复请求。
 *   3. 每条创建都保存：命令、CLI 版本、返回码、标准化后的 number/URL/base/head，
 *      以及创建后的远端复核结果。中途失败也输出已创建资源便于人工清理 / 再次运行。
 *   4. 每 forge 独立判定 PASS / FAIL / SKIP + 原因。PASS 仅当两个请求都存在、head
 *      一致、base 分别匹配 base-a/base-b、且可同时保持开放。一个 forge 缺失或未认证
 *      只使该 forge SKIP；当一端 SKIP 时整体结果不会宣称「两端均支持」。
 *   5. 默认不删除远端分支或请求。`--cleanup` 显式清理时才关闭带脚本唯一标记且属于
 *      本次实验的请求，且执行前打印目标清单；`--dry-run` 只列出不执行。
 *
 * 退出码：0 = 全部已配置且可验证的 forge 均 PASS（允许另一端 SKIP，但会显式提示不
 * 得宣称两端均支持）；1 = 任一 forge FAIL；2 = 无一 PASS（全部 SKIP，未验证任何东西）。
 */

import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 结果文件默认写到系统临时目录，避免在仓库内留下生成物污染 diff；需要固定位置时用 `--out`。
const DEFAULT_OUT = join(tmpdir(), 'verify-multi-base-pr.result.json')
const DEFAULT_LABEL = 'c3-multibase-verify'
// 标题标记模板：保持稳定（同 label + head + base 幂等复用），不掺时间戳。
const markerTitle = (label, head, base) => `[${label}] head=${head} base=${base}`

// ---------------------------------------------------------------------------
// 参数解析：`--flag value`，支持 GITHUB_REPO / GITLAB_REPO / HEAD_BRANCH /
// BASE_A / BASE_B / C3_MULTIBASE_LABEL 环境变量兜底。
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const env = process.env
  const args = { githubRepo: null, gitlabRepo: null, head: null, baseA: null, baseB: null }
  const strings = {
    '--github-repo': 'githubRepo',
    '--gitlab-repo': 'gitlabRepo',
    '--head': 'head',
    '--base-a': 'baseA',
    '--base-b': 'baseB',
    '--label': 'label',
    '--out': 'out',
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (strings[a]) {
      args[strings[a]] = argv[++i]
      continue
    }
    if (a === '--cleanup') args.cleanup = true
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--help' || a === '-h') {
      printUsage()
      process.exit(0)
    } else {
      console.error(`未知参数: ${a}`)
      printUsage()
      process.exit(2)
    }
  }
  if (args.githubRepo == null) args.githubRepo = env.GITHUB_REPO ?? null
  if (args.gitlabRepo == null) args.gitlabRepo = env.GITLAB_REPO ?? null
  if (args.head == null) args.head = env.HEAD_BRANCH ?? null
  if (args.baseA == null) args.baseA = env.BASE_A ?? null
  if (args.baseB == null) args.baseB = env.BASE_B ?? null
  if (args.label == null) args.label = env.C3_MULTIBASE_LABEL ?? DEFAULT_LABEL
  if (args.out == null) args.out = DEFAULT_OUT
  return args
}

function printUsage() {
  console.log(
    `用法:
  node scripts/verify-multi-base-pr.mjs \\
    --github-repo owner/repo [--gitlab-repo owner/repo] \\
    --head <branch> --base-a <branch> --base-b <branch> \\
    [--label <标记>] [--out <结果JSON>] [--cleanup] [--dry-run]

环境变量兜底: GITHUB_REPO GITLAB_REPO HEAD_BRANCH BASE_A BASE_B C3_MULTIBASE_LABEL`,
  )
}

// ---------------------------------------------------------------------------
// 通用 shell 工具
// ---------------------------------------------------------------------------
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts })
  const rc = res.status ?? (res.error ? -1 : -2)
  return { rc, stdout: (res.stdout ?? '').trim(), stderr: (res.stderr ?? '').trim() }
}

/** 把任意文本安全截断到一行的展示长度。 */
function clip(s, n = 100) {
  const one = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return one.length > n ? `${one.slice(0, n - 3)}…` : one
}

/**
 * 瞬态网络错误判定。gh/glab 走 GitHub GraphQL / REST 时偶发 `unexpected EOF`、
 * `connection reset`、超时、429 / 5xx——这些都是可重试的瞬时故障，不能把一次抖动
 * 误判成实验 FAIL（F4 实测与 F3 存量审计都观察到同类 EOF）。
 */
function isTransientNetworkError(res) {
  if (res.rc === -1) return true // spawn 失败（如进程被杀）不重试语义；保守仅当无 stdout 时
  const text = `${res.stderr} ${res.stdout}`
  return /unexpected EOF|\bEOF\b|connection (reset|refused)|timed? ?out|tls|5\d\d|429|too many request|rate ?limit/i.test(
    text,
  )
}

/** 带瞬态重试的 run：网络类失败退避重试 retries 次，返回最后一次结果。 */
function runWithRetry(cmd, args, { retries = 4, opts = {} } = {}) {
  let res = run(cmd, args, opts)
  for (let attempt = 0; attempt < retries && isTransientNetworkError(res); attempt++) {
    const delay = 800 * (attempt + 1)
    // 同步脚本内的阻塞等待：借用 `sleep` 子进程（spawnSync 同步阻塞）。
    spawnSync('sleep', [String(delay / 1000)], { encoding: 'utf8' })
    res = run(cmd, args, opts)
  }
  return res
}

// ---------------------------------------------------------------------------
// 前置检查
// ---------------------------------------------------------------------------
function preflight(cli, repo, head, baseA, baseB, log) {
  const missing = []
  const v = run(cli, ['--version'])
  if (v.rc !== 0)
    return { ok: false, version: '', reason: `CLI 未安装或不可用: ${clip(v.stderr || v.stdout)}` }
  log.push(`CLI ${cli} 版本: ${clip(v.stdout, 200)}`)

  const auth = run(cli, ['auth', 'status'])
  if (auth.rc !== 0) {
    return { ok: false, reason: `未认证: ${clip(auth.stderr || auth.stdout)}` }
  }
  log.push(`CLI ${cli} 认证: ok`)

  if (!/^[^/]+\/[^/]+$/.test(repo)) {
    return { ok: false, reason: `repo 参数非法（应为 owner/name）: ${repo}` }
  }

  // 远端仓库可访问性单独检查（与分支缺失区分开，避免把「仓库不可访问」误报为「分支缺失」）。
  const repoCheck =
    cli === 'gh'
      ? runWithRetry('gh', ['repo', 'view', repo, '--json', 'nameWithOwner'])
      : runWithRetry('glab', ['repo', 'view', repo])
  if (repoCheck.rc !== 0) {
    return {
      ok: false,
      reason: `远端仓库不可访问或不存在: ${clip(repoCheck.stderr || repoCheck.stdout)}`,
    }
  }
  log.push(`远端仓库 ${repo}: 可访问`)

  const branchExists =
    cli === 'gh'
      ? (b) => runWithRetry('gh', ['api', `repos/${repo}/branches/${b}`, '--jq', '.name']).rc === 0
      : (b) =>
          runWithRetry('glab', [
            'api',
            `projects/${repo.replace('/', '%2F')}/repository/branches/${encodeURIComponent(b)}`,
          ]).rc === 0
  for (const b of [head, baseA, baseB]) {
    const ok = branchExists(b)
    log.push(`分支 ${b}: ${ok ? '存在' : '不存在'}`)
    if (!ok) missing.push(b)
  }
  if (missing.length > 0) {
    return { ok: false, reason: `远端分支缺失: ${missing.join(', ')}` }
  }
  return { ok: true, version: v.stdout }
}

// ---------------------------------------------------------------------------
// 检索本脚本既有实验请求（幂等复用）
// ---------------------------------------------------------------------------
function discoverExisting(cli, repo, head, label) {
  let rows
  if (cli === 'gh') {
    const r = runWithRetry('gh', [
      'pr',
      'list',
      '--repo',
      repo,
      '--head',
      head,
      '--state',
      'all',
      '--json',
      'number,title,url,state,baseRefName,headRefName',
    ])
    if (r.rc !== 0) return { ok: false, rows: [], error: clip(r.stderr || r.stdout) }
    try {
      rows = JSON.parse(r.stdout)
    } catch {
      return { ok: false, rows: [], error: 'gh pr list 输出不是有效 JSON' }
    }
  } else {
    const r = runWithRetry('glab', [
      'mr',
      'list',
      '--repo',
      repo,
      '--source-branch',
      head,
      '--all',
      '--output',
      'json',
    ])
    if (r.rc !== 0) return { ok: false, rows: [], error: clip(r.stderr || r.stdout) }
    let parsed
    try {
      parsed = JSON.parse(r.stdout)
    } catch {
      return { ok: false, rows: [], error: 'glab mr list 输出不是有效 JSON' }
    }
    rows = (parsed ?? []).map((m) => ({
      number: m.iid ?? m.number,
      title: m.title,
      url: m.web_url,
      state: m.state, // 'opened' | 'merged' | 'closed'
      baseRefName: m.target_branch ?? m.targetBranch,
      headRefName: m.source_branch ?? m.sourceBranch,
    }))
  }
  // 只认带本脚本标记的请求。
  const mine = rows.filter((r) => r.title?.includes(`[${label}]`))
  return { ok: true, rows: mine }
}

/** 某 base 的请求是否已存在（按标题标记匹配）。 */
function findByBase(rows, label, head, base) {
  return rows.find((r) => r.title === markerTitle(label, head, base)) ?? null
}

// ---------------------------------------------------------------------------
// 创建单个请求
// ---------------------------------------------------------------------------
function createRequest(cli, repo, head, base, title, body) {
  const args =
    cli === 'gh'
      ? [
          'pr',
          'create',
          '--repo',
          repo,
          '--base',
          base,
          '--head',
          head,
          '--title',
          title,
          '--body',
          body,
        ]
      : [
          'mr',
          'create',
          '--repo',
          repo,
          '--target-branch',
          base,
          '--source-branch',
          head,
          '--title',
          title,
          '--description',
          body,
        ]
  return { args, res: run(cli, args) }
}

/** 解析创建命令输出得到 number（gh 输出 URL，glab 输出 URL）。 */
function parseCreated(cli, stdout, stderr) {
  const text = stdout || stderr || ''
  if (cli === 'gh') {
    const m = text.match(/\/pull\/(\d+)/)
    return m ? { number: m[1], url: stdout || text } : null
  }
  const m = text.match(/merge_requests\/(\d+)/)
  return m ? { number: m[1], url: stdout || text } : null
}

/** 复核单个请求的远端状态。 */
function verifyRequest(cli, repo, number) {
  if (cli === 'gh') {
    const r = runWithRetry('gh', [
      'pr',
      'view',
      String(number),
      '--repo',
      repo,
      '--json',
      'number,state,baseRefName,headRefName,url,createdAt',
    ])
    if (r.rc !== 0) return { ok: false, error: clip(r.stderr || r.stdout) }
    try {
      const j = JSON.parse(r.stdout)
      return {
        ok: true,
        number: String(j.number),
        state: j.state,
        base: j.baseRefName,
        head: j.headRefName,
        url: j.url,
      }
    } catch {
      return { ok: false, error: 'gh pr view 输出不是有效 JSON' }
    }
  }
  const r = runWithRetry('glab', ['mr', 'view', String(number), '--repo', repo, '--output', 'json'])
  if (r.rc !== 0) return { ok: false, error: clip(r.stderr || r.stdout) }
  try {
    const j = JSON.parse(r.stdout)
    return {
      ok: true,
      number: String(j.iid ?? j.number),
      state: j.state, // opened/merged/closed
      base: j.target_branch ?? j.targetBranch,
      head: j.source_branch ?? j.sourceBranch,
      url: j.web_url,
    }
  } catch {
    return { ok: false, error: 'glab mr view 输出不是有效 JSON' }
  }
}

const OPEN_STATES = { gh: 'OPEN', glab: 'opened' }

// ---------------------------------------------------------------------------
// 单 forge 主流程
// ---------------------------------------------------------------------------
function runForge(cli, repo, cfg) {
  const { head, baseA, baseB, label, cleanup, dryRun } = cfg
  const log = []
  const outcome = {
    forge: cli,
    repo,
    verdict: null,
    reason: '',
    cliVersion: null,
    requests: [],
    cleanup: [],
  }

  // 1. 前置检查
  const pf = preflight(cli, repo, head, baseA, baseB, log)
  if (!pf.ok) {
    outcome.verdict = 'SKIP'
    outcome.reason = pf.reason
    return { outcome, log }
  }
  outcome.cliVersion = pf.version

  // 2. 幂等发现
  const disc = discoverExisting(cli, repo, head, label)
  if (!disc.ok) {
    outcome.verdict = 'FAIL'
    outcome.reason = `发现既有请求失败: ${disc.error}`
    return { outcome, log }
  }

  // 3. 创建缺失请求（已存在的仅当仍 OPEN 才复用；关闭/合并过的视为过期，另建新的，
  //    使「运行 → --cleanup → 再运行」可不断获得新鲜的 PASS，而不是被旧请求永久 FAIL）。
  for (const base of [baseA, baseB]) {
    const existing = findByBase(disc.rows, label, head, base)
    if (existing && existing.state === OPEN_STATES[cli]) {
      outcome.requests.push({
        base,
        number: String(existing.number),
        url: existing.url,
        created: false,
        reused: true,
      })
      log.push(`复用已有 ${cli} 请求 #${existing.number} (base=${base})`)
      continue
    }
    const title = markerTitle(label, head, base)
    const body = `c3 多 base 验证脚本自动创建（${label}）。head=${head} base=${base}，非人工提交。`
    log.push(`创建 ${cli} 请求: base=${base}`)
    const { args: cmdArgs, res: cmd } = createRequest(cli, repo, head, base, title, body)
    const parsed = parseCreated(cli, cmd.stdout, cmd.stderr)
    // 每条创建都保存：命令、返回码与解析结果（含 CLI 版本在 outcome 层）。
    const record = { base, command: cmdArgs.join(' '), rc: cmd.rc }
    if (cmd.rc !== 0 || !parsed) {
      outcome.verdict = 'FAIL'
      outcome.reason =
        `创建失败 (rc=${cmd.rc}): ${clip(cmd.stderr || cmd.stdout)}` +
        (parsed ? `; 已创建但无法解析 number: ${clip(cmd.stdout)}` : '')
      // 中途失败也要带出已创建资源。
      if (parsed)
        outcome.requests.push({ ...record, number: parsed.number, url: parsed.url, created: true })
      return { outcome, log }
    }
    outcome.requests.push({ ...record, number: parsed.number, url: parsed.url, created: true })
  }

  // 4. 逐条远端复核
  for (const req of outcome.requests) {
    const v = verifyRequest(cli, repo, req.number)
    if (!v.ok) {
      outcome.verdict = 'FAIL'
      outcome.reason = `复核 #${req.number} 失败: ${v.error}`
      return { outcome, log }
    }
    req.verify = { state: v.state, base: v.base, head: v.head, url: v.url }
    log.push(`复核 #${req.number}: state=${v.state} base=${v.base} head=${v.head}`)
  }

  // 5. 判定
  const a = outcome.requests.find((r) => r.base === baseA)
  const b = outcome.requests.find((r) => r.base === baseB)
  const okBoth = a && b
  const baseMatch = a?.verify?.base === baseA && b?.verify?.base === baseB
  const headMatch = (a?.verify?.head ?? head) === head && (b?.verify?.head ?? head) === head
  const bothOpen = a?.verify?.state === OPEN_STATES[cli] && b?.verify?.state === OPEN_STATES[cli]

  if (okBoth && baseMatch && headMatch && bothOpen) {
    outcome.verdict = 'PASS'
    outcome.reason = `head=${head} 可在 base=${baseA} 与 base=${baseB} 同时保持开放`
  } else if (!okBoth) {
    outcome.verdict = 'FAIL'
    outcome.reason = `存在性不满足: baseA=${a?.number ?? '缺'} baseB=${b?.number ?? '缺'}`
  } else {
    outcome.verdict = 'FAIL'
    outcome.reason = `约束不满足: base匹配=${baseMatch} head匹配=${headMatch} 同时开放=${bothOpen}`
  }

  // 6. cleanup（仅显式启用；执行前总是打印目标，dry-run 只列不执行）
  if (cleanup) {
    for (const req of outcome.requests) {
      outcome.cleanup.push({ number: req.number, url: req.url })
    }
    log.push(
      `${dryRun ? '[cleanup dry-run] 将关闭的请求' : '[cleanup] 即将关闭的请求'}: ` +
        outcome.cleanup.map((c) => `#${c.number}`).join(', '),
    )
    if (dryRun) {
      // 仅列出，不执行。
    } else {
      for (const req of outcome.cleanup) {
        const close =
          cli === 'gh'
            ? run('gh', ['pr', 'close', req.number, '--repo', repo])
            : run('glab', ['mr', 'close', req.number, '--repo', repo])
        log.push(
          close.rc === 0
            ? `已关闭 #${req.number}`
            : `关闭 #${req.number} 失败 (rc=${close.rc}): ${clip(close.stderr || close.stdout)}`,
        )
        req.closed = close.rc === 0
        if (close.rc !== 0) outcome.cleanupFailed = true
      }
    }
  }

  return { outcome, log }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------
function main() {
  const cfg = parseArgs(process.argv.slice(2))

  const configured = []
  if (cfg.githubRepo) configured.push({ cli: 'gh', repo: cfg.githubRepo })
  if (cfg.gitlabRepo) configured.push({ cli: 'glab', repo: cfg.gitlabRepo })
  if (configured.length === 0) {
    console.error('必须至少提供 --github-repo 或 --gitlab-repo（或对应环境变量）')
    printUsage()
    process.exit(2)
  }
  if (!cfg.head || !cfg.baseA || !cfg.baseB) {
    console.error('必须提供 --head / --base-a / --base-b（或 HEAD_BRANCH / BASE_A / BASE_B）')
    printUsage()
    process.exit(2)
  }
  if (cfg.baseA === cfg.baseB) {
    console.error('--base-a 与 --base-b 必须不同')
    process.exit(2)
  }
  if (cfg.baseA === cfg.head || cfg.baseB === cfg.head) {
    console.error('head 分支不能与任一 base 分支相同')
    process.exit(2)
  }

  const results = []
  for (const { cli, repo } of configured) {
    const { outcome, log } = runForge(cli, repo, cfg)
    results.push(outcome)
    console.log(`\n===== ${cli} @ ${repo} → ${outcome.verdict} =====`)
    for (const line of log) console.log(`  ${line}`)
    console.log(`  结论: ${outcome.reason}`)
  }

  const verdicts = results.map((r) => r.verdict)
  const hasFail = verdicts.includes('FAIL')
  const hasPass = verdicts.includes('PASS')
  const allSkip = verdicts.every((v) => v === 'SKIP')

  console.log('\n===== 汇总 =====')
  for (const r of results) console.log(`  ${r.forge}: ${r.verdict} — ${r.reason}`)
  // 任一显式 cleanup 关闭失败 → 非零退出（资源定位信息保留在 outcome.cleanup/JSON 中）。
  if (results.some((r) => r.cleanupFailed)) {
    console.log('  cleanup 存在失败，请核对未关闭的请求（见结果 JSON）。')
    process.exitCode = 1
  } else if (hasFail) {
    console.log('  存在 FAIL，未通过验证。')
    process.exitCode = 1
  } else if (allSkip) {
    console.log('  全部 SKIP（前置条件缺失），未验证任何 forge。')
    process.exitCode = 2
  } else if (hasPass && verdicts.includes('SKIP')) {
    console.log('  至少一端 PASS、另一端 SKIP：结果不得宣称「两端均支持」。')
    process.exitCode = 0
  } else {
    console.log('  所有已配置 forge 均 PASS。')
    process.exitCode = 0
  }

  try {
    writeFileSync(
      cfg.out,
      JSON.stringify({ label: cfg.label, at: new Date().toISOString(), results }, null, 2),
    )
    console.log(`\n结果已写入: ${cfg.out}`)
  } catch (err) {
    console.warn(`\n结果写入 ${cfg.out} 失败: ${err.message}`)
  }
}

main()
