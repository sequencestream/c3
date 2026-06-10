-- schedule_execution_logs — 定时任务执行历史
-- 所属模块: schedules
-- 对应 Store: server/src/features/schedules/store.ts


CREATE TABLE IF NOT EXISTS schedule_execution_logs (
  id            TEXT PRIMARY KEY,                   -- 日志唯一标识 (UUID v4)
  schedule_id   TEXT NOT NULL,                      -- 所属任务 ID (外键 → schedules.id)
  started_at    INTEGER NOT NULL,                   -- 执行开始时间 (epoch ms)
  finished_at   INTEGER,                            -- 执行结束时间 (epoch ms)
  exit_code     INTEGER,                            -- 进程退出码 (0=成功, 非0=失败)
  output        TEXT NOT NULL DEFAULT '',           -- stdout 输出内容
  error         TEXT,                               -- stderr 错误信息
  status        TEXT NOT NULL DEFAULT 'running',    -- 执行状态: 'running' | 'success' | 'error'
  session_id    TEXT                                -- agent 会话 ID (llm 类型任务可通过此 ID 回溯 transcript)
);
CREATE INDEX IF NOT EXISTS idx_sch_exec_schedule ON schedule_execution_logs(schedule_id);
