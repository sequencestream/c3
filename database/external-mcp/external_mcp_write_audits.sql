-- external_mcp_write_audits — 外部 MCP 写调用的只增审计轨迹
-- 所属模块: external-mcp
-- 对应 Store: server/src/features/external-mcp/audit-store.ts
-- 迁移: migrate/2026/08/14/041-external-mcp-write-audits.sql
--
-- 存在理由: 一把范围型 key 泄漏后, 吊销只能挡住下一次调用, 回答不了「谁、什么时候、
-- 用哪把 key、对哪个工作区做了什么」。意图/讨论台账记录的是「什么被改了」, 从不记录
-- 「哪个凭据要求改的」, 因此归因只能落在本表。
--
-- 只存非秘密事实。刻意没有入参、工具输出、bearer 值、key 哈希与认证头列: 能泄漏凭据
-- 的审计轨迹等于凭据的第二份副本。key_id 是控制台本就展示的非秘密 id。
--
-- 只增: 任何路径都不 UPDATE / DELETE 本表。key 被吊销后历史保留 —— 历史说的是它存在
-- 期间做过什么。
--
-- result 三态按「调用停在哪一步」划分, 而非按严重程度: rejected 未进业务 handler
-- (授权、参数校验或 id 归属校验拒绝), failure 进了 handler 但报错或抛异常,
-- success 正常完成。据此一串 rejected 才能读作探测行为而不是集成写错了。
--
-- workspace_name 记的是做出授权判定的那个工作区: 成功时是生效工作区, 被拒时是调用方
-- 声称的那个 —— 否则一次越权尝试会因为「没有生效工作区」而无处落账。

CREATE TABLE IF NOT EXISTS external_mcp_write_audits (
  id             TEXT PRIMARY KEY,   -- uuid
  occurred_at    INTEGER NOT NULL,   -- epoch ms
  key_id         TEXT NOT NULL,      -- 非秘密 key id, 引用 mcp_api_keys.key_id (不设外键: key 吊销后审计仍需可读)
  owner_subject  TEXT NOT NULL,      -- 该 key 的归属账号
  workspace_name TEXT NOT NULL,      -- 授权判定所针对的工作区名 (生效或被拒的尝试值)
  tool           TEXT NOT NULL,      -- 稳定外部工具名
  result         TEXT NOT NULL       -- success=handler 正常完成 / failure=handler 报错或抛异常 / rejected=未进 handler
                 CHECK(result IN ('success','failure','rejected'))
);
CREATE INDEX IF NOT EXISTS idx_external_mcp_write_audit_occurred
  ON external_mcp_write_audits(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_external_mcp_write_audit_key
  ON external_mcp_write_audits(key_id, occurred_at DESC);
