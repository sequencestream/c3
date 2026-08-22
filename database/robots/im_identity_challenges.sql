-- im_identity_challenges — Web 发起的一次性 IM 身份绑定挑战
-- 所属模块: robots (auth 边界)
-- 对应 Store: server/src/features/im/identity-store.ts
-- 迁移: migrate/2026/08/22/047-im-identity-and-call-level-scope.sql
--
-- 明文令牌只在创建成功的 Web 响应中出现一次; 本表只存哈希。
-- pending 在同一 (subject, account_namespace) 上唯一; 新建会使旧 pending 取消。

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
