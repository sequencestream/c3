-- Intent lifecycle Schedule filters. Existing schedules remain unfiltered.
ALTER TABLE schedules ADD COLUMN event_intent_filter TEXT;
