-- im_todo_answer_contracts — 待办 IM 可作答契约 (与 wait_user_involve_events 一对一)
-- 所属模块: user-involve
-- 对应 Store: server/src/features/user-involve/answer-contract-store.ts
--
-- 冻结 actor、对象、能力、封闭答案集合与领域动作载荷。无契约的行不可由 IM 作答。

CREATE TABLE IF NOT EXISTS im_todo_answer_contracts (
  todo_id              TEXT PRIMARY KEY,
  capability           TEXT NOT NULL
                       CHECK(capability IN ('queue_respond','automation_control','annotate')),
  actor_subject        TEXT NOT NULL,
  workspace_name       TEXT NOT NULL,
  object_type          TEXT NOT NULL,
  object_id            TEXT NOT NULL,
  todo_fingerprint     TEXT NOT NULL,
  answers_json         TEXT NOT NULL,
  domain_action_json   TEXT NOT NULL,
  assignee_subject     TEXT,
  claimed_at           INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  FOREIGN KEY (todo_id) REFERENCES wait_user_involve_events(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_im_todo_contracts_actor ON im_todo_answer_contracts(actor_subject);
