-- 新增 delivery 领域: 交付 (集成单元) 台账表 deliveries
--
-- 运行时迁移由 server/src/features/deliveries/store.ts 的 schema ensure 幂等执行
-- (`CREATE TABLE IF NOT EXISTS` + 索引创建), 可重复执行; 从不 DROP。
-- 本文件与 store.ts 的 SCHEMA 声明保持同一 DDL, 供存量库与文档参照。
--
-- 为什么加这张表: 一批意图作为整体合入主线需要一个承载体来回答「这批能不能合了、
-- 卡在哪」—— status 状态机 + base_branch 快照 + 分支唯一约束。`intent_prs.delivery_id`
-- 已由 031 迁移预置 (NULL 契约不变), 是后续意图关联的落点; 本阶段不写它。
--
-- 状态闭集从创建之初生效 (CHECK): 新域无 intents.status 那种历史遗留越界值,
-- 此刻不加以后再也加不上。不建「已完成」态 —— 它与「所有关联意图的 PR 已合入交付
-- 分支」重叠, 只以「集成就绪 N/M」实时聚合呈现 (见 store.ts 的 integrationAggregate)。
--
-- 存量无数据回填: 交付是新实体, 不迁移任何既有行。
CREATE TABLE IF NOT EXISTS deliveries (
  id             TEXT PRIMARY KEY,
  workspace_path TEXT NOT NULL,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL
                 CHECK(status IN ('planned','integrating','verifying','verified','delivered','cancelled')),
  start_date     INTEGER,
  end_date       INTEGER,
  branch_name    TEXT,
  base_branch    TEXT NOT NULL,
  branch_ready   INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delivery_workspace_status ON deliveries(workspace_path, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_workspace_active_branch
  ON deliveries(workspace_path, branch_name)
  WHERE branch_name IS NOT NULL AND status NOT IN ('delivered','cancelled');
