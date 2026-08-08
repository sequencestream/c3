-- intents 新增 base_branch: 意图的基准分支快照
--
-- 运行时迁移由 server/src/features/intents/store.ts 的 schema ensure 幂等执行:
-- 新库直接由 SCHEMA 建列; 旧库按 PRAGMA table_info 判定后 ALTER TABLE ADD COLUMN,
-- 再由 schema_migrations 标记 `intents.backfill_base_branch.v1` 保护的一次性回填
-- 补齐存量行。可重复执行; 从不 DROP。
--
-- 为什么要这一列: 「这个意图基于哪个分支」此前没有持久答案 —— 建 PR 从工作区主分支
-- 推导, worktree 基线从交付状态推导, 两处在 defaultMainBranch 缺失时的回退结果还不
-- 一致, 用户也看不到。落成单值快照后, 详情展示、PR 目标、worktree 基线读同一个事实,
-- 交付状态之后如何变化都能可审计地回答同一个问题。
--
-- 磁盘可空: ADD COLUMN 无法在不编造默认值的前提下声明 NOT NULL。所有写入路径保证非空,
-- 读模型对空值派生主分支回退并标注, 不回写 —— 读时推导若落库, 事后就再也分不清它是
-- 记录下来的决定还是当场猜的。
ALTER TABLE intents ADD COLUMN base_branch TEXT;

-- 存量回填 (与运行时 backfillIntentBaseBranch 同一口径, 标记 + 数据同事务, 失败整体回滚):
--   1. 恰好关联一个交付且该交付 branch_ready=1、分支名非空 → 该交付分支;
--   2. 否则 → 工作区有效主分支 (defaultMainBranch → origin/HEAD 探测 → main/master)。
-- 多交付不按关联顺序猜测, 一律落主分支; 未就绪的交付分支绝不写入; 已有有效值的行不动,
-- 空白/异常值按同一主分支规则修复。工作区主分支需要 git 探测, 无法用纯 SQL 表达,
-- 下面的语句只覆盖能由数据库自身判定的第 1 类, 第 2 类由运行时迁移完成。
UPDATE intents
   SET base_branch = (
         SELECT TRIM(dl.branch_name)
           FROM intent_deliveries e
           JOIN deliveries dl ON dl.id = e.delivery_id
          WHERE e.intent_id = intents.id
       )
 WHERE (base_branch IS NULL OR TRIM(base_branch) = '')
   AND (SELECT COUNT(*) FROM intent_deliveries e WHERE e.intent_id = intents.id) = 1
   AND (
         SELECT dl.branch_ready
           FROM intent_deliveries e
           JOIN deliveries dl ON dl.id = e.delivery_id
          WHERE e.intent_id = intents.id
       ) = 1
   AND (
         SELECT TRIM(COALESCE(dl.branch_name, ''))
           FROM intent_deliveries e
           JOIN deliveries dl ON dl.id = e.delivery_id
          WHERE e.intent_id = intents.id
       ) <> '';
