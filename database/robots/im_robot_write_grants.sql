-- im_robot_write_grants — 机器人 L2 写能力逐项授权
-- 所属模块: robots
-- 对应 Store: server/src/features/im/write-grant-store.ts
--
-- 每个机器人、每个能力独立一行。没有行、未知能力、禁用、缺确认或 config_hash
-- 与当前机器人配置不一致均视为未授权。write_ack_at 与外发确认 outbound_ack_at 独立。

CREATE TABLE IF NOT EXISTS im_robot_write_grants (
  robot_id         TEXT NOT NULL,
  capability       TEXT NOT NULL
                   CHECK(capability IN ('queue_respond','automation_control','annotate','dev_start')),
  enabled          INTEGER NOT NULL DEFAULT 0,
  acknowledged_by  TEXT,
  write_ack_at     INTEGER,
  config_hash      TEXT,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (robot_id, capability),
  FOREIGN KEY (robot_id) REFERENCES im_robots(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_im_robot_write_grants_robot ON im_robot_write_grants(robot_id);
