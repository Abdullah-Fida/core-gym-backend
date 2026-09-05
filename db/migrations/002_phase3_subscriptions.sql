-- ============================================================
-- 002 — Phase 3: platform plans, subscriptions, locale
-- ============================================================
-- Idempotent. Safe to re-run. Requires 001.
--
-- 1. plans                — replaces the hardcoded {free:0,basic:2000,pro:5000}
-- 2. gyms.*               — plan_id, trial/subscription split, locale columns
-- 3. platform_payments    — real money table; ends the admin_notes overload
-- 4. subscription_events  — audit trail for every lifecycle change
-- 5. backfill             — migrates existing admin_notes ledger rows
-- ============================================================


-- ── 1. plans ────────────────────────────────────────────────
-- Platform subscription tiers, previously a literal object in two places:
--   backend/routes/admin.routes.js  (/metrics MRR calculation)
--   src/features/admin/AdminSubscriptionsPage.jsx
-- so pricing could silently disagree between the dashboard and the invoice.

CREATE TABLE IF NOT EXISTS plans (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  description     TEXT,
  price           NUMERIC(12, 2) NOT NULL DEFAULT 0,
  currency        TEXT NOT NULL DEFAULT 'PKR',
  billing_period  TEXT NOT NULL DEFAULT 'month',
  member_limit    INTEGER,
  staff_limit     INTEGER,
  features        JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN plans.member_limit IS 'NULL means unlimited.';
COMMENT ON COLUMN plans.billing_period IS 'month | year | one_time';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plans_billing_period_check') THEN
    ALTER TABLE plans ADD CONSTRAINT plans_billing_period_check
      CHECK (billing_period IN ('month', 'year', 'one_time'));
  END IF;
END $$;

-- Seed the three tiers that were hardcoded, so existing gyms keep their prices.
INSERT INTO plans (code, name, description, price, currency, billing_period, member_limit, sort_order, features)
VALUES
  ('free',  'Free',  'Trial access with core features.',         0, 'PKR', 'month',  50,  0,
   '{"members":true,"payments":true,"attendance":true,"reports":false,"whatsapp":false,"trainers":false}'::jsonb),
  ('basic', 'Basic', 'For single-location gyms.',             2000, 'PKR', 'month', 300,  1,
   '{"members":true,"payments":true,"attendance":true,"reports":true,"whatsapp":false,"trainers":true}'::jsonb),
  ('pro',   'Pro',   'Unlimited members and every module.',    5000, 'PKR', 'month', NULL, 2,
   '{"members":true,"payments":true,"attendance":true,"reports":true,"whatsapp":true,"trainers":true}'::jsonb)
ON CONFLICT (code) DO NOTHING;


-- ── 2. gyms: subscription + locale ──────────────────────────
ALTER TABLE gyms
  ADD COLUMN IF NOT EXISTS plan_id         UUID REFERENCES plans(id),
  ADD COLUMN IF NOT EXISTS billing_status  TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS subscription_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS currency        TEXT NOT NULL DEFAULT 'PKR',
  ADD COLUMN IF NOT EXISTS timezone        TEXT NOT NULL DEFAULT 'Asia/Karachi',
  ADD COLUMN IF NOT EXISTS locale          TEXT NOT NULL DEFAULT 'en-PK',
  ADD COLUMN IF NOT EXISTS payment_methods JSONB NOT NULL DEFAULT '["cash","card","bank_transfer"]'::jsonb;

COMMENT ON COLUMN gyms.billing_status IS 'trialing | active | past_due | suspended | cancelled';
COMMENT ON COLUMN gyms.timezone IS
  'IANA zone. Every day-boundary calculation (attendance, expiry, reminders) must use this, not server-local time.';
COMMENT ON COLUMN gyms.trial_ends_at IS
  'When the free trial ends. Distinct from subscription_ends_at — earlier code wrote the same value to both.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gyms_billing_status_check') THEN
    ALTER TABLE gyms ADD CONSTRAINT gyms_billing_status_check
      CHECK (billing_status IN ('trialing', 'active', 'past_due', 'suspended', 'cancelled'));
  END IF;
END $$;

-- Link existing gyms to the seeded plan matching their plan_type string.
UPDATE gyms g
   SET plan_id = p.id
  FROM plans p
 WHERE g.plan_id IS NULL
   AND p.code = COALESCE(g.plan_type, 'free');

