-- ============================================================================
-- IRON FOST GYM — COMPLETE SUPABASE SCHEMA
-- ============================================================================
-- Paste this whole file into the Supabase SQL Editor and press Run.
--
-- SAFE TO RUN ON A DATABASE THAT ALREADY HAS DATA.
-- Every statement is idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
-- There are no DROP statements. Running it twice changes nothing the second
-- time. On a brand-new project it builds everything; on an existing project it
-- only adds what is missing.
--
-- One caveat to the "safe on existing data" claim: the four CREATE UNIQUE
-- INDEX statements below will ERROR (not silently skip) if the existing data
-- already violates them — e.g. two members in one gym sharing a fingerprint,
-- or two staff_attendance rows for the same staff on the same day. On a fresh
-- project this cannot happen. On an existing one, run the duplicate-check
-- SELECTs noted beside each index first.
--
-- SECURITY MODEL — read before adding any policy:
-- The Express backend connects with SUPABASE_SERVICE_ROLE_KEY, which bypasses
-- RLS entirely. The React frontend NEVER talks to Supabase directly; it only
-- calls the backend API. So RLS is enabled with ZERO policies on purpose:
-- that denies all anon/authenticated access while the service role keeps
-- working. Do not add permissive policies unless you deliberately move to
-- direct client access.
-- ============================================================================


-- ── Extensions ──────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- ============================================================================
-- 1. GYMS — tenant root / owner account
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.gyms (
    id                   UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    owner_name           TEXT NOT NULL,
    gym_name             TEXT NOT NULL,
    phone                TEXT NOT NULL,
    email                TEXT UNIQUE NOT NULL,
    auth_password_hash   TEXT NOT NULL,
    city                 TEXT,
    address              TEXT,
    plan_type            TEXT DEFAULT 'free',
    trial_ends_at        TIMESTAMPTZ,
    subscription_ends_at TIMESTAMPTZ,
    is_active            BOOLEAN DEFAULT true,
    last_login_at        TIMESTAMPTZ DEFAULT NOW(),
    default_monthly_fee  INTEGER DEFAULT 3000,
    attendance_active    BOOLEAN DEFAULT false,
    grace_period_days    INTEGER DEFAULT 0,
    wa_msg_active        TEXT,
    wa_msg_due_soon      TEXT,
    wa_msg_expired       TEXT,
    created_at           TIMESTAMPTZ DEFAULT NOW()
);

-- Patch older databases that predate these columns
ALTER TABLE public.gyms ADD COLUMN IF NOT EXISTS attendance_active   BOOLEAN DEFAULT false;
ALTER TABLE public.gyms ADD COLUMN IF NOT EXISTS grace_period_days   INTEGER DEFAULT 0;
ALTER TABLE public.gyms ADD COLUMN IF NOT EXISTS wa_msg_active       TEXT;
ALTER TABLE public.gyms ADD COLUMN IF NOT EXISTS wa_msg_due_soon     TEXT;
ALTER TABLE public.gyms ADD COLUMN IF NOT EXISTS wa_msg_expired      TEXT;
ALTER TABLE public.gyms ADD COLUMN IF NOT EXISTS default_monthly_fee INTEGER DEFAULT 3000;


