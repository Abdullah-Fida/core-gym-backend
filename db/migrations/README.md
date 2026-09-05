# Migrations

Numbered, forward-only SQL migrations. Apply them **in order**, once each.

`../schema.sql` remains the full-schema snapshot for provisioning a brand-new
database from scratch. These files are the incremental path for a database that
already has data in it.

## Applying

Paste the file contents into the Supabase SQL editor, or:

```bash
psql "$DATABASE_URL" -f backend/db/migrations/001_phase1_security.sql
```

Every migration is written to be idempotent (`IF NOT EXISTS`, `ON CONFLICT DO
NOTHING`, guarded `DO $$` blocks) so re-running one is safe.

## Log

| # | File | Purpose |
|---|---|---|
| 001 | `001_phase1_security.sql` | `gyms.role` column, `password_resets` table, attendance de-duplication + unique index |
