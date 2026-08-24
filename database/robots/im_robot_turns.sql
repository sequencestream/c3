-- im_robot_turns — 机器人回合审计 (每一次把 agent 产出发往第三方云都留一行)
-- 所属模块: robots
-- 对应 Store: server/src/features/im/robot-turn-store.ts
-- 迁移: migrate/2026/08/20/044-im-robots.sql … 047-im-identity-and-call-level-scope.sql
--
-- 只记元数据, 不记正文。outcome 含 identity_required / scope_changed (ADR-0049)。

CREATE TABLE IF NOT EXISTS im_robot_turns (
  id             TEXT PRIMARY KEY,
  robot_id       TEXT NOT NULL,
  thread_key     TEXT NOT NULL,
  chat_id        TEXT NOT NULL,
  sender_id      TEXT NOT NULL,
  in_message_id  TEXT NOT NULL,
  session_id     TEXT,
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  outcome        TEXT
                 CHECK(outcome IS NULL OR outcome IN
                   ('complete','error','blocked','timeout','guard_refused','input_rejected','busy','identity_required','scope_changed')),
  reject_reason  TEXT
                 CHECK(reject_reason IS NULL OR reject_reason IN ('credential','too_long')),
  outbound_chars INTEGER NOT NULL DEFAULT 0,
  out_message_id TEXT,
  error          TEXT
);
CREATE INDEX IF NOT EXISTS idx_im_turn_robot ON im_robot_turns(robot_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_im_turn_thread ON im_robot_turns(robot_id, thread_key, started_at DESC);
