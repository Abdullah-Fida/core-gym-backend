const express = require('express');
const { z } = require('zod');
const { supabase } = require('../db/supabase');
const { authenticate, requireGymOwner } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireGymOwner);

const isAttendanceColumnMissing = (error) => {
  const msg = String(error?.message || '').toLowerCase();
  return error?.code === '42703' || (msg.includes('attendance_active') && msg.includes('column'));
};

router.get('/', async (req, res) => {
  const baseSelect = 'id, gym_name, owner_name, phone, city, address, default_monthly_fee, email, plan_type, subscription_ends_at, trial_ends_at, wa_msg_active, wa_msg_due_soon, wa_msg_expired';

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
  });

  const body = schema.parse({
    ...req.body,
    default_monthly_fee: req.body.default_monthly_fee ? Number(req.body.default_monthly_fee) : undefined,
  });

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
