-- 057: queue_intent_state 新增合并凭据列 (queue schema v2 → v3)
--
-- 背景: 队列评审通过后要自动合并本意图的活跃 PR。合并这个动作不可凭「队列又算了一遍」来做
-- —— 那可以被 MCP 调用者伪造 (读 session id)、也会在重启后丢上下文重算。所以需要把「评审认领」
-- (哪个会话以哪一组 PR 的哪一版 head SHA 认领了评审) 与「合并授权凭据」(只有服务端认定的那次
-- 评审会话给出 approved 才签发) 当作必须持久化的少量事实存进 queue_intent_state。
--
-- 新增五列:
--   review_claim     TEXT   评审认领 JSON: { sessionId, prs[{forge,repo,number,headBranch,baseBranch,headSha}], claimedAt }
--   merge_grant      TEXT   合并授权凭据 JSON: { reviewSessionId, prs[...], grantedAt }; 凭据被认领/篡改即失效置 NULL
--   merge_phase      TEXT   合并编排阶段: none/pending/running/awaiting_sync/handed_back/completed
--   merge_detail     TEXT   阶段摘要 (可展示文本, 不含 prompt/凭据/权限正文/transcript)
--   merge_started_at INTEGER 开始合并的 epoch-ms
--
-- 安全边界: 凭据只由服务端在「队列认领的会话 + 该会话本人给出 approved」时签发; MCP 参数里的
-- session id 一律不读。凭据失效条件 (新认领/改写结论/人工回填/退出 reviewing/关闭自动化/PR 集合
-- 或 head/base 变更) 由内存态 + 每次 pass 的 sweep 兜住, 持久层只存事实。
--
-- 兼容性: 纯新增可空列, 不改动任何既有列/索引。存量行读作「无认领、无凭据、phase none」——
-- 正是「这条意图由人合并」这一唯一安全默认, 因为没有任何已存事实能证明相反结论。不回填。
--
-- 幂等: store 以 PRAGMA table_info 列存在性检查惰性补列 (ensureMergeColumns), 可重复执行;
-- 半途中断的库下次重新补缺失列。DDL 见下 (与 queue/queue_intent_state.sql 同步)。
-- 注意: 该模块未启用 PRAGMA user_version 作判定 (全局共享整数, 见 tables.md infra 一节)。

ALTER TABLE queue_intent_state ADD COLUMN review_claim     TEXT;
ALTER TABLE queue_intent_state ADD COLUMN merge_grant      TEXT;
ALTER TABLE queue_intent_state ADD COLUMN merge_phase      TEXT NOT NULL DEFAULT 'none';
ALTER TABLE queue_intent_state ADD COLUMN merge_detail     TEXT;
ALTER TABLE queue_intent_state ADD COLUMN merge_started_at INTEGER;
