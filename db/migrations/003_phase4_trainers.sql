-- ============================================================
-- 003 — Phase 4: trainers, PT packages, commission
-- ============================================================
-- Idempotent. Safe to re-run. Requires 001 and 002.
--
-- Builds on the existing `staff` table, where trainers are rows with
-- role = 'trainer'. Nothing here creates a second people table.
--
-- 1. trainer_assignments  — which trainer looks after which member
-- 2. pt_packages          — sellable personal-training packages
-- 3. pt_subscriptions     — a member's purchased package + session balance
-- 4. pt_sessions          — one logged session, decrements the balance
-- 5. trainer_commissions  — accrued earnings, settled via staff_payments
-- ============================================================


-- ── 1. trainer_assignments ──────────────────────────────────
-- History, not a single column on `members`: a member changes trainer over
-- time and past commission must stay attributable to whoever earned it.

CREATE TABLE IF NOT EXISTS trainer_assignments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id      UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  member_id   UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  staff_id    UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  is_primary  BOOLEAN NOT NULL DEFAULT TRUE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at    TIMESTAMPTZ,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN trainer_assignments.ended_at IS
  'NULL means the assignment is live. Rows are closed, never deleted, so historic commission stays attributable.';

CREATE INDEX IF NOT EXISTS idx_trainer_assignments_member ON trainer_assignments(member_id, ended_at);
CREATE INDEX IF NOT EXISTS idx_trainer_assignments_staff ON trainer_assignments(staff_id, ended_at);
CREATE INDEX IF NOT EXISTS idx_trainer_assignments_gym ON trainer_assignments(gym_id);

-- A member may have only one live primary trainer. Enforced in the database
-- rather than by a read-then-write check, which races under concurrent saves.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_member_primary_trainer
  ON trainer_assignments(member_id)
  WHERE ended_at IS NULL AND is_primary;


-- ── 2. pt_packages ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pt_packages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id           UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  description      TEXT,
  sessions_total   INTEGER NOT NULL CHECK (sessions_total > 0),
  price            NUMERIC(12, 2) NOT NULL CHECK (price >= 0),
  validity_days    INTEGER NOT NULL DEFAULT 90 CHECK (validity_days > 0),
  commission_type  TEXT NOT NULL DEFAULT 'percent',
  commission_value NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (commission_value >= 0),
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN pt_packages.commission_type IS
  'percent = commission_value%% of the sale price; flat = commission_value per session.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pt_packages_commission_type_check') THEN
    ALTER TABLE pt_packages ADD CONSTRAINT pt_packages_commission_type_check
      CHECK (commission_type IN ('percent', 'flat'));
  END IF;
  -- A percentage over 100 is always a data-entry slip, not a real deal.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pt_packages_percent_range_check') THEN
    ALTER TABLE pt_packages ADD CONSTRAINT pt_packages_percent_range_check
      CHECK (commission_type <> 'percent' OR commission_value <= 100);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pt_packages_gym ON pt_packages(gym_id, is_active);


-- ── 3. pt_subscriptions ─────────────────────────────────────
-- A member's purchase. `sessions_used` is maintained by the session insert and
-- delete paths, and guarded so it can never exceed what was bought.

CREATE TABLE IF NOT EXISTS pt_subscriptions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id         UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  member_id      UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  staff_id       UUID NOT NULL REFERENCES staff(id),
  package_id     UUID REFERENCES pt_packages(id),
  -- Denormalised on purpose: the package can be renamed or repriced later, and
  -- a sold subscription must keep the terms it was sold on.
  package_name   TEXT NOT NULL,
  sessions_total INTEGER NOT NULL CHECK (sessions_total > 0),
  sessions_used  INTEGER NOT NULL DEFAULT 0 CHECK (sessions_used >= 0),
  price_paid     NUMERIC(12, 2) NOT NULL DEFAULT 0,
  starts_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pt_subscriptions_used_within_total CHECK (sessions_used <= sessions_total)
);

