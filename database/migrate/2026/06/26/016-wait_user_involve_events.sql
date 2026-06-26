-- 016 — wait_user_involve_events 来源取值 'session' 折叠为 'work'
-- 日期: 2026-06-26
-- 影响 store / 版本跨度:
--   user-involve (wait_user_involve_events)  v3 → v4
--
-- 背景: WaitUserInvolveSource 此前为 'session' | 'intent' | 'discussion' | 'schedule',
-- 与 SessionKind (work | intent | discussion | schedule | consensus | tool | spec) 语义漂移
-- (session vs work,且缺 spec)。本意图把来源类型收敛为 SessionKind 的「可溯源跳转子集」
-- 'work' | 'intent' | 'discussion' | 'schedule' | 'spec',服务端经 sessionKindToWaitUserSource
-- 从 sessionKind (driver 路径) 或 gate (claude 网控路径) 忠实派生。
--
-- 数据迁移: 历史行的 source='session' 就地折叠为 'work'。
-- 不改表结构(列已齐备),仅一次幂等 UPDATE;前端对任何未知来源亦兜底为 'work'。
-- 迁移由 store 的 migrateSessionSourceToWork(d) 在 exec(SCHEMA) 之后执行,
-- 幂等且可重入(无 'session' 行时为 no-op)。从不 DROP、不丢数据。
-- 下面的等价 DDL 仅作记录,真实迁移在 store.ts 中执行。

UPDATE wait_user_involve_events SET source = 'work' WHERE source = 'session';
