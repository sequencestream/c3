-- im_robot_turns: 将 busy 纳入 outcome 闭集。
--
-- busy = 同线程已有在途回合、未启动 agent run、但发送了忙碌提示。不得与 blocked / error
-- 混用。历史行保持原值、无需回填。SQLite 无法 ALTER CHECK,故以 RENAME + 建新表 + 拷贝完成。

ALTER TABLE im_robot_turns RENAME TO im_robot_turns_pre_busy;

CREATE TABLE im_robot_turns (
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
                   ('complete','error','blocked','timeout','guard_refused','busy')),
  outbound_chars INTEGER NOT NULL DEFAULT 0,
  out_message_id TEXT,
  error          TEXT
);

INSERT INTO im_robot_turns SELECT * FROM im_robot_turns_pre_busy;

-- RENAME 会把旧索引一起挂到 pre_busy 上; 必须先 DROP 旧表(连带删掉同名旧索引),
-- 再建索引, 否则 CREATE INDEX IF NOT EXISTS 会因同名索引仍在而跳过, 新表无索引。
DROP TABLE im_robot_turns_pre_busy;

CREATE INDEX IF NOT EXISTS idx_im_turn_robot ON im_robot_turns(robot_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_im_turn_thread ON im_robot_turns(robot_id, thread_key, started_at DESC);
