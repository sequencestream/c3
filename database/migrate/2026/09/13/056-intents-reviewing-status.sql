-- 056 — intents 状态机引入 `reviewing` 态:存量 done→reviewing 一次性数据迁移
-- 无新列、无重建表(状态列本就没有 CHECK 约束,新增枚举值不需动 DDL)。
-- 实际迁移逻辑在 intents store 的惰性 schema ensure(backfillReviewingStatus),
-- 以 schema_migrations 标记 intents.backfill_reviewing_status.v1 幂等, user_version 25→26。
-- 旧库对满足条件的行就地 UPDATE, 可重复执行, 从不 DROP。
--
-- 迁移判据: status='done' AND automate=1 AND 存在活跃 PR 行(intent_prs.status ∈
-- reviewing/failed/rejected)。活跃 PR 行本身就是 worktree 模式的证据——PR 阶段只在
-- worktree 模式存在(current-branch 共享检出无 PR 阶段), 故「工作区为 worktree」无需单独列。
-- 这批意图在新语义下本就未完成(自动化在建 PR 之前就置了 done), 迁移后 status=reviewing、
-- completed_at 清空, 由评审/修复接力自动接管——这正是修复「自动化建 PR 后不评审」的存量部分。
-- 其余 done 行(无活跃 PR / 非 automate)保持 done, 属历史遗留宽松完成, 不回溯改判、不进接力。
UPDATE intents
   SET status = 'reviewing', completed_at = NULL
 WHERE status = 'done' AND automate = 1
   AND EXISTS (
         SELECT 1 FROM intent_prs p
          WHERE p.intent_id = intents.id
            AND p.status IN ('reviewing','failed','rejected')
       );
