-- 026: Add research_session_id to discussions (schema v6 → v7)
-- 讨论的「研究会话」标识:只读研究跑批不再是黑盒一次性调用,而是一个正式会话——
-- 研究运行时捕获 vendor session id 并写入本列,transcript 随 vendor 落盘、结束后仍可 resume,
-- 并投影到 session_metadata(session_kind='discussion', owner_kind='discussion', owner_id=<discussion.id>)。
-- 前端据本列渲染讨论详情的「研究会话」tab(运行态 / 停止 / 追问改写 research_result)。
-- NULL/'' 表示该讨论没有研究会话:所有历史行,以及研究在 session id 绑定前就失败的新行。
-- 无回填可能(历史研究跑批没有留下任何 vendor 会话)。
-- 幂等: store 以列存在性 (PRAGMA table_info) 为准增量补列, 可重复执行。

ALTER TABLE discussions ADD COLUMN research_session_id TEXT;
