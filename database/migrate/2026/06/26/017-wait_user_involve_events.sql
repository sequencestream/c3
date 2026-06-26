-- 017 — wait_user_involve_events 来源列改名为真实会话身份 session_kind / session_id
-- 日期: 2026-06-26
-- 影响 store / 版本跨度:
--   user-involve (wait_user_involve_events)  v4 → v5
--
-- 背景: source / source_id 是从真实会话信息「折叠」出来的抽象。source 仅存可跳转子集
-- (WaitUserInvolveSource),source_id 对 intent 来源有二义(save-gate 写 comm 会话 id、
-- Start-Dev 收尾写意图对象 id),导致拿不到稳定意图、溯源跳转易错。本意图改存真实会话身份:
--   source     → session_kind  (放宽存完整 SessionKind: work|intent|discussion|schedule|consensus|tool|spec)
--   source_id  → session_id    (存产生事件的真实会话 id)
-- 读取端按 session_id 反查所属意图,派生 intentId / intentTitle(不落库)。
--
-- 结构迁移: ALTER TABLE RENAME COLUMN 两列就地改名 + 复合索引 idx_wui_source_status
-- DROP 后由 SCHEMA 以新名 idx_wui_session_status 重建。幂等(列已是新名时为 no-op),
-- 从不 DROP TABLE、不丢数据。旧 session_kind='session' 值与历史 session_id(可能是意图
-- 对象 id)原样保留——前端对未知 kind 兜底到控制台,反查不到的意图派生为 null(降级,不回填)。
-- 迁移由 store 的 migrateSourceColumnsToSession(d) 在 exec(SCHEMA) 之前执行。
-- 下面的等价 DDL 仅作记录,真实迁移在 store.ts 中执行。

ALTER TABLE wait_user_involve_events RENAME COLUMN source TO session_kind;
ALTER TABLE wait_user_involve_events RENAME COLUMN source_id TO session_id;
DROP INDEX IF EXISTS idx_wui_source_status;
CREATE INDEX IF NOT EXISTS idx_wui_session_status ON wait_user_involve_events(session_id, status);
