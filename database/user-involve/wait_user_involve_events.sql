-- wait_user_involve_events — 等待用户介入事件 (工具调用需要人工决策时创建)
-- 所属模块: user-involve
-- 对应 Store: server/src/features/user-involve/store.ts


CREATE TABLE IF NOT EXISTS wait_user_involve_events (
  id            TEXT PRIMARY KEY,             -- 事件唯一标识 (UUID v4)
  workspace_path TEXT NOT NULL,               -- 所属工作区绝对路径 (resolve 后); v1→v2 由 project_path 改名
  session_kind  TEXT NOT NULL,               -- 产生会话的完整 SessionKind: 'work'|'intent'|'discussion'|'schedule'|'consensus'|'tool'|'spec'; 由调用方原样传入,驱动 WorkCenter 溯源跳转; v4→v5 由 source 改名(不再折叠为可跳转子集)
  session_id    TEXT,                         -- 产生会话的真实 id (work/intent/spec 会话 id、discussion id、schedule id); 读取端按此反查所属意图派生 intentId/intentTitle; v4→v5 由 source_id 改名; 历史行可能存意图对象 id(反查不到则降级)
  title         TEXT,                         -- 事件标题
  request_id    TEXT,                         -- 权限请求 ID (用于关联 permission-response 消息)
  tool_name     TEXT,                         -- 待审批的工具名称
  tool_input    TEXT NOT NULL DEFAULT '',     -- JSON, 工具输入参数
  status        TEXT NOT NULL,                -- 状态: 'todo' | 'done' | 'canceled' | 'auto' (= WaitUserInvolveStatus); 'auto'=多 Agent 共识自动决议的非阻塞审计记录,不计待处理徽章
  outcome       TEXT,                         -- v2→v3 新增; JSON, 仅 status='auto' 记录携带 (AnyConsensusOutcome: 投票/裁决/摘要),人类决策事件为 NULL
  created_at    INTEGER NOT NULL,             -- 创建时间 (epoch ms)
  updated_at    INTEGER NOT NULL              -- 最后更新时间 (epoch ms)
);
CREATE INDEX IF NOT EXISTS idx_wui_workspace_status ON wait_user_involve_events(workspace_path, status);
CREATE INDEX IF NOT EXISTS idx_wui_session_status ON wait_user_involve_events(session_id, status);
