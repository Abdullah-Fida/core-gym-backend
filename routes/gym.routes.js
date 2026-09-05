const express = require('express');
const { z } = require('zod');
const { dialCodeForTimezone } = require('../lib/dialCodes');
const { supabase } = require('../db/supabase');
const { authenticate, requireGymOwner, ownGymOnly } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireGymOwner, ownGymOnly);

const isAttendanceColumnMissing = (error) => {
  const msg = String(error?.message || '').toLowerCase();
  return error?.code === '42703' || (msg.includes('attendance_active') && msg.includes('column'));
};

router.get('/', async (req, res) => {
  // Explicit list rather than `*` so the password hash can never leak. The
  // locale columns were added in Phase 3 but never added here, so the Settings
  // page always re-rendered the defaults no matter what had been saved.
  const baseSelect = [
    'id', 'gym_name', 'owner_name', 'phone', 'city', 'address',
    'default_monthly_fee', 'email', 'plan_type',
    'subscription_ends_at', 'trial_ends_at', 'billing_status',
    'currency', 'timezone', 'locale', 'country_code', 'payment_methods',
    'wa_msg_active', 'wa_msg_due_soon', 'wa_msg_expired',
  ].join(', ');

  const primary = await supabase
    .from('gyms')
    .select(`${baseSelect}, attendance_active`)
    .eq('id', req.user.gym_id)
    .single();

  if (!primary.error) {
    return res.json({ success: true, data: primary.data });
  }

  if (!isAttendanceColumnMissing(primary.error)) throw primary.error;

  const fallback = await supabase
    .from('gyms')
    .select(baseSelect)
    .eq('id', req.user.gym_id)
    .single();

  if (fallback.error) throw fallback.error;

  res.json({
    success: true,
    data: {
      ...fallback.data,
      attendance_active: false,
    },
  });
});

router.put('/', async (req, res) => {
  const schema = z.object({
    gym_name: z.string().min(2).optional(),
    owner_name: z.string().min(2).optional(),
    phone: z.string().min(10).optional(),
    city: z.string().optional(),
    address: z.string().optional(),
    default_monthly_fee: z.number().min(0).optional(),
    wa_msg_active: z.string().optional(),
    wa_msg_due_soon: z.string().optional(),
    wa_msg_expired: z.string().optional(),
    attendance_active: z.boolean().optional(),
    // Locale settings, added in Phase 3. The Settings page has been sending
    // these since then, but they were not in this schema — zod strips unknown
    // keys, so the "Region and currency" card appeared to save and silently
    // discarded every change.
    currency: z.string().length(3).optional(),
    timezone: z.string().min(3).max(64).optional(),
    locale: z.string().min(2).max(10).optional(),
    country_code: z.string().regex(/^\d{1,4}$/).optional(),
  });

  const body = schema.parse({
    ...req.body,
    default_monthly_fee: req.body.default_monthly_fee ? Number(req.body.default_monthly_fee) : undefined,
  });

  if (body.currency) body.currency = body.currency.toUpperCase();

  // Moving the gym to another country should move its dial code too, unless the
  // caller set one explicitly in the same request.
  if (body.timezone && !body.country_code) {
    const derived = dialCodeForTimezone(body.timezone);
    if (derived) body.country_code = derived;
  }

  const primary = await supabase
    .from('gyms')
    .update(body)
    .eq('id', req.user.gym_id)
    .select()
    .single();

  if (!primary.error) {
    return res.json({ success: true, data: primary.data, message: 'Settings saved' });
  }

  if (!isAttendanceColumnMissing(primary.error)) throw primary.error;

  const { attendance_active, ...fallbackBody } = body;
  const fallback = await supabase
    .from('gyms')
    .update(fallbackBody)
    .eq('id', req.user.gym_id)
    .select()
    .single();

  if (fallback.error) throw fallback.error;

  res.json({
    success: true,
    data: {
      ...fallback.data,
      attendance_active: Boolean(attendance_active),
    },
    message: 'Settings saved',
  });
});

module.exports = router;
