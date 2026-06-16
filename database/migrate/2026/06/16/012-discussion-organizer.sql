-- 012: Add organizer_agent_id to discussions
-- Per-discussion organizer selection (overrides the global default agent).

ALTER TABLE discussions ADD COLUMN organizer_agent_id TEXT;
