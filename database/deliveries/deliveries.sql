-- deliveries — 交付 (集成单元) 台账
-- 所属模块: deliveries
-- 对应 Store: server/src/features/deliveries/store.ts
-- 迁移: migrate/2026/08/06/032-deliveries.sql
-- 新建库时由 store.ts 的 SCHEMA 声明, 存量库由迁移补充, 两者 DDL 保持一致。
--
-- 交付是「一批意图共同集成并最终进入主线」的 Git 生命周期单元 (ADR-0036)。
-- 本阶段只承载本地台账 CRUD + 受控状态机; 交付分支 / 意图关联 / PR 改投 / 合并
-- 由后续阶段写入, 本阶段不建分支、不关联意图、不创建/关闭/合并任何 PR。
--
-- 状态闭集 (数据库 CHECK 与共享协议同一闭集, 见 @ccc/shared DeliveryStatus):
--   planned → integrating → verifying → verified → delivered
--   任意非终态 → cancelled; 回退边 verifying → integrating (人工返工)、
--   verified → verifying (仅系统, 原因 merge_conflict)。
-- 无「已完成」态: 它与「所有关联意图的 PR 已合入交付分支」重叠, 只以
-- 「集成就绪 N/M」呈现 (由 intent_prs.delivery_id 实时聚合, 不持久化计数)。

CREATE TABLE IF NOT EXISTS deliveries (
  id             TEXT PRIMARY KEY,              -- 交付唯一标识 (UUID v4)
  workspace_path TEXT NOT NULL,                 -- 所属工作区绝对路径 (resolve 后)
  title          TEXT NOT NULL,                 -- 交付标题
  description    TEXT NOT NULL DEFAULT '',      -- 交付描述
  status         TEXT NOT NULL
                 CHECK(status IN ('planned','integrating','verifying','verified','delivered','cancelled')),
  start_date     INTEGER,                       -- 用户选择的日历起始日期 (epoch ms); 空 = 未设
  end_date       INTEGER,                       -- 用户选择的日历结束日期 (epoch ms); 空 = 未设
  branch_name    TEXT,                          -- 交付分支名; 后续分支能力置入, 本阶段恒 NULL
  base_branch    TEXT NOT NULL,                 -- 建交付时对工作区 defaultMainBranch 的快照 (解析规则所得值, 非空);
                                                -- 之后修改工作区配置不回写历史交付, 防止交付被合进它从未基于的分支
  branch_ready   INTEGER NOT NULL DEFAULT 0,    -- 交付分支是否已就绪; 本阶段创建/编辑均不触发分支探测, 恒为 0
  created_at     INTEGER NOT NULL,              -- 创建时间 (epoch ms)
  updated_at     INTEGER NOT NULL               -- 最后更新时间 (epoch ms)
);
CREATE INDEX IF NOT EXISTS idx_delivery_workspace_status ON deliveries(workspace_path, status);
-- 活动状态 (非 delivered/cancelled) 下 (workspace_path, branch_name) 唯一; 终态不占位,
-- 允许后续交付复用历史分支名。空分支名不参与冲突 (SQLite 唯一索引视 NULL 互不相等)。
CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_workspace_active_branch
  ON deliveries(workspace_path, branch_name)
  WHERE branch_name IS NOT NULL AND status NOT IN ('delivered','cancelled');
