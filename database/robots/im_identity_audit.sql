-- im_identity_audit — 身份绑定与群范围变更的只增审计
-- 所属模块: robots (auth 边界)
-- 对应 Store: server/src/features/im/identity-store.ts
-- 迁移: migrate/2026/08/22/047-im-identity-and-call-level-scope.sql
--
-- 不记录令牌、消息正文、工具 I/O 或台账内容。sender_digest 为外部身份稳定摘要。

CREATE TABLE IF NOT EXISTS im_identity_audit (
  id                 TEXT PRIMARY KEY,
  event_type         TEXT NOT NULL,
  subject            TEXT,
  account_namespace  TEXT,
  sender_digest      TEXT,
  robot_id           TEXT,
  chat_id            TEXT,
  binding_id         TEXT,
  reason_code        TEXT,
  actor              TEXT,
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_im_identity_audit_at
  ON im_identity_audit(created_at DESC);
