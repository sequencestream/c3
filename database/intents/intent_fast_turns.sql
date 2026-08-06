-- intent_fast_turns — fast 模式每 turn 反向补轨的结算记录（基线 + 幂等键）
-- 所属模块: intents
-- 对应 Store: server/src/features/intents/store.ts
-- 迁移: migrate/2026/08/06/030-intents-spec-mode.sql (v18→v19)
-- 新建库时由 store.ts 的 SCHEMA 声明, 存量库由迁移补充, 两者 DDL 保持一致。

CREATE TABLE IF NOT EXISTS intent_fast_turns (
  session_id     TEXT PRIMARY KEY,   -- 该 turn 的工作会话 id; 幂等键
  intent_id      TEXT NOT NULL,      -- 归属意图 id (删除意图时随事务清理)
  workspace_path TEXT NOT NULL,      -- 归属工作区 (resolve 后)
  baseline       TEXT NOT NULL,      -- JSON: repo 路径 → HEAD commit (单仓可空), turn 启动时捕获
  settled_at     INTEGER,            -- NULL 直到该 turn 的落定被处理 (幂等标记)
  outcome        TEXT,               -- NULL 直到处理完: 'no_change'|'small'|'over'|'failed'
  spec_path      TEXT,               -- 反向生成规格的落盘路径 (small 时)
  created_at     INTEGER NOT NULL    -- 创建时间 (epoch ms)
);
CREATE INDEX IF NOT EXISTS idx_intent_fast_turn_intent ON intent_fast_turns(intent_id);
