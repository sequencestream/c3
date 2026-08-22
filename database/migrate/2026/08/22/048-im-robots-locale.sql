-- im_robots.locale — robot registry copy language (nullable = system default en)
-- Robots that exist at migration time receive zh to preserve prior Chinese UX.

ALTER TABLE im_robots ADD COLUMN locale TEXT
  CHECK(locale IS NULL OR locale IN ('en','zh','ja','ko','ru'));

UPDATE im_robots SET locale = 'zh';
