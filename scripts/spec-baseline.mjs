#!/usr/bin/env node
/**
 * 采集规格纪律对照基线，把四项指标的存量聚合写进 `spec_metrics`（kind='baseline'）。
 *
 * 这是一次性回填，**不随迁移执行**：迁移只负责建表，基线是某一天对存量事实的一次
 * 测量，重跑会按今天的存量再写一行，因此每次写入都带 created_at，可回溯先后。
 *
 * 四项指标与口径（与规格正文「现状基线」表一一对应）：
 *   - `spec_document_count`        存量规格文档总数（规格根下全部 `*.md`，含本 spec 自身）
 *   - `implementation_handoff_sections` 正文含 `Implementation handoff` 独立节的文档数
 *   - `rework_round_distribution`  返工轮次分布，作为轮次上下限的推导输入
 *   - `review_verdict_distribution` 审核结论分布（pass / changes_requested）
 *
 * 另有两项指标**无法**从磁盘与账本回填，只能由盲评测得：中位评审耗时、复述准确率、
 * 边界遗漏、告警误报率。它们由 `--record` 显式写入，脚本不猜测、不用存量数据顶替。
 *
 * 用法：
 *   node scripts/spec-baseline.mjs --db <path> --specs <dir> [--dry-run]
 *   node scripts/spec-baseline.mjs --record <metric>=<value>[@<sampleSize>] [--note <text>]
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function parseArgs(argv) {
  const out = { db: null, specs: null, dryRun: false, record: [], note: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--db') out.db = argv[++i]
    else if (a === '--specs') out.specs = argv[++i]
    else if (a === '--record') out.record.push(argv[++i])
    else if (a === '--note') out.note = argv[++i]
    else if (a === '--help' || a === '-h') out.help = true
    else {
      console.error(`未知参数: ${a}`)
      process.exit(2)
    }
  }
  return out
}

function resolveDbPath(explicit) {
  if (explicit) return resolve(explicit)
  if (process.env.C3_DB_PATH) return resolve(process.env.C3_DB_PATH)
  const home = process.env.C3_DIR ? resolve(process.env.C3_DIR) : join(homedir(), '.c3')
  return join(home, 'c3.db')
}

function openDb(path) {
  if (typeof globalThis.Bun !== 'undefined') {
    const { Database } = require('bun:sqlite')
    const db = new Database(path)
    return {
      all: (sql, ...p) => db.query(sql).all(...p),
      run: (sql, ...p) => db.query(sql).run(...p),
      close: () => db.close(),
    }
  }
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(path)
  return {
    all: (sql, ...p) => db.prepare(sql).all(...p),
    run: (sql, ...p) => db.prepare(sql).run(...p),
    close: () => db.close(),
  }
}

/** 递归收集规格根下的 `*.md`（规格根集中式、不入 Git）。 */
function collectSpecs(root) {
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const abs = join(dir, name)
      let st
      try {
        st = statSync(abs)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(abs)
      else if (name.endsWith('.md')) out.push(abs)
    }
  }
  walk(root)
  return out
}

/** 口径与规格正文一致：精确字符串 `Implementation handoff`，逐文件计一次。 */
const HANDOFF = 'Implementation handoff'

/**
 * 本 spec 正文引用该词会污染计数，因此按规格正文的复现命令排除它自己。存量 18 份
 * 含该节的 spec 不回改——它们是基线数据本身。
 */
const SELF_EXCLUDE = '2026-10-05-001-spec-discipline-ruleset'

const METRICS = {
  spec_document_count: '规格根下存量规格文档总数（全部 `*.md`）',
  implementation_handoff_sections: `正文含 \`${HANDOFF}\` 独立节的文档数（逐文件计一次，排除本 spec 自身）`,
  approved_intents: "账本中 spec_status='approved' 的意图数",
  spec_reviewed_conclusions: 'intent_logs 中 spec_reviewed 结论数（覆盖的不同意图数见样本量口径）',
  changes_requested_share: 'changes_requested 占比 = 需修改结论数 / spec_reviewed 结论数',
  rework_round_distribution: 'spec_review_rework_rounds 分布（0/1/2/3+ 的意图数）',
}

