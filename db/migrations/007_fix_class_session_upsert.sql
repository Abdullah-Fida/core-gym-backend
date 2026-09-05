-- ============================================================
-- 007 — Fix: class session upsert
-- ============================================================
-- Idempotent. Safe to re-run. Requires 006.
--
-- 006 created uniq_class_session_slot as a PARTIAL unique index:
--
--   CREATE UNIQUE INDEX uniq_class_session_slot
--     ON class_sessions(template_id, starts_at)
--     WHERE template_id IS NOT NULL;
--
-- Postgres will not match `ON CONFLICT (template_id, starts_at)` to a partial
-- index unless the statement repeats the index predicate, and PostgREST's
-- upsert cannot send one. So POST /api/classes/sessions/generate failed with
--   "there is no unique or exclusion constraint matching the ON CONFLICT
--    specification"
-- and no schedule could be built at all.
--
-- The predicate was never needed: Postgres treats NULLs as distinct in a unique
-- index, so ad-hoc sessions (template_id IS NULL) never collide with each other
-- even without it.
-- ============================================================

DROP INDEX IF EXISTS uniq_class_session_slot;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_class_session_slot
  ON class_sessions(template_id, starts_at);

COMMENT ON INDEX uniq_class_session_slot IS
  'Stops the schedule generator creating a second copy of an occurrence that may already have bookings. Must stay non-partial so ON CONFLICT can match it.';
