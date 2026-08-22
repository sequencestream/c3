-- im_identity_bindings — 平台账号命名空间内外部身份 ↔ c3 subject
-- 所属模块: robots (auth 边界)
-- 对应 Store: server/src/features/im/identity-store.ts
-- 迁移: migrate/2026/08/22/047-im-identity-and-call-level-scope.sql
--
-- active 行: revoked_at IS NULL。同一命名空间内 active sender 与 active subject 均唯一。
-- 撤销行保留为历史; 授权读取只接受 active。

CREATE TABLE IF NOT EXISTS im_identity_bindings (
  id                 TEXT PRIMARY KEY,
  account_namespace  TEXT NOT NULL,
  sender_id          TEXT NOT NULL,
  subject            TEXT NOT NULL,
  verified_at        INTEGER NOT NULL,
  revoked_at         INTEGER,
  revoked_by         TEXT,
  revoke_reason      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_im_binding_active_sender
  ON im_identity_bindings(account_namespace, sender_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_im_binding_active_subject
  ON im_identity_bindings(account_namespace, subject) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_im_binding_subject
  ON im_identity_bindings(subject, verified_at DESC);
