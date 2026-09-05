-- ============================================================
-- 006 — Phase 7: classes, leads, POS, measurements
-- ============================================================
-- Idempotent. Safe to re-run. Requires 001–005.
--
-- 1. class_templates / class_sessions / class_bookings
-- 2. leads / lead_activities
-- 3. products / stock_movements / sales / sale_items
-- 4. member_measurements
-- ============================================================


-- ════════════════════════════════════════════════════════════
-- 1. CLASSES
-- ════════════════════════════════════════════════════════════
-- Split into template and session deliberately. A recurring class is one
-- definition ("Yoga, Mon/Wed/Fri 7am, cap 20") but each occurrence needs its
-- own bookings, its own attendance and its own cancellation, so occurrences
-- are materialised as rows rather than computed on read.

CREATE TABLE IF NOT EXISTS class_templates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id        UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,
  staff_id      UUID REFERENCES staff(id) ON DELETE SET NULL,
  capacity      INTEGER NOT NULL DEFAULT 20 CHECK (capacity > 0),
  duration_min  INTEGER NOT NULL DEFAULT 60 CHECK (duration_min > 0),
  -- 0 = Sunday … 6 = Saturday, matching JavaScript's getDay().
  weekdays      INTEGER[] NOT NULL DEFAULT '{}',
  start_time    TIME NOT NULL DEFAULT '07:00',
  color         TEXT NOT NULL DEFAULT 'accent',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN class_templates.weekdays IS
  'Days this class runs. 0=Sun..6=Sat, matching JS getDay() so no translation is needed client-side.';

CREATE INDEX IF NOT EXISTS idx_class_templates_gym ON class_templates(gym_id, is_active);


CREATE TABLE IF NOT EXISTS class_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id       UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  template_id  UUID REFERENCES class_templates(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  staff_id     UUID REFERENCES staff(id) ON DELETE SET NULL,
  starts_at    TIMESTAMPTZ NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 60,
  capacity     INTEGER NOT NULL DEFAULT 20 CHECK (capacity > 0),
  status       TEXT NOT NULL DEFAULT 'scheduled',
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN class_sessions.status IS 'scheduled | cancelled | completed';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'class_sessions_status_check') THEN
    ALTER TABLE class_sessions ADD CONSTRAINT class_sessions_status_check
      CHECK (status IN ('scheduled', 'cancelled', 'completed'));
  END IF;
END $$;

-- Generating a recurring class twice must not create duplicate occurrences.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_class_session_slot
  ON class_sessions(template_id, starts_at)
  WHERE template_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_class_sessions_gym_date ON class_sessions(gym_id, starts_at);


CREATE TABLE IF NOT EXISTS class_bookings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id      UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  session_id  UUID NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
  member_id   UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'booked',
  -- NULL for a confirmed booking; 1-based queue position when waitlisted.
  waitlist_pos INTEGER,
  booked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attended_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN class_bookings.status IS 'booked | waitlisted | attended | no_show | cancelled';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'class_bookings_status_check') THEN
    ALTER TABLE class_bookings ADD CONSTRAINT class_bookings_status_check
      CHECK (status IN ('booked', 'waitlisted', 'attended', 'no_show', 'cancelled'));
  END IF;
END $$;

-- One live booking per member per session. Enforced here rather than by a
-- read-then-insert check, which races when a member double-taps Book.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_booking
  ON class_bookings(session_id, member_id)
  WHERE status <> 'cancelled';

CREATE INDEX IF NOT EXISTS idx_class_bookings_session ON class_bookings(session_id, status);
CREATE INDEX IF NOT EXISTS idx_class_bookings_member ON class_bookings(member_id, booked_at DESC);