function collect(db, specsRoot) {
  const files = collectSpecs(specsRoot)
  let handoff = 0
  for (const file of files) {
    try {
      if (file.includes(SELF_EXCLUDE)) continue
      if (readFileSync(file, 'utf8').includes(HANDOFF)) handoff += 1
    } catch {
      /* 读不到的文件不计入 */
    }
  }

  const approved =
    db.all("SELECT COUNT(*) AS c FROM intents WHERE spec_status='approved'")[0]?.c ?? 0
  const reviewed =
    db.all("SELECT COUNT(*) AS c FROM intent_logs WHERE operation_type='spec_reviewed'")[0]?.c ?? 0
  const distinct =
    db.all(
      "SELECT COUNT(DISTINCT intent_id) AS c FROM intent_logs WHERE operation_type='spec_reviewed'",
    )[0]?.c ?? 0
  const changes =
    db.all(
      "SELECT COUNT(*) AS c FROM intent_logs WHERE operation_type='spec_reviewed' AND summary LIKE '%需修改%'",
    )[0]?.c ?? 0
  const rounds = db.all(
    'SELECT spec_review_rework_rounds AS r, COUNT(*) AS c FROM intents GROUP BY 1 ORDER BY 1',
  )

  const dist = { 0: 0, 1: 0, 2: 0, '3+': 0 }
  for (const row of rounds) {
    const n = Number(row.r ?? 0)
    if (n >= 3) dist['3+'] += Number(row.c)
    else dist[n] = (dist[n] ?? 0) + Number(row.c)
  }

  return {
    rows: [
      { metric: 'spec_document_count', value: files.length, sampleSize: files.length },
      { metric: 'implementation_handoff_sections', value: handoff, sampleSize: files.length },
      { metric: 'approved_intents', value: approved, sampleSize: approved },
      { metric: 'spec_reviewed_conclusions', value: reviewed, sampleSize: distinct },
      {
        metric: 'changes_requested_share',
        value: reviewed > 0 ? changes / reviewed : 0,
        sampleSize: reviewed,
      },
      {
        metric: 'rework_round_distribution',
        value: Number(dist['3+'] ?? 0),
        sampleSize: Object.values(dist).reduce((a, b) => a + b, 0),
      },
    ],
    detail: { files: files.length, handoff, approved, reviewed, distinct, changes, dist },
  }
}

function write(db, rows, note, dryRun) {
  for (const row of rows) {
    const metricNote = note
      ? `${METRICS[row.metric] ?? row.metric}；${note}`
      : (METRICS[row.metric] ?? '')
    if (dryRun) {
      console.log(`[dry-run] ${row.metric} = ${row.value} (n=${row.sampleSize})`)
      continue
    }
    db.run(
      `INSERT INTO spec_metrics (id, kind, rule_id, message, sample_size, value, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      randomUUID(),
      'baseline',
      row.metric,
      metricNote,
      row.sampleSize,
      row.value,
      Date.now(),
    )
    console.log(`已写入 ${row.metric} = ${row.value} (n=${row.sampleSize})`)
  }
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log(
    '用法: node scripts/spec-baseline.mjs --db <path> --specs <dir> [--dry-run] | --record <metric>=<value>[@<n>] [--note <text>]',
  )
  process.exit(0)
}

// --record 路径：写入盲评实测得到的指标，脚本不猜、不从存量顶替。
if (args.record.length > 0) {
  const dbPath = resolveDbPath(args.db)
  const db = openDb(dbPath)
  const rows = args.record.map((entry) => {
    const [metric, rest] = entry.split('=')
    const [value, sampleSize] = rest.split('@')
    return { metric, value: Number(value), sampleSize: Number(sampleSize ?? 0) }
  })
  write(db, rows, args.note, args.dryRun)
  db.close()
  process.exit(0)
}

if (!args.specs) {
  console.error('需要 --specs <规格根目录>，或改用 --record 写入盲评实测指标。')
  process.exit(2)
}

const db = openDb(resolveDbPath(args.db))
const { rows, detail } = collect(db, args.specs)
console.log('存量事实:', JSON.stringify(detail, null, 2))
write(db, rows, args.note, args.dryRun)
db.close()
