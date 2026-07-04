-- v11 (2026-07-04): automation metadata + run-lifecycle sessionKind / metadata
-- event-trigger filters.
--
-- `metadata`: free-form key/value annotations on the automation. Only the
-- scheduler's own run:started / run:settled for that automation stamp this map
-- onto the event payload, so downstream event automations can chain by it.
-- Defaults to '{}' for existing rows.
--
-- `event_session_kind_filter`: the explicit, non-empty SessionKind multi-select
-- that may fire a run-lifecycle event trigger — replacing the former hardcoded
-- ['work'] whitelist. Existing run:started / run:settled event automations are
-- backfilled to ['work'] so their behaviour is unchanged (NOT widened to
-- automation / discussion / intent). NULL for cron / pr / intent rows.
--
-- `event_metadata_filter`: JSON {conditions,combinator} metadata condition filter
-- for run-lifecycle triggers; NULL = no filter (match any).
--
-- Idempotent via columnExists guards in the store; re-runs are no-ops.
ALTER TABLE automations ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';
ALTER TABLE automations ADD COLUMN event_session_kind_filter TEXT;
ALTER TABLE automations ADD COLUMN event_metadata_filter TEXT;

-- Behaviour-preserving backfill: the persisted equivalent of the removed
-- AUTOMATION_TRIGGER_KINDS = ['work'] whitelist.
UPDATE automations
   SET event_session_kind_filter = '["work"]'
 WHERE trigger_type = 'event'
   AND event_topic IN ('run:started', 'run:settled');