-- ════════════════════════════════════════════════════════════
-- 2. LEADS / ENQUIRY CRM
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS leads (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id        UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  phone         TEXT,
  email         TEXT,
  source        TEXT NOT NULL DEFAULT 'walk_in',
  status        TEXT NOT NULL DEFAULT 'new',
  interest      TEXT,
  assigned_to   UUID REFERENCES staff(id) ON DELETE SET NULL,
  follow_up_at  DATE,
  notes         TEXT,
  -- Set when the lead becomes a paying member, so conversion is measurable.
  converted_member_id UUID REFERENCES members(id) ON DELETE SET NULL,
  converted_at  TIMESTAMPTZ,
  lost_reason   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN leads.source IS 'walk_in | referral | social | website | phone | other';
COMMENT ON COLUMN leads.status IS 'new | contacted | trial_booked | negotiating | converted | lost';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_status_check') THEN
    ALTER TABLE leads ADD CONSTRAINT leads_status_check
      CHECK (status IN ('new', 'contacted', 'trial_booked', 'negotiating', 'converted', 'lost'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_source_check') THEN
    ALTER TABLE leads ADD CONSTRAINT leads_source_check
      CHECK (source IN ('walk_in', 'referral', 'social', 'website', 'phone', 'other'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_leads_gym_status ON leads(gym_id, status);
-- Drives the "who do I call today" list; partial because converted and lost
-- leads never need following up.
CREATE INDEX IF NOT EXISTS idx_leads_followup
  ON leads(gym_id, follow_up_at)
  WHERE status NOT IN ('converted', 'lost');


CREATE TABLE IF NOT EXISTS lead_activities (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id     UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  lead_id    UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'note',
  body       TEXT,
  actor      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN lead_activities.kind IS 'note | call | whatsapp | visit | status_change';

CREATE INDEX IF NOT EXISTS idx_lead_activities_lead ON lead_activities(lead_id, created_at DESC);


-- ════════════════════════════════════════════════════════════
-- 3. POS / INVENTORY
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS products (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id         UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  sku            TEXT,
  category       TEXT NOT NULL DEFAULT 'supplement',
  price          NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  -- Cost is what the gym paid. Kept so margin is reportable, not just revenue.
  cost           NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  stock          INTEGER NOT NULL DEFAULT 0,
  low_stock_at   INTEGER NOT NULL DEFAULT 5,
  track_stock    BOOLEAN NOT NULL DEFAULT TRUE,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN products.category IS 'supplement | drink | apparel | equipment | service | other';
COMMENT ON COLUMN products.track_stock IS
  'FALSE for services (a day pass, a locker) which have no physical stock to decrement.';

CREATE UNIQUE INDEX IF NOT EXISTS uniq_product_sku
  ON products(gym_id, sku) WHERE sku IS NOT NULL AND sku <> '';
CREATE INDEX IF NOT EXISTS idx_products_gym ON products(gym_id, is_active);
-- Powers the low-stock alert without scanning the whole catalogue.
CREATE INDEX IF NOT EXISTS idx_products_low_stock
  ON products(gym_id) WHERE track_stock AND is_active;


CREATE TABLE IF NOT EXISTS sales (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id       UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  member_id    UUID REFERENCES members(id) ON DELETE SET NULL,
  subtotal     NUMERIC(12, 2) NOT NULL DEFAULT 0,
  discount     NUMERIC(12, 2) NOT NULL DEFAULT 0,
  total        NUMERIC(12, 2) NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT 'cash',
  sold_by      TEXT,
  note         TEXT,
  status       TEXT NOT NULL DEFAULT 'completed',
  sold_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN sales.status IS 'completed | refunded';
COMMENT ON COLUMN sales.member_id IS 'NULL for a walk-in sale to a non-member.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_status_check') THEN
    ALTER TABLE sales ADD CONSTRAINT sales_status_check
      CHECK (status IN ('completed', 'refunded'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sales_gym_date ON sales(gym_id, sold_at DESC);


CREATE TABLE IF NOT EXISTS sale_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id      UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  sale_id     UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id  UUID REFERENCES products(id) ON DELETE SET NULL,
  -- Snapshotted: renaming or repricing a product must not rewrite past receipts.
  name        TEXT NOT NULL,
  unit_price  NUMERIC(12, 2) NOT NULL,
  unit_cost   NUMERIC(12, 2) NOT NULL DEFAULT 0,
  quantity    INTEGER NOT NULL CHECK (quantity > 0),
  line_total  NUMERIC(12, 2) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id);


-- Every stock change, so a discrepancy can be traced rather than guessed at.
CREATE TABLE IF NOT EXISTS stock_movements (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id      UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  product_id  UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  -- Negative for a sale, positive for a restock.
  delta       INTEGER NOT NULL,
  reason      TEXT NOT NULL DEFAULT 'sale',
  sale_id     UUID REFERENCES sales(id) ON DELETE SET NULL,
  note        TEXT,
  actor       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN stock_movements.reason IS 'sale | restock | adjustment | refund | damage';

CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id, created_at DESC);


-- ════════════════════════════════════════════════════════════
-- 4. MEMBER MEASUREMENTS
-- ════════════════════════════════════════════════════════════
-- All optional: a gym that only ever records weight should not be forced to
-- fill in eight circumferences.

CREATE TABLE IF NOT EXISTS member_measurements (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id        UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  member_id     UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  recorded_on   DATE NOT NULL DEFAULT CURRENT_DATE,
  weight_kg     NUMERIC(6, 2),
  height_cm     NUMERIC(6, 2),
  body_fat_pct  NUMERIC(5, 2),
  muscle_mass_kg NUMERIC(6, 2),
  chest_cm      NUMERIC(6, 2),
  waist_cm      NUMERIC(6, 2),
  hips_cm       NUMERIC(6, 2),
  arm_cm        NUMERIC(6, 2),
  thigh_cm      NUMERIC(6, 2),
  note          TEXT,
  recorded_by   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One entry per member per day: a correction should edit that day's row, not
-- add a second one that makes the progress chart zig-zag.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_measurement_per_day
  ON member_measurements(member_id, recorded_on);

CREATE INDEX IF NOT EXISTS idx_measurements_member ON member_measurements(member_id, recorded_on DESC);

-- Date of birth is needed by the Phase 6 birthday automation and was never
-- added; without it that automation can never match anyone.
ALTER TABLE members ADD COLUMN IF NOT EXISTS date_of_birth DATE;
ALTER TABLE members ADD COLUMN IF NOT EXISTS gender TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS goal TEXT;

COMMENT ON COLUMN members.goal IS 'weight_loss | muscle_gain | endurance | general | rehab';
