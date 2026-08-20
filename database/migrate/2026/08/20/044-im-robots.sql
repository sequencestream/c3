-- im_robots / im_robot_threads / im_robot_turns: 新建三表 —— IM 聊天机器人 (配置 / 线程映射 / 外发审计)。
--
-- 纯新增, 不改动也不重写任何既有表。既有库通过 CREATE TABLE IF NOT EXISTS + PRAGMA table_info
-- 列存在性检查收敛, 重复执行是 no-op; 无数据回填 —— 机器人只能由用户显式创建, 不从任何既有数据推导。
--
-- 建表与索引由 server/src/features/im/robot-store.ts 的 ensureSchema 惰性幂等执行, 新库与旧库同一条
-- 路径; 本文件是该 schema 的变更记录。三张表的完整语义 (不绑工作区的理由、默认关闭与启用前确认这两条
-- 授权凭据、线程身份的归一化、审计为何只记元数据) 分别见 database/robots/ 下的同名文件。

CREATE TABLE IF NOT EXISTS im_robots (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  platform         TEXT NOT NULL
                   CHECK(platform IN ('feishu')),
  app_id           TEXT NOT NULL,
  app_secret       TEXT NOT NULL DEFAULT '',
  vendor           TEXT NOT NULL,
  agent_id         TEXT NOT NULL,
  mode             TEXT NOT NULL DEFAULT '',
  tool_allowlist   TEXT NOT NULL DEFAULT '[]',
  require_mention  INTEGER NOT NULL DEFAULT 1,
  chat_allowlist   TEXT NOT NULL DEFAULT '[]',
  dm_mode          TEXT NOT NULL DEFAULT 'disabled'
                   CHECK(dm_mode IN ('disabled','allowlist','open')),
  dm_allowlist     TEXT NOT NULL DEFAULT '[]',
  max_turn_ms      INTEGER,
  enabled          INTEGER NOT NULL DEFAULT 0,
  outbound_ack_at  INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_im_robot_name ON im_robots(name);
CREATE INDEX IF NOT EXISTS idx_im_robot_enabled ON im_robots(enabled);

CREATE TABLE IF NOT EXISTS im_robot_threads (
  robot_id        TEXT NOT NULL,
  thread_key      TEXT NOT NULL,
  chat_id         TEXT NOT NULL,
  session_id      TEXT,
  vendor          TEXT NOT NULL,
  turn_count      INTEGER NOT NULL DEFAULT 0,
  last_message_id TEXT,
  created_at      INTEGER NOT NULL,
  last_active_at  INTEGER NOT NULL,
  PRIMARY KEY (robot_id, thread_key)
);
CREATE INDEX IF NOT EXISTS idx_im_thread_session ON im_robot_threads(session_id);
CREATE INDEX IF NOT EXISTS idx_im_thread_idle ON im_robot_threads(last_active_at);

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
                   ('complete','error','blocked','timeout','guard_refused')),
  outbound_chars INTEGER NOT NULL DEFAULT 0,
  out_message_id TEXT,
  error          TEXT
);
CREATE INDEX IF NOT EXISTS idx_im_turn_robot ON im_robot_turns(robot_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_im_turn_thread ON im_robot_turns(robot_id, thread_key, started_at DESC);
