-- ========================================================
-- CORE GYM (MVP) - PERFECT DATABASE SCHEMA
-- Note: This will drop existing tables to give you a clean slate.
-- ========================================================

-- Enable uuid-ossp extension for UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 0. DROP EXISTING TABLES TO ENSURE CLEAN BUILD
DROP TABLE IF EXISTS public.admin_notes CASCADE;
DROP TABLE IF EXISTS public.attendance CASCADE;
DROP TABLE IF EXISTS public.notifications CASCADE;
DROP TABLE IF EXISTS public.expenses CASCADE;
DROP TABLE IF EXISTS public.payments CASCADE;
DROP TABLE IF EXISTS public.members CASCADE;
DROP TABLE IF EXISTS public.staff_payments CASCADE;
DROP TABLE IF EXISTS public.staff CASCADE;
DROP TABLE IF EXISTS public.gyms CASCADE;

-- 1. GYMS TABLE (The core tenants / owners)
CREATE TABLE public.gyms (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    owner_name TEXT NOT NULL,
    gym_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    auth_password_hash TEXT NOT NULL,
    city TEXT,
    address TEXT,
    plan_type TEXT DEFAULT 'free',
    trial_ends_at TIMESTAMPTZ,
    subscription_ends_at TIMESTAMPTZ,
    is_active BOOLEAN DEFAULT true,
    last_login_at TIMESTAMPTZ DEFAULT NOW(),
    default_monthly_fee INTEGER DEFAULT 3000,
    attendance_active BOOLEAN DEFAULT false,
    wa_msg_active TEXT,
    wa_msg_due_soon TEXT,
    wa_msg_expired TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. STAFF TABLE (Gym Employees)
CREATE TABLE public.staff (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    gym_id UUID REFERENCES public.gyms(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    phone TEXT,
    role TEXT NOT NULL,
    custom_role TEXT,
    join_date DATE,
    monthly_salary INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. STAFF PAYMENTS TABLE (Salary logs)
CREATE TABLE public.staff_payments (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    gym_id UUID REFERENCES public.gyms(id) ON DELETE CASCADE,
    staff_id UUID REFERENCES public.staff(id) ON DELETE CASCADE,
    month INTEGER NOT NULL,
    year INTEGER NOT NULL,
    amount_paid INTEGER NOT NULL,
    paid_date DATE DEFAULT CURRENT_DATE,
    payment_method TEXT DEFAULT 'cash',
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. MEMBERS TABLE (Gym Customers)
CREATE TABLE public.members (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    gym_id UUID REFERENCES public.gyms(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    fingerprint_id TEXT,
    join_date DATE DEFAULT CURRENT_DATE,
    status TEXT DEFAULT 'expired',
    profile_photo_url TEXT,
    emergency_contact TEXT,
    notes TEXT,
    latest_expiry DATE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. PAYMENTS TABLE (Member fee logs)
CREATE TABLE public.payments (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    gym_id UUID REFERENCES public.gyms(id) ON DELETE CASCADE,
    member_id UUID REFERENCES public.members(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL,
    payment_date DATE DEFAULT CURRENT_DATE,
    plan_duration_months TEXT NOT NULL, -- e.g., '1', '3', or 'custom'
    custom_days INTEGER DEFAULT 0,
    expiry_date DATE NOT NULL,
    payment_method TEXT DEFAULT 'cash',
    received_by TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. EXPENSES TABLE (Gym operational costs)
CREATE TABLE public.expenses (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    gym_id UUID REFERENCES public.gyms(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    custom_category TEXT,
    amount INTEGER NOT NULL,
    expense_date DATE DEFAULT CURRENT_DATE,
    description TEXT,
    receipt_photo_url TEXT,
    is_recurring BOOLEAN DEFAULT false,
    recurrence_day INTEGER,
    logged_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. NOTIFICATIONS TABLE (Reminders to be sent out)
CREATE TABLE public.notifications (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    gym_id UUID REFERENCES public.gyms(id) ON DELETE CASCADE,
    member_id UUID REFERENCES public.members(id) ON DELETE CASCADE,
    staff_id UUID REFERENCES public.staff(id) ON DELETE CASCADE,
    notification_type TEXT NOT NULL,
    scheduled_for TIMESTAMPTZ NOT NULL,
    recipient_phone TEXT,
    message_template TEXT,
    status TEXT DEFAULT 'pending', -- pending, sent, cancelled
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. ATTENDANCE TABLE (Daily check-ins)
CREATE TABLE public.attendance (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    gym_id UUID REFERENCES public.gyms(id) ON DELETE CASCADE,
    member_id UUID REFERENCES public.members(id) ON DELETE CASCADE,
    check_in_time TIMESTAMPTZ DEFAULT NOW(),
    check_out_time TIMESTAMPTZ,
    date DATE DEFAULT CURRENT_DATE
);

-- 9. ADMIN NOTES TABLE (Super Admin internal notes for gyms)
CREATE TABLE public.admin_notes (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    gym_id UUID REFERENCES public.gyms(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    admin TEXT NOT NULL,
    date TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 10. FORM DRAFTS (Saves in-progress forms)
CREATE TABLE public.form_drafts (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    gym_id UUID REFERENCES public.gyms(id) ON DELETE CASCADE,
    page_id TEXT NOT NULL,
    form_data JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(gym_id, page_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_members_gym_fingerprint_unique
ON public.members(gym_id, fingerprint_id)
WHERE fingerprint_id IS NOT NULL;

-- SET ALL RLS POLICIES (Optional but recommended for Supabase security)
ALTER TABLE public.gyms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.form_drafts ENABLE ROW LEVEL SECURITY;