-- ============================================================================
-- 2. MEMBERS — gym customers
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.members (
    id                UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    gym_id            UUID REFERENCES public.gyms(id) ON DELETE CASCADE,
    name              TEXT NOT NULL,
    phone             TEXT NOT NULL,
    membership_id     TEXT,
    cnic              TEXT,
    fingerprint_id    TEXT,
    gender            TEXT DEFAULT 'male',
    join_date         DATE DEFAULT CURRENT_DATE,
    -- Live values: active | inactive | trial | expired | deleted
    -- 'deleted' is the soft-delete tombstone that most queries filter out.
    -- NOTE: POST /api/members inserts with status 'inactive', so the 'expired'
    -- default only applies to rows written outside the API.
    status            TEXT DEFAULT 'expired',
    profile_photo_url TEXT,
    emergency_contact TEXT,
    notes             TEXT,
    -- Denormalized cache of the newest payment expiry. Recomputed by the API
    -- on payment insert and delete.
    latest_expiry     DATE,
    created_at        TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.members ADD COLUMN IF NOT EXISTS membership_id  TEXT;
ALTER TABLE public.members ADD COLUMN IF NOT EXISTS cnic           TEXT;
ALTER TABLE public.members ADD COLUMN IF NOT EXISTS fingerprint_id TEXT;
ALTER TABLE public.members ADD COLUMN IF NOT EXISTS gender         TEXT DEFAULT 'male';
ALTER TABLE public.members ADD COLUMN IF NOT EXISTS latest_expiry  DATE;


-- ============================================================================
-- 3. PAYMENTS — member fee log
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.payments (
    id                   UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    gym_id               UUID REFERENCES public.gyms(id) ON DELETE CASCADE,
    member_id            UUID REFERENCES public.members(id) ON DELETE CASCADE,
    amount               INTEGER NOT NULL,
    payment_date         DATE DEFAULT CURRENT_DATE,
    plan_duration_months TEXT NOT NULL,          -- '1', '3', ... or 'custom'
    custom_days          INTEGER DEFAULT 0,
    expiry_date          DATE NOT NULL,
    -- cash | bank_transfer | easypaisa | jazzcash | card
    payment_method       TEXT DEFAULT 'cash',
    received_by          TEXT,
    -- Registration/trial markers are encoded here by the API; there is
    -- deliberately no payment_type column.
    notes                TEXT,
    created_at           TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS custom_days INTEGER DEFAULT 0;


-- ============================================================================
-- 4. STAFF — gym employees
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.staff (
    id             UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    gym_id         UUID REFERENCES public.gyms(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    phone          TEXT,
    -- trainer | receptionist | cleaner | manager | security | other
    role           TEXT NOT NULL,
    custom_role    TEXT,
    join_date      DATE,
    monthly_salary INTEGER DEFAULT 0,
    -- active | inactive | terminated
    status         TEXT DEFAULT 'active',
    notes          TEXT,
    created_at     TIMESTAMPTZ DEFAULT NOW()
);


-- ============================================================================
-- 5. STAFF_PAYMENTS — salary log
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.staff_payments (
    id             UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    gym_id         UUID REFERENCES public.gyms(id) ON DELETE CASCADE,
    staff_id       UUID REFERENCES public.staff(id) ON DELETE CASCADE,
    month          INTEGER NOT NULL,
    year           INTEGER NOT NULL,
    amount_paid    INTEGER NOT NULL,
    paid_date      DATE DEFAULT CURRENT_DATE,
    payment_method TEXT DEFAULT 'cash',
    notes          TEXT,
    created_at     TIMESTAMPTZ DEFAULT NOW()
);


-- ============================================================================
-- 6. STAFF_ATTENDANCE — daily staff presence
-- Upserted by the API with onConflict 'staff_id,date', so the unique index
-- further down is REQUIRED for that endpoint to work.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.staff_attendance (
    id         UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    gym_id     UUID REFERENCES public.gyms(id) ON DELETE CASCADE,
    staff_id   UUID REFERENCES public.staff(id) ON DELETE CASCADE,
    date       DATE NOT NULL DEFAULT CURRENT_DATE,
    -- present | absent | half_day | leave
    status     TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);


-- ============================================================================
-- 7. EXPENSES — gym operational costs
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.expenses (
    id                UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    gym_id            UUID REFERENCES public.gyms(id) ON DELETE CASCADE,
    -- rent | electricity | equipment_repair | staff_bonus | marketing |
    -- cleaning | internet | water | fuel | supplements | custom
    category          TEXT NOT NULL,
    custom_category   TEXT,
    amount            INTEGER NOT NULL,
    expense_date      DATE DEFAULT CURRENT_DATE,
    description       TEXT,
    receipt_photo_url TEXT,
    is_recurring      BOOLEAN DEFAULT false,
    recurrence_day    INTEGER,
    logged_by         TEXT,
    created_at        TIMESTAMPTZ DEFAULT NOW()
);


-- ============================================================================
-- 8. NOTIFICATIONS — reminder queue + sent log
-- Types in use: member_fee_expiry_warning, automated_reminder
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.notifications (
    id                UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    gym_id            UUID REFERENCES public.gyms(id) ON DELETE CASCADE,
    member_id         UUID REFERENCES public.members(id) ON DELETE CASCADE,
    staff_id          UUID REFERENCES public.staff(id) ON DELETE CASCADE,
    notification_type TEXT NOT NULL,
    -- DEFAULT NOW() matters: POST /api/notifications forwards req.body
    -- .scheduled_for unchanged, so a caller that omits it would otherwise
    -- violate NOT NULL and the row would never be recorded.
    scheduled_for     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    recipient_phone   TEXT,
    message_template  TEXT,
    -- pending | sent | cancelled
    status            TEXT DEFAULT 'pending',
    sent_at           TIMESTAMPTZ,
    created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Apply the default to databases created before this fix
ALTER TABLE public.notifications ALTER COLUMN scheduled_for SET DEFAULT NOW();


-- ============================================================================
-- 9. ATTENDANCE — member check-ins
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.attendance (
    id             UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    gym_id         UUID REFERENCES public.gyms(id) ON DELETE CASCADE,
    member_id      UUID REFERENCES public.members(id) ON DELETE CASCADE,
    check_in_time  TIMESTAMPTZ DEFAULT NOW(),
    check_out_time TIMESTAMPTZ,
    date           DATE DEFAULT CURRENT_DATE
);


-- ============================================================================
-- 10. ACCESS_LOGS — biometric device log
-- NOTE: no route in this backend reads or writes this table yet. It is created
-- ahead of the hardware integration; dropping it would not affect the app.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.access_logs (
    id             UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    gym_id         UUID REFERENCES public.gyms(id) ON DELETE CASCADE,
    member_id      UUID REFERENCES public.members(id) ON DELETE CASCADE,
    fingerprint_id TEXT,
    timestamp      TIMESTAMPTZ DEFAULT NOW(),
    device         TEXT,
    -- GRANTED | DENIED | MEMBER_NOT_FOUND | EXPIRED
    status         TEXT,
    created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- gym_id was missing from the original design; added so this table matches the
-- tenant-isolation pattern every other table follows. It is nullable and the
-- API does not populate it yet, so existing inserts keep working unchanged.
ALTER TABLE public.access_logs ADD COLUMN IF NOT EXISTS gym_id UUID REFERENCES public.gyms(id) ON DELETE CASCADE;


-- ============================================================================
-- 11. ADMIN_NOTES — internal notes + audit trail
-- Audit rows use admin='AuditLog' with JSON in text:
--   {action, type, amount, payment_type, details}
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.admin_notes (
    id         UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    gym_id     UUID REFERENCES public.gyms(id) ON DELETE CASCADE,
    text       TEXT NOT NULL,
    admin      TEXT NOT NULL,
    date       TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);


-- ============================================================================
-- 12. FORM_DRAFTS — autosave of in-progress forms
-- Upserted with onConflict 'gym_id, page_id'.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.form_drafts (
    id         UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    gym_id     UUID REFERENCES public.gyms(id) ON DELETE CASCADE,
    page_id    TEXT NOT NULL,
    form_data  JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);


-- ============================================================================
-- 13. WHATSAPP_AUTH — Baileys WhatsApp session persistence
-- Survives server restarts so the gym does not re-scan the QR code.
-- Upserted with onConflict 'gym_id, key'.
-- NOTE: this backend has no Baileys dependency yet, so nothing writes here
-- today. Created ahead of that integration.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.whatsapp_auth (
    id         UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    gym_id     UUID REFERENCES public.gyms(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    data       JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);


-- ============================================================================
-- UNIQUE INDEXES
-- These are declared separately (not inline) so they get created on existing
-- databases too, where CREATE TABLE IF NOT EXISTS is a no-op.
-- Each one is an ON CONFLICT target the API depends on.
-- ============================================================================

-- One fingerprint per gym, ignoring members who have none enrolled.
-- Pre-flight on an existing DB:
--   SELECT gym_id, fingerprint_id, COUNT(*) FROM public.members
--     WHERE fingerprint_id IS NOT NULL
--     GROUP BY 1,2 HAVING COUNT(*) > 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_gym_fingerprint_unique
    ON public.members (gym_id, fingerprint_id)
    WHERE fingerprint_id IS NOT NULL;

-- Required by POST /api/attendance/staff  (onConflict 'staff_id,date')
-- Pre-flight:
--   SELECT staff_id, date, COUNT(*) FROM public.staff_attendance
--     GROUP BY 1,2 HAVING COUNT(*) > 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_attendance_unique
    ON public.staff_attendance (staff_id, date);

-- Required by POST /api/drafts  (onConflict 'gym_id, page_id')
CREATE UNIQUE INDEX IF NOT EXISTS idx_form_drafts_unique
    ON public.form_drafts (gym_id, page_id);

-- Required by the WhatsApp auth adapter  (onConflict 'gym_id, key')
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_auth_unique
    ON public.whatsapp_auth (gym_id, key);


-- ============================================================================
-- PERFORMANCE INDEXES
-- Every list endpoint filters by gym_id first, then by date or status.
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_members_gym            ON public.members (gym_id);
CREATE INDEX IF NOT EXISTS idx_members_gym_status     ON public.members (gym_id, status);
CREATE INDEX IF NOT EXISTS idx_members_expiry         ON public.members (gym_id, latest_expiry);

CREATE INDEX IF NOT EXISTS idx_payments_gym_date      ON public.payments (gym_id, payment_date DESC);
CREATE INDEX IF NOT EXISTS idx_payments_member        ON public.payments (member_id);

CREATE INDEX IF NOT EXISTS idx_attendance_gym_date    ON public.attendance (gym_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_member_date ON public.attendance (member_id, date);

CREATE INDEX IF NOT EXISTS idx_staff_gym              ON public.staff (gym_id);
CREATE INDEX IF NOT EXISTS idx_staff_payments_gym     ON public.staff_payments (gym_id, year, month);

CREATE INDEX IF NOT EXISTS idx_expenses_gym_date      ON public.expenses (gym_id, expense_date DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_gym      ON public.notifications (gym_id, status);
CREATE INDEX IF NOT EXISTS idx_notifications_member   ON public.notifications (member_id);

CREATE INDEX IF NOT EXISTS idx_access_logs_time       ON public.access_logs (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_admin_notes_gym        ON public.admin_notes (gym_id, date DESC);


-- ============================================================================
-- ROW LEVEL SECURITY
-- Enabled with no policies — see the header note. The backend's service role
-- key bypasses RLS; this simply blocks anon/authenticated clients from
-- reaching the tables directly.
-- ============================================================================
ALTER TABLE public.gyms             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.members          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_payments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_logs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_notes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.form_drafts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_auth    ENABLE ROW LEVEL SECURITY;


-- ============================================================================
-- OPTIONAL HARDENING — commented out on purpose. Read before enabling.
-- ============================================================================

-- (A) One check-in per member per day, enforced by the database.
--     The API currently does a read-then-insert, which can double-insert under
--     a race (two fingerprint scans in the same instant). The DELETE below
--     removes duplicates, keeping the earliest check-in of each day.
--     Run the SELECT first to see whether you have any at all.
--
-- SELECT member_id, date, COUNT(*) FROM public.attendance
--   GROUP BY member_id, date HAVING COUNT(*) > 1;
--
-- DELETE FROM public.attendance a USING public.attendance b
--   WHERE a.member_id = b.member_id
--     AND a.date = b.date
--     AND (a.check_in_time, a.id) > (b.check_in_time, b.id);
--
-- CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_unique
--   ON public.attendance (member_id, date);

-- (B) Constrain member status to the five values the app actually uses.
--     Verify nothing else is stored first, or the constraint will fail:
--
-- SELECT DISTINCT status FROM public.members;
--
-- ALTER TABLE public.members ADD CONSTRAINT members_status_check
--   CHECK (status IN ('active', 'inactive', 'trial', 'expired', 'deleted'));
