-- ============================================================
-- 004 — Phase 5: bulk import tracking
-- ============================================================
-- Idempotent. Safe to re-run. Requires 001–003.
--
-- Adds `import_batch` to every importable table.
--
-- Supabase's REST API offers no interactive transaction, so a multi-chunk
-- insert cannot be wrapped in BEGIN/COMMIT. Instead every row written by one
-- import request carries the same batch id: if a later chunk fails, the route
-- deletes that batch, and the same token lets the user undo a completed import
-- from the UI. A half-imported file is worse than a failed one, because the
-- owner cannot tell what is missing.
-- ============================================================

ALTER TABLE members  ADD COLUMN IF NOT EXISTS import_batch UUID;
ALTER TABLE staff    ADD COLUMN IF NOT EXISTS import_batch UUID;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS import_batch UUID;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS import_batch UUID;

COMMENT ON COLUMN members.import_batch IS
  'Set when the row arrived via bulk import. Groups one import for rollback; NULL for manually created rows.';

-- Partial indexes: the vast majority of rows are entered by hand and have NULL
-- here, so there is no reason to index them.
CREATE INDEX IF NOT EXISTS idx_members_import_batch
  ON members(import_batch) WHERE import_batch IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_staff_import_batch
  ON staff(import_batch) WHERE import_batch IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_import_batch
  ON payments(import_batch) WHERE import_batch IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_expenses_import_batch
  ON expenses(import_batch) WHERE import_batch IS NOT NULL;
