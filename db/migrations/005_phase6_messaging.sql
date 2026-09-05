-- ============================================================
-- 005 — Phase 6: messaging providers, templates, delivery log
-- ============================================================
-- Idempotent. Safe to re-run. Requires 001–004.
--
-- 1. gyms.*            — provider choice, dial code, automation switches
-- 2. message_templates — per-gym, per-event message bodies
-- 3. message_log       — every send attempt and its delivery state
-- 4. wa_sessions       — connection state for the Baileys worker
-- ============================================================


-- ── 1. gyms: messaging settings ─────────────────────────────
ALTER TABLE gyms
  ADD COLUMN IF NOT EXISTS messaging_provider TEXT NOT NULL DEFAULT 'walink',
  ADD COLUMN IF NOT EXISTS country_code       TEXT NOT NULL DEFAULT '92',
  ADD COLUMN IF NOT EXISTS wa_daily_cap       INTEGER NOT NULL DEFAULT 200,
  ADD COLUMN IF NOT EXISTS wa_automation      JSONB NOT NULL
    DEFAULT '{"expiry_reminder":false,"payment_receipt":false,"welcome":false,"birthday":false,"winback":false}'::jsonb;

COMMENT ON COLUMN gyms.messaging_provider IS
  'walink = click-to-send wa.me links (default, no ban risk) | baileys = automated worker | noop = disabled';
COMMENT ON COLUMN gyms.country_code IS
  'Dial code without +, used to normalise local member numbers to international format. '
  'The old client-side helper hardcoded 92, so non-Pakistani numbers were corrupted.';
COMMENT ON COLUMN gyms.wa_daily_cap IS
  'Maximum automated messages per day. WhatsApp bans numbers that send in bulk; this is the throttle.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gyms_messaging_provider_check') THEN
    ALTER TABLE gyms ADD CONSTRAINT gyms_messaging_provider_check
      CHECK (messaging_provider IN ('walink', 'baileys', 'noop'));
  END IF;
END $$;


-- ── 2. message_templates ────────────────────────────────────
-- The three wa_msg_* columns already on `gyms` cover the manual click-to-send
-- flow. Automation needs more events than three columns can hold, and each
-- needs its own on/off state and timing.

CREATE TABLE IF NOT EXISTS message_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id      UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  event       TEXT NOT NULL,
  name        TEXT NOT NULL,
  body        TEXT NOT NULL,
  -- Days before (positive) or after (negative) the trigger date.
  offset_days INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN message_templates.event IS
  'expiry_reminder | payment_receipt | welcome | birthday | winback';
COMMENT ON COLUMN message_templates.body IS
  'Supports the existing placeholders: [Name] [GymName] [Days] [Amount] [Phone] [ExpiryDate]';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'message_templates_event_check') THEN
    ALTER TABLE message_templates ADD CONSTRAINT message_templates_event_check
      CHECK (event IN ('expiry_reminder', 'payment_receipt', 'welcome', 'birthday', 'winback'));
  END IF;
END $$;

-- One template per event per offset: two "7 days before expiry" rules would
-- send the same member the same message twice.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_template_event_offset
  ON message_templates(gym_id, event, offset_days);

CREATE INDEX IF NOT EXISTS idx_message_templates_gym ON message_templates(gym_id, is_active);


-- ── 3. message_log ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS message_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id       UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  member_id    UUID REFERENCES members(id) ON DELETE SET NULL,
  template_id  UUID REFERENCES message_templates(id) ON DELETE SET NULL,
  event        TEXT,
  provider     TEXT NOT NULL,
  to_phone     TEXT NOT NULL,
  body         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued',
  error        TEXT,
  queued_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN message_log.status IS
  'queued | sent | delivered | failed | skipped_cap | fallback_link';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'message_log_status_check') THEN
    ALTER TABLE message_log ADD CONSTRAINT message_log_status_check
      CHECK (status IN ('queued', 'sent', 'delivered', 'failed', 'skipped_cap', 'fallback_link'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_message_log_gym ON message_log(gym_id, queued_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_log_status ON message_log(gym_id, status);

-- Stops an automation firing twice for the same member, event and day — the
-- scheduler runs hourly, and a crash mid-run must not double-send on retry.
--
-- The date is pinned to UTC deliberately. A bare `queued_at::date` reads the
-- session's TimeZone setting, which makes it STABLE rather than IMMUTABLE and
-- Postgres rejects it in an index expression (42P17). `AT TIME ZONE 'UTC'`
-- fixes the offset, so the expression is immutable and the index is accepted.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_message_per_member_event_day
  ON message_log(gym_id, member_id, event, ((queued_at AT TIME ZONE 'UTC')::date))
  WHERE member_id IS NOT NULL AND event IS NOT NULL;


-- ── 4. wa_sessions ──────────────────────────────────────────
-- Connection state, separate from `whatsapp_auth` (which holds Baileys' own
-- credential blobs). One row per gym.

CREATE TABLE IF NOT EXISTS wa_sessions (
  gym_id        UUID PRIMARY KEY REFERENCES gyms(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'disconnected',
  phone_number  TEXT,
  qr            TEXT,
  qr_expires_at TIMESTAMPTZ,
  last_error    TEXT,
  connected_at  TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN wa_sessions.status IS
  'disconnected | pairing | connected | logged_out | error';
COMMENT ON COLUMN wa_sessions.qr IS
  'Short-lived pairing QR payload. Cleared once connected — it is a credential.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_sessions_status_check') THEN
    ALTER TABLE wa_sessions ADD CONSTRAINT wa_sessions_status_check
      CHECK (status IN ('disconnected', 'pairing', 'connected', 'logged_out', 'error'));
  END IF;
END $$;

-- Backfill the dial code from each gym's timezone so existing non-Pakistani
-- gyms stop having their members' numbers rewritten to +92.
UPDATE gyms SET country_code = CASE
  WHEN timezone LIKE 'Asia/Kolkata%'      THEN '91'
  WHEN timezone LIKE 'Asia/Dhaka%'        THEN '880'
  WHEN timezone LIKE 'Asia/Dubai%'        THEN '971'
  WHEN timezone LIKE 'Asia/Riyadh%'       THEN '966'
  WHEN timezone LIKE 'Asia/Kuala_Lumpur%' THEN '60'
  WHEN timezone LIKE 'Europe/London%'     THEN '44'
  WHEN timezone LIKE 'Europe/Dublin%'     THEN '353'
  WHEN timezone LIKE 'Europe/Berlin%'     THEN '49'
  WHEN timezone LIKE 'Europe/Paris%'      THEN '33'
  WHEN timezone LIKE 'Europe/Istanbul%'   THEN '90'
  WHEN timezone LIKE 'America/%'          THEN '1'
  WHEN timezone LIKE 'Africa/Lagos%'      THEN '234'
  WHEN timezone LIKE 'Africa/Cairo%'      THEN '20'
  WHEN timezone LIKE 'Africa/Johannesburg%' THEN '27'
  WHEN timezone LIKE 'Australia/%'        THEN '61'
  ELSE country_code
END
WHERE country_code = '92' AND timezone NOT LIKE 'Asia/Karachi%';