-- Existing rows had trial_ends_at written as a copy of subscription_ends_at.
-- A paid gym is not on trial, so clear the copy rather than leave a misleading
-- date that makes /metrics count paying customers as trials.
UPDATE gyms
   SET trial_ends_at = NULL
 WHERE trial_ends_at IS NOT NULL
   AND trial_ends_at = subscription_ends_at
   AND plan_type <> 'free';

UPDATE gyms
   SET billing_status = CASE
         WHEN is_active = FALSE THEN 'suspended'
         WHEN trial_ends_at IS NOT NULL AND trial_ends_at > NOW() THEN 'trialing'
         WHEN subscription_ends_at IS NOT NULL AND subscription_ends_at < NOW() THEN 'past_due'
         ELSE 'active'
       END
 WHERE billing_status = 'active';

CREATE INDEX IF NOT EXISTS idx_gyms_plan_id ON gyms(plan_id);
CREATE INDEX IF NOT EXISTS idx_gyms_billing_status ON gyms(billing_status);


-- ── 3. platform_payments ────────────────────────────────────
-- All platform revenue previously lived in admin_notes.text as a JSON *string*,
-- keyed by the magic value admin='PaymentSystem'. That column was triple-purposed
-- (human notes, audit log, money), amounts could not be summed in SQL, and one
-- malformed row broke the entire revenue figure.

CREATE TABLE IF NOT EXISTS platform_payments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id      UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  amount      NUMERIC(12, 2) NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'PKR',
  kind        TEXT NOT NULL DEFAULT 'subscription',
  note        TEXT,
  paid_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN platform_payments.kind IS 'subscription | setup | refund | adjustment';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_payments_kind_check') THEN
    ALTER TABLE platform_payments ADD CONSTRAINT platform_payments_kind_check
      CHECK (kind IN ('subscription', 'setup', 'refund', 'adjustment'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_platform_payments_gym ON platform_payments(gym_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_payments_paid_at ON platform_payments(paid_at DESC);


-- ── 4. subscription_events ──────────────────────────────────
CREATE TABLE IF NOT EXISTS subscription_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id      UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  event       TEXT NOT NULL,
  from_state  JSONB,
  to_state    JSONB,
  actor       TEXT,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN subscription_events.event IS
  'created | trial_started | trial_converted | extended | shortened | plan_changed | suspended | reactivated | cancelled';

CREATE INDEX IF NOT EXISTS idx_subscription_events_gym ON subscription_events(gym_id, created_at DESC);


-- ── 5. backfill the ledger out of admin_notes ───────────────
-- Rows whose text does not parse as a JSON object with a numeric amount are
-- skipped rather than silently imported as zero.

INSERT INTO platform_payments (gym_id, amount, currency, kind, note, paid_at, created_by)
SELECT
  n.gym_id,
  (n.text::jsonb ->> 'amount')::numeric,
  COALESCE(g.currency, 'PKR'),
  CASE WHEN UPPER(COALESCE(n.text::jsonb ->> 'type', '')) = 'SETUP' THEN 'setup' ELSE 'subscription' END,
  n.text::jsonb ->> 'note',
  COALESCE(n.date, (n.text::jsonb ->> 'date')::timestamptz),
  'migration_002'
FROM admin_notes n
JOIN gyms g ON g.id = n.gym_id
WHERE n.admin = 'PaymentSystem'
  AND n.text IS NOT NULL
  AND n.text <> ''
  AND jsonb_typeof(n.text::jsonb) = 'object'
  AND (n.text::jsonb ->> 'amount') ~ '^-?[0-9]+(\.[0-9]+)?$'
  AND NOT EXISTS (
    SELECT 1 FROM platform_payments pp
     WHERE pp.gym_id = n.gym_id
       AND pp.created_by = 'migration_002'
       AND pp.amount = (n.text::jsonb ->> 'amount')::numeric
       AND pp.paid_at = COALESCE(n.date, (n.text::jsonb ->> 'date')::timestamptz)
  );

-- The old admin_notes rows are intentionally left in place. Verify the totals
-- match, then remove them:
--   DELETE FROM admin_notes WHERE admin = 'PaymentSystem';
