const express = require('express');
const { z } = require('zod');
const { supabase } = require('../db/supabase');
const { authenticate, requireGymOwner, ownGymOnly } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireGymOwner);

const memberSchema = z.object({
  id: z.string().optional(), // allow client-generated offline id
  name: z.string().min(1).max(100),
  phone: z.string().min(10).max(20),
  join_date: z.string().optional(),
  emergency_contact: z.string().optional(),
  notes: z.string().optional(),
});

// ── GET /api/members ─── List all members for a gym
router.get('/', async (req, res) => {
  const { gym_id, status, search, sort = 'name', limit = 100, offset = 0 } = req.query;
  const gid = gym_id || req.user.gym_id;

  let query = supabase.from('members').select('*, payments(id, amount, payment_date, expiry_date, plan_duration_months)').eq('gym_id', gid).order('payment_date', { foreignTable: 'payments', ascending: false });

  if (status === 'inactive') {
    // Show members explicitly inactive OR those who never paid
    query = query.or('status.eq.inactive,latest_expiry.is.null');
  } else if (status === 'active') {
    // Show only active members who have actually paid
    query = query.eq('status', 'active').not('latest_expiry', 'is', null);
  } else if (status) {
    query = query.eq('status', status);
  }
  if (search) query = query.or(`name.ilike.%${search}%,phone.ilike.%${search}%`);
  if (sort === 'join_date') query = query.order('join_date', { ascending: false });
  else query = query.order('name');
  query = query.range(Number(offset), Number(offset) + Number(limit) - 1);

  const { data, error, count } = await query;
  if (error) throw error;
  res.json({ success: true, data, count });
});

// ── GET /api/members/:id ─── Single member
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase.from('members').select('*, payments(*)').eq('id', req.params.id).eq('gym_id', req.user.gym_id).single();
  if (error || !data) return res.status(404).json({ success: false, message: 'Member not found' });
  res.json({ success: true, data });
});

// ── POST /api/members ─── Add member
router.post('/', async (req, res) => {
  const body = memberSchema.parse(req.body);

  // Check for duplicate member (same name and phone in this gym)
  const { data: existing } = await supabase
    .from('members')
    .select('id')
    .eq('gym_id', req.user.gym_id)
    .eq('phone', body.phone.trim())
    .ilike('name', body.name.trim())
    .maybeSingle();

  if (existing) {
    return res.status(409).json({ success: false, message: 'Member with this name and phone already exists' });
  }

  const { data, error } = await supabase.from('members').insert({ ...body, gym_id: req.user.gym_id, status: 'inactive' }).select().single();
  if (error) throw error;
  res.status(201).json({ success: true, data, message: 'Member added successfully' });
});

// ── PUT /api/members/:id ─── Update member
router.put('/:id', async (req, res) => {
  const body = memberSchema.partial().parse(req.body);
  const { data, error } = await supabase.from('members').update(body).eq('id', req.params.id).eq('gym_id', req.user.gym_id).select().single();
  if (error || !data) return res.status(404).json({ success: false, message: 'Member not found' });
  res.json({ success: true, data, message: 'Member updated' });
});

// ── DELETE /api/members/:id ─── Delete member
router.delete('/:id', async (req, res) => {
  const memberId = req.params.id;
  const gymId = req.user.gym_id;
  // Soft delete member instead of unlinking/deleting, to preserve payment history names
  const { error } = await supabase.from('members').update({ status: 'deleted' }).eq('id', memberId).eq('gym_id', gymId);
  
  if (error) {
    console.error('CRITICAL Delete error for Member:', memberId, error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete member due to database error'
    });
  }

  res.json({ success: true, message: 'Member and all associated records deleted' });
});

// ── GET /api/members/:id/attendance ─── Member attendance
router.get('/:id/attendance', async (req, res) => {
  const { month, year } = req.query;
  let query = supabase.from('attendance').select('*').eq('member_id', req.params.id).eq('gym_id', req.user.gym_id);
  if (month && year) {
    const start = `${year}-${String(month).padStart(2, '0')}-01`;
    const end = `${year}-${String(month).padStart(2, '0')}-31`;
    query = query.gte('date', start).lte('date', end);
  }
  const { data, error } = await query.order('date', { ascending: false });
  if (error) throw error;
  res.json({ success: true, data });
});

module.exports = router;
