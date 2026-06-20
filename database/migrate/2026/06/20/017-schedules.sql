-- Bind an LLM schedule to one explicit agent profile while retaining vendor as
-- the stable tool-manifest and adapter-routing key.
ALTER TABLE schedules ADD COLUMN agent_id TEXT;
