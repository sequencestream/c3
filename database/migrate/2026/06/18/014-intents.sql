-- 014 — intents 新增 spec 质量闸 + 会话字段
-- 日期: 2026-06-18
-- 影响 store / 版本跨度:
--   intents (intents)  v12 → v13
--
-- 背景: spec 质量闸的审批状态、spec 文档路径、以及 spec/refine 两个会话 id 必须落库,
-- 否则刷新 / 重连后质量闸状态与会话 tab 全部丢失,人工审批检查点无法持久。
--   - spec_path        : 已撰写 spec 文档路径 (相对 workspace),质量闸「spec 是否存在」的来源。
--                        文档标注 VARCHAR(255),SQLite 实为 TEXT (不强制长度)。
--   - spec_approved    : 是否通过人工审批闸 (0/1),DEFAULT 0;历史行保持 0。
--   - spec_approve_user: 审批人标识,文档标注 VARCHAR(64);未审批为 NULL。
--   - spec_session_id  : 撰写/精炼 spec 的会话 c3SessionId,文档标注 VARCHAR(128)。
--   - intent_session_id: 意图 refine/沟通会话 c3SessionId,文档标注 VARCHAR(128)。
--
-- 关键决策: 不动 last_dev_session_id。intent_session_id 与之并存且语义不同 ——
-- last_dev_session_id 是「开发会话」,intent_session_id 是「refine/沟通会话」。
--
-- 范围: 本意图只做「字段落库 + 读写投影 + 数据层 setter」,不含任何业务赋值逻辑
-- (何时 / 由谁置 spec_approved=1、写 spec_path 等,归 Write Spec / approve / refine 各条)。
--
-- 迁移由 store 的 ensureColumn(d, 'intents', <col>, <decl>) 在 exec(SCHEMA) 之后执行,
-- 幂等且可重入 (以 PRAGMA table_info 守卫,缺列才 ADD)。从不 DROP、不丢数据。
-- 下面的等价 DDL 仅作记录,真实迁移在 store.ts 中以幂等守卫执行。

ALTER TABLE intents ADD COLUMN spec_path TEXT;
ALTER TABLE intents ADD COLUMN spec_approved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE intents ADD COLUMN spec_approve_user TEXT;
ALTER TABLE intents ADD COLUMN spec_session_id TEXT;
ALTER TABLE intents ADD COLUMN intent_session_id TEXT;
