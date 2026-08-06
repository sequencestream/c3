#!/usr/bin/env node
/**
 * PR 拆表的回退脚本：把 `intent_prs` 的事实投影回 `intents` 的旧三列
 * (`pr_id` / `pr_url` / `pr_status`)。
 *
 * 为什么存在：M1 是硬切——运行时只读写 `intent_prs`，旧三列被冻结。冻结不等于删除：
 * 三列从未被 DROP，也从未被本次改动改写，所以回退路径就是「把新表的事实投影回旧列
 * + 部署回旧版本」。旧版本按每意图一条 PR 解释数据，因此每个意图只能投影一条。
 *
 * 投影规则：每个意图取**最早一条** PR（按 `created_at` 升序，同值以 `number` 升序
 * 定序，与运行时 `pickPrimaryIntentPr` 的定序一致）写回三列。意图在 `intent_prs`
 * 中没有行时不改动该意图的三列（旧值原样保留，不清空——清空会毁掉本可用于人工核对
 * 的历史值）。
 *
 * 保证：
 *   - **只读 `intent_prs`**，绝不改动、绝不删除新表的任何一行。
 *   - **可重复执行**：结果只取决于 `intent_prs` 当前内容，重跑收敛到同一状态。
 *   - `--dry-run` 只打印将写什么，不落任何一次写入。
 *
 * 用法：
 *   node scripts/rollback-intent-prs.mjs [--db <path>] [--dry-run]
 *
 * `--db` 缺省时按运行时同一规则定位：`C3_DB_PATH` → `C3_DIR/c3.db` → `~/.c3/c3.db`。
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function parseArgs(argv) {
  const out = { db: null, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--db') out.db = argv[++i]
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

/** 打开 SQLite：Bun 用 `bun:sqlite`，Node 用 `node:sqlite`，只暴露本脚本需要的三个方法。 */
function openDb(path) {
  if (typeof globalThis.Bun !== 'undefined') {
    const { Database } = require('bun:sqlite')
    const db = new Database(path)
    return {
      all: (sql, ...p) => db.query(sql).all(...p),
      run: (sql, ...p) => db.query(sql).run(...p),
      exec: (sql) => db.exec(sql),
      close: () => db.close(),
    }
  }
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(path)
  return {
    all: (sql, ...p) => db.prepare(sql).all(...p),
    run: (sql, ...p) => db.prepare(sql).run(...p),
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('用法: node scripts/rollback-intent-prs.mjs [--db <path>] [--dry-run]')
    return
  }

  const dbPath = resolveDbPath(args.db)
  if (!existsSync(dbPath)) {
    console.error(`数据库不存在: ${dbPath}`)
    process.exit(1)
  }
  const db = openDb(dbPath)

  const hasTable = db.all(
    "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='intent_prs'",
  )
  if (hasTable.length === 0) {
    console.error('intent_prs 表不存在——该库尚未迁移到拆表模型，无需回退。')
    db.close()
    process.exit(1)
  }

  // 每意图最早一条：ORDER BY 决定 GROUP BY 保留哪一行,同值再以 number 定序。
  const rows = db.all(
    `SELECT intent_id, number, url, status
       FROM (SELECT * FROM intent_prs ORDER BY created_at ASC, number ASC)
      GROUP BY intent_id`,
  )

  console.log(`数据库: ${dbPath}`)
  console.log(`将回填 ${rows.length} 条意图的旧三列${args.dryRun ? '(dry-run,不写入)' : ''}`)

  if (args.dryRun) {
    for (const r of rows) {
      console.log(
        `  ${r.intent_id}  pr_id=${r.number}  pr_status=${r.status}  pr_url=${r.url ?? 'NULL'}`,
      )
    }
    db.close()
    return
  }

  const now = Date.now()
  db.exec('BEGIN')
  try {
    for (const r of rows) {
      db.run(
        'UPDATE intents SET pr_id=?, pr_url=?, pr_status=?, updated_at=? WHERE id=?',
        r.number,
        r.url ?? null,
        r.status,
        now,
        r.intent_id,
      )
    }
    db.exec('COMMIT')
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* noop */
    }
    console.error(`回填失败,已回滚: ${err instanceof Error ? err.message : String(err)}`)
    db.close()
    process.exit(1)
  }

  console.log(`完成。intent_prs 未被修改(本脚本只读该表)。`)
  db.close()
}

main()
