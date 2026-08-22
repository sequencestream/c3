-- im_outbound_audit — 统一 IM 外发审计（元数据，不含正文）
-- 所属模块: robots
-- 对应 Store: server/src/features/im/outbound-audit-store.ts

CREATE TABLE IF NOT EXISTS im_outbound_audit (
  id                  TEXT PRIMARY KEY,
  robot_id            TEXT NOT NULL,
  category            TEXT NOT NULL,
  source_event_kind   TEXT,
  idempotency_key     TEXT,
  target_kind         TEXT NOT NULL,
  target_ref          TEXT NOT NULL,
  object_workspace    TEXT,
  template_key        TEXT,
  result              TEXT NOT NULL,
  refuse_reason       TEXT,
  outbound_chars      INTEGER NOT NULL DEFAULT 0,
  platform_message_id TEXT,
  at                  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_im_outbound_audit_robot ON im_outbound_audit(robot_id, at DESC);

CREATE TABLE IF NOT EXISTS im_broadcast_claims (
  robot_id            TEXT NOT NULL,
  idempotency_key     TEXT NOT NULL,
  target_kind         TEXT NOT NULL,
  target_ref          TEXT NOT NULL,
  platform_message_id TEXT,
  claimed_at          INTEGER NOT NULL,
  PRIMARY KEY (robot_id, idempotency_key, target_kind, target_ref)
);
