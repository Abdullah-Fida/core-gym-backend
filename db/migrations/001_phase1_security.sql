-- ============================================================
-- 001 — Phase 1: security + attendance integrity
-- ============================================================
-- Idempotent. Safe to re-run.
--
-- 1. gyms.role            — stop deriving super-admin from plan_type
-- 2. password_resets      — replace the in-process OTP Map
-- 3. attendance unique    — kill the read-then-insert double check-in race
-- ============================================================


-- ── 1. gyms.role ────────────────────────────────────────────
-- Previously the login route computed:
--     role = (gym.plan_type === 'pro' || email in SUPER_ADMIN_EMAIL) ? 'admin' : 'gym_owner'
-- which handed full cross-tenant super-admin access to every paying 'pro'
-- customer. Role is now an explicit column, unrelated to billing.
--
-- NOTE: this deliberately does NOT backfill role='admin' for existing 'pro'
-- gyms — that would preserve the vulnerability. Real super admins are granted
-- by SUPER_ADMIN_EMAIL (self-healed on login) or by the UPDATE at the bottom
-- of this file.

ALTER TABLE gyms
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'gym_owner';

COMMENT ON COLUMN gyms.role IS
  'Platform role: gym_owner | admin. Independent of plan_type — never derive access from billing.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'gyms_role_check'
  ) THEN
    ALTER TABLE gyms
      ADD CONSTRAINT gyms_role_check CHECK (role IN ('gym_owner', 'admin'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_gyms_role ON gyms(role) WHERE role = 'admin';


-- ── 2. password_resets ──────────────────────────────────────
-- The OTP store was `const otps = new Map()` in auth.routes.js — process-local,
-- so it is empty on every cold start and unshared across instances. On Vercel
-- (serverless) password reset could never work reliably.
--
-- The OTP is stored hashed: a leaked DB row must not be replayable as a login.

CREATE TABLE IF NOT EXISTS password_resets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id      UUID REFERENCES gyms(id) ON DELETE CASCADE,
  phone       TEXT NOT NULL,
  otp_hash    TEXT NOT NULL,           -- bcrypt hash of the 6-digit code
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,             -- set when redeemed; a row is single-use
  attempts    INT NOT NULL DEFAULT 0,  -- brute-force guard, capped in the route
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_resets_phone
  ON password_resets(phone, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_password_resets_expiry
  ON password_resets(expires_at);

ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;
-- No policies, by design: only the backend's service role touches this table.
-- See the header of schema.sql.


-- ── 3. attendance de-duplication + unique index ─────────────
-- attendance.routes.js does a read-then-insert to keep check-ins idempotent per
-- day, which races under concurrent scans. schema.sql:386 had the index written
-- out but commented. Collapse existing duplicates first, then enforce it.

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY member_id, date
           ORDER BY check_in_time ASC, id ASC
         ) AS rn
  FROM attendance
)
DELETE FROM attendance
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_member_date_unique
  ON attendance(member_id, date);


-- ── 4. Grant your super admin ───────────────────────────────
-- Uncomment and set the address, or rely on SUPER_ADMIN_EMAIL — the login
-- route promotes a matching row automatically on first sign-in.
--
-- UPDATE gyms SET role = 'admin' WHERE email = 'you@example.com';
