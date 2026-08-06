-- intents 新增每意图级 spec 模式 spec_mode — 三态:NULL(继承工作区)/ 'sdd' / 'fast'
--
-- 运行时迁移由 server/src/features/intents/store.ts 的 schema ensure 幂等执行
-- (`PRAGMA table_info` 列存在性检查 + ALTER TABLE ADD COLUMN)，可重复执行；从不 DROP。
-- SCHEMA_VERSION v18 → v19。
--
-- 为什么加这一列：小改动走完整 SDD 前置规格链路的成本与改动规模不成比例。系统为单条
-- 意图提供 specMode：'sdd' 保持规格先行；'fast' 允许人工先产出代码 diff，再由系统在
-- turn 落定后按 diff 大小反向生成待批准规格（未超阈值）或将意图钉回 'sdd'（超阈值）。
-- 模式的"当前有效值"由持久值 + 工作区 sddEnabled 派生：NULL ⇒ 开启时解析为 sdd、关闭时
-- 解析为 fast；显式值始终覆盖派生。共享 Intent 读模型携带 specMode（持久）与
-- effectiveSpecMode（已解析），避免客户端、准入层与落定处理各自推导出不同结果。
--
-- 状态语义：
--   NULL   继承工作区（默认）：sddEnabled=true ⇒ sdd，false ⇒ fast。存量行全部保持 NULL。
--   'sdd'  显式固定规格先行。
--   'fast' 显式固定规格延后（仅手动 start_development 跳过 spec 准入闸门；自动化不变）。
--
-- 模式切换不直接改变 spec_status：切到 fast 不撤销已批准规格，切到 sdd 也不伪造 pending。
-- 真正的文档改写继续触发现有批准失效规则。
--
-- 存量不回填：既有行保持 NULL，继续按当前工作区规则派生，行为与迁移前完全一致。

ALTER TABLE intents ADD COLUMN spec_mode TEXT CHECK(spec_mode IN ('sdd','fast'));

-- 每 turn 反向补轨的结算记录（基线 + 幂等键）——由 store.ts 的 SCHEMA 在新建库时创建，
-- 存量库由本迁移补充。session_id 为主键；settled_at/outcome 在落定处理完成前为 NULL，
-- 记录同时充当"启动 → 落定"的握手，防重复 settled 事件或重启重复生成规格。
CREATE TABLE IF NOT EXISTS intent_fast_turns (
  session_id     TEXT PRIMARY KEY,
  intent_id      TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  baseline       TEXT NOT NULL,  -- JSON: repo 路径 → HEAD commit（单仓可空）
  settled_at     INTEGER,        -- NULL 直到该 turn 的落定被处理
  outcome        TEXT,           -- NULL 直到处理完: 'no_change'|'small'|'over'|'failed'
  spec_path      TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intent_fast_turn_intent ON intent_fast_turns(intent_id);
