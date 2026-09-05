const express = require('express');
const { z } = require('zod');
const { supabase } = require('../db/supabase');
const { authenticate } = require('../middleware/auth');
const { sendMessage, sentToday, renderTemplate, PROVIDERS } = require('../services/messaging');

const router = express.Router();
router.use(authenticate);

const WORKER_URL = process.env.WA_WORKER_URL;
const WORKER_TOKEN = process.env.WA_WORKER_TOKEN;

const gymOf = (req) => req.user.gym_id;

async function loadGym(gymId) {
  const { data } = await supabase.from('gyms').select('*').eq('id', gymId).maybeSingle();
  return data;
}

/** Ask the worker to do something for this gym; never let it 500 the API. */
async function callWorker(path, body) {
  if (!WORKER_URL) {
    return { ok: false, status: 503, message: 'The WhatsApp worker is not configured on this deployment.' };
  }
  try {
    const res = await fetch(`${WORKER_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const payload = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, ...payload };
  } catch (err) {
    return { ok: false, status: 503, message: `The WhatsApp worker is unreachable: ${err.message}` };
  }
}

// ── GET /api/messaging/status ─────────────
router.get('/status', async (req, res) => {
  const gymId = gymOf(req);
  const [gym, sessionRes, used] = await Promise.all([
    loadGym(gymId),
    supabase.from('wa_sessions').select('*').eq('gym_id', gymId).maybeSingle(),
    sentToday(gymId),
  ]);

  const session = sessionRes.data;

  res.json({
    success: true,
    data: {
      provider: gym?.messaging_provider || 'walink',
      country_code: gym?.country_code || '92',
      daily_cap: gym?.wa_daily_cap ?? 200,
      sent_today: used,
      automation: gym?.wa_automation || {},
      worker_configured: Boolean(WORKER_URL),
      session: session
        ? {
          status: session.status,
          phone_number: session.phone_number,
          connected_at: session.connected_at,
          last_error: session.last_error,
          // The QR is a pairing credential; only surface it while it is live.
          qr: session.status === 'pairing'
            && session.qr_expires_at
            && new Date(session.qr_expires_at) > new Date()
            ? session.qr
            : null,
        }
        : { status: 'disconnected' },
    },
  });
});

// ── PATCH /api/messaging/settings ─────────
router.patch('/settings', async (req, res) => {
  const schema = z.object({
    messaging_provider: z.enum(PROVIDERS).optional(),
    country_code: z.string().regex(/^\d{1,4}$/).optional(),
    wa_daily_cap: z.coerce.number().int().min(1).max(2000).optional(),
    wa_automation: z.record(z.boolean()).optional(),
  });
  const body = schema.parse(req.body);

  const { data, error } = await supabase
    .from('gyms').update(body).eq('id', gymOf(req))
    .select('messaging_provider, country_code, wa_daily_cap, wa_automation').single();
  if (error) throw error;

  res.json({ success: true, data, message: 'Messaging settings saved.' });
});

// ── POST /api/messaging/connect — start pairing ──
router.post('/connect', async (req, res) => {
  const gymId = gymOf(req);
  const result = await callWorker('/session/connect', { gym_id: gymId });
  if (!result.ok) return res.status(result.status || 503).json({ success: false, message: result.message });
  res.json({ success: true, data: result.data, message: 'Scan the QR code with WhatsApp on your phone.' });
});

// ── POST /api/messaging/disconnect ────────
router.post('/disconnect', async (req, res) => {
  const gymId = gymOf(req);
  await callWorker('/session/disconnect', { gym_id: gymId });

  // Clear local state even if the worker was unreachable, so the UI cannot get
  // stuck showing "connected" for a session that is gone.
  await supabase.from('wa_sessions')
    .update({ status: 'disconnected', qr: null, qr_expires_at: null, updated_at: new Date().toISOString() })
    .eq('gym_id', gymId);

  res.json({ success: true, message: 'WhatsApp disconnected.' });
});

// ── TEMPLATES ─────────────────────────────
const templateSchema = z.object({
  event: z.enum(['expiry_reminder', 'payment_receipt', 'welcome', 'birthday', 'winback']),
  name: z.string().min(2).max(80),
  body: z.string().min(4).max(1000),
  offset_days: z.coerce.number().int().min(-365).max(365).default(0),
  is_active: z.boolean().default(true),
});

router.get('/templates', async (req, res) => {
  const { data, error } = await supabase
    .from('message_templates').select('*').eq('gym_id', gymOf(req))
    .order('event').order('offset_days', { ascending: false });
  if (error) throw error;
  res.json({ success: true, data });
});

router.post('/templates', async (req, res) => {
  const body = templateSchema.parse(req.body);
  const { data, error } = await supabase
    .from('message_templates').insert({ ...body, gym_id: gymOf(req) }).select().single();

  if (error?.code === '23505') {
    return res.status(409).json({
      success: false,
      message: 'A rule for that event and timing already exists — edit it instead of adding a second one.',
    });
  }
  if (error) throw error;
  res.status(201).json({ success: true, data, message: 'Template saved.' });
});

router.patch('/templates/:id', async (req, res) => {
  const body = templateSchema.partial().parse(req.body);
  const { data, error } = await supabase
    .from('message_templates')
    .update({ ...body, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('gym_id', gymOf(req)).select().single();
  if (error) throw error;
  if (!data) return res.status(404).json({ success: false, message: 'Template not found.' });
  res.json({ success: true, data, message: 'Template updated.' });
});

router.delete('/templates/:id', async (req, res) => {
  const { error } = await supabase
    .from('message_templates').delete().eq('id', req.params.id).eq('gym_id', gymOf(req));
  if (error) throw error;
  res.json({ success: true, message: 'Template deleted.' });
});

// ── POST /api/messaging/preview ───────────
// Renders a template against a real member so the owner sees the exact text.
router.post('/preview', async (req, res) => {
  const { body, member_id: memberId } = req.body || {};
  const gym = await loadGym(gymOf(req));

  let member = { name: 'Sample Member' };
  if (memberId) {
    const { data } = await supabase
      .from('members').select('*').eq('id', memberId).eq('gym_id', gym.id).maybeSingle();
    if (data) member = data;
  }

  res.json({
    success: true,
    data: {
      text: renderTemplate(body, {
        member,
        gym,
        days: 7,
        expiryDate: member.expiry_date || new Date(Date.now() + 7 * 86400000),
      }),
    },
  });
});

// ── POST /api/messaging/send ──────────────
router.post('/send', async (req, res) => {
  const schema = z.object({
    member_id: z.string().uuid().optional(),
    phone: z.string().min(6).optional(),
    body: z.string().min(1).max(4000),
    event: z.string().optional(),
  });
  const input = schema.parse(req.body);
  const gym = await loadGym(gymOf(req));

  let member = null;
  let phone = input.phone;

  if (input.member_id) {
    const { data } = await supabase
      .from('members').select('*').eq('id', input.member_id).eq('gym_id', gym.id).maybeSingle();
    if (!data) return res.status(404).json({ success: false, message: 'Member not found.' });
    member = data;
    phone = phone || data.phone;
  }

  if (!phone) return res.status(400).json({ success: false, message: 'A phone number is required.' });

  const result = await sendMessage({
    gym,
    member,
    phone,
    body: renderTemplate(input.body, { member: member || {}, gym }),
    event: input.event || null,
  });

  if (!result.ok) return res.status(400).json({ success: false, message: result.reason });
  res.json({ success: true, data: result, message: result.mode === 'link' ? 'Open the link to send.' : 'Message sent.' });
});

// ── GET /api/messaging/log ────────────────
router.get('/log', async (req, res) => {
  let query = supabase
    .from('message_log')
    .select('*, member:members(id, name)')
    .eq('gym_id', gymOf(req));

  if (req.query.status) query = query.eq('status', req.query.status);
  if (req.query.event) query = query.eq('event', req.query.event);

  const { data, error } = await query.order('queued_at', { ascending: false }).limit(200);
  if (error) throw error;
  res.json({ success: true, data });
});

module.exports = router;
