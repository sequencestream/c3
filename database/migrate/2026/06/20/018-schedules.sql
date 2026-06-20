-- v8 (2026-06-20): model-published PR operation event triggers (pr:operation).
-- Add event_pr_filter to carry the optional PR operation/result filter (JSON
-- {operations?,results?}) for schedules subscribed to the model-published
-- `pr:operation` event. NULL for cron and run-lifecycle rows (= any PR op), so
-- their behaviour is unchanged. `event_topic` (already TEXT) needs no change — it
-- now also accepts the value 'pr:operation'. Idempotent via columnExists guard in
-- the store; legacy rows backfill to NULL.
ALTER TABLE schedules ADD COLUMN event_pr_filter TEXT;