COMMENT ON COLUMN pt_subscriptions.status IS 'active | completed | expired | cancelled';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pt_subscriptions_status_check') THEN
    ALTER TABLE pt_subscriptions ADD CONSTRAINT pt_subscriptions_status_check
      CHECK (status IN ('active', 'completed', 'expired', 'cancelled'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pt_subs_member ON pt_subscriptions(member_id, status);
CREATE INDEX IF NOT EXISTS idx_pt_subs_staff ON pt_subscriptions(staff_id, status);
CREATE INDEX IF NOT EXISTS idx_pt_subs_gym ON pt_subscriptions(gym_id);


-- ── 4. pt_sessions ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pt_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id          UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  subscription_id UUID NOT NULL REFERENCES pt_subscriptions(id) ON DELETE CASCADE,
  member_id       UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  staff_id        UUID NOT NULL REFERENCES staff(id),
  session_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  duration_min    INTEGER,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pt_sessions_sub ON pt_sessions(subscription_id, session_date DESC);
CREATE INDEX IF NOT EXISTS idx_pt_sessions_staff ON pt_sessions(staff_id, session_date DESC);
CREATE INDEX IF NOT EXISTS idx_pt_sessions_gym ON pt_sessions(gym_id, session_date DESC);


-- ── 5. trainer_commissions ──────────────────────────────────
-- Accrues on sale (percent packages) or per session (flat packages), and is
-- settled through the existing staff_payments flow so trainer payouts land in
-- the same profit-and-loss the owner already reads.

CREATE TABLE IF NOT EXISTS trainer_commissions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id          UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  staff_id        UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  member_id       UUID REFERENCES members(id) ON DELETE SET NULL,
  subscription_id UUID REFERENCES pt_subscriptions(id) ON DELETE CASCADE,
  session_id      UUID REFERENCES pt_sessions(id) ON DELETE CASCADE,
  amount          NUMERIC(12, 2) NOT NULL,
  source          TEXT NOT NULL DEFAULT 'package_sale',
  status          TEXT NOT NULL DEFAULT 'pending',
  earned_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at      TIMESTAMPTZ,
  -- Set when a payout is recorded, linking the accrual to the money that paid it.
  staff_payment_id UUID REFERENCES staff_payments(id) ON DELETE SET NULL,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN trainer_commissions.source IS 'package_sale | session';
COMMENT ON COLUMN trainer_commissions.status IS 'pending | paid | cancelled';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trainer_commissions_status_check') THEN
    ALTER TABLE trainer_commissions ADD CONSTRAINT trainer_commissions_status_check
      CHECK (status IN ('pending', 'paid', 'cancelled'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trainer_commissions_source_check') THEN
    ALTER TABLE trainer_commissions ADD CONSTRAINT trainer_commissions_source_check
      CHECK (source IN ('package_sale', 'session'));
  END IF;
END $$;

-- One commission row per session; a double-logged session must not pay twice.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_commission_per_session
  ON trainer_commissions(session_id)
  WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_commissions_staff ON trainer_commissions(staff_id, status, earned_at DESC);
CREATE INDEX IF NOT EXISTS idx_commissions_gym ON trainer_commissions(gym_id, earned_at DESC);


-- ── 6. staff_payments: distinguish salary from commission ───
ALTER TABLE staff_payments
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'salary';

COMMENT ON COLUMN staff_payments.kind IS 'salary | commission';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_payments_kind_check') THEN
    ALTER TABLE staff_payments ADD CONSTRAINT staff_payments_kind_check
      CHECK (kind IN ('salary', 'commission'));
  END IF;
END $$;

-- The existing month+year uniqueness was written for salary, which is paid once
-- a month. Commission payouts can happen more than once in a month, so scope
-- that rule to salary rows only.
DROP INDEX IF EXISTS uniq_staff_salary_month;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_staff_salary_month
  ON staff_payments(staff_id, month, year)
  WHERE kind = 'salary';
