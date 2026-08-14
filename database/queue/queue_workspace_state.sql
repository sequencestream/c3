-- queue_workspace_state — 自动化队列的工作区级控制状态
-- 所属模块: queue
-- 对应 Store: server/src/features/intents/queue-store.ts
--
-- 队列不再是纯内存控制器: 用户「启动/暂停」的意愿必须跨进程重启存活, 否则服务重启后
-- 队列会静默变回 idle。启动时的全量对账正是以本表为入口集合。

CREATE TABLE IF NOT EXISTS queue_workspace_state (
  workspace_name TEXT PRIMARY KEY,          -- 所属工作区绝对路径 (resolve 后)
  state          TEXT NOT NULL,             -- 队列控制状态: 'idle' | 'running' | 'paused'; 非法/未知值读取时归一为 'idle'
  started_at     INTEGER,                   -- 队列启动时间 (epoch ms); idle 时为 NULL
  force_skipped  TEXT NOT NULL DEFAULT '[]',-- JSON string[], 用户强制跳过的 intent id 集合; 只影响本队列选择, 不标记 done、不满足依赖闸门
  updated_at     INTEGER NOT NULL           -- 最后更新时间 (epoch ms)
);
