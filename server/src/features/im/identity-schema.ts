/**
 * IM identity DDL — shared between robot-store migration and identity-store runtime.
 * Kept separate so robot-store can converge identity tables in the same transaction
 * as Conversation / Context Turn / turns outcome without a circular import.
 */
import type { Db } from '../../kernel/infra/db.js'

export const IDENTITY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS im_identity_challenges (
  id                 TEXT PRIMARY KEY,
  account_namespace  TEXT NOT NULL,
  subject            TEXT NOT NULL,
  robot_id           TEXT NOT NULL,
  token_hash         TEXT NOT NULL,
  status             TEXT NOT NULL
                     CHECK(status IN ('pending','consumed','expired','cancelled')),
  created_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,
  consumed_at        INTEGER,
  cancelled_at       INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_im_challenge_pending
  ON im_identity_challenges(subject, account_namespace) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_im_challenge_token
  ON im_identity_challenges(token_hash);

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

CREATE TABLE IF NOT EXISTS im_group_workspace_scopes (
  platform              TEXT NOT NULL,
  provider_account_key  TEXT NOT NULL,
  chat_id               TEXT NOT NULL,
  workspace_name        TEXT NOT NULL,
  granted_by            TEXT NOT NULL,
  granted_at            INTEGER NOT NULL,
  PRIMARY KEY (platform, provider_account_key, chat_id, workspace_name)
);
CREATE INDEX IF NOT EXISTS idx_im_group_scope_chat
  ON im_group_workspace_scopes(platform, provider_account_key, chat_id);

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
`

export function execIdentitySchema(d: Db): void {
  d.exec(IDENTITY_SCHEMA_SQL)
}

export function identityTablesPresent(d: Db): boolean {
  return (
    d.get("SELECT 1 AS n FROM sqlite_master WHERE type='table' AND name='im_identity_bindings'") !=
    null
  )
}
