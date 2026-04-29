const express = require('express');
const { z } = require('zod');
const { supabase } = require('../db/supabase');
const { authenticate, requireGymOwner } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireGymOwner);

const staffSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(100),
  phone: z.string().min(10).max(20),
  role: z.enum(['trainer', 'receptionist', 'cleaner', 'manager', 'security', 'other']),
  custom_role: z.string().optional(),
  join_date: z.string().optional(),
  monthly_salary: z.number().min(0).default(0),
  status: z.enum(['active', 'inactive', 'terminated']).default('active'),
  notes: z.string().optional(),
});

router.get('/', async (req, res) => {
  const { status, month, year } = req.query;
  let query = supabase.from('staff').select('*, staff_payments(*)').eq('gym_id', req.user.gym_id).order('name');
  
  if (status && status !== 'all') query = query.eq('status', status);
  
  const { data, error } = await query;
  if (error) throw error;

  // Filter payments locally if month/year provided
  const processed = data.map(s => {
    const payments = s.staff_payments || [];
    const isPaid = month && year 
      ? payments.some(p => p.month === Number(month) && p.year === Number(year))
      : false;
    return { ...s, isPaid };
  });

  res.json({ success: true, data: processed });
});

router.get('/:id', async (req, res) => {
  const { data, error } = await supabase.from('staff').select('*, staff_payments(*)').eq('id', req.params.id).eq('gym_id', req.user.gym_id).single();
  if (error || !data) return res.status(404).json({ success: false, message: 'Staff not found' });
  res.json({ success: true, data });
});

router.post('/', async (req, res) => {
  const body = staffSchema.parse({ ...req.body, monthly_salary: Number(req.body.monthly_salary) || 0 });
  const { data, error } = await supabase.from('staff').insert({ ...body, gym_id: req.user.gym_id }).select().single();
  if (error) throw error;
  res.status(201).json({ success: true, data });
});

router.put('/:id', async (req, res) => {
  const body = staffSchema.partial().parse(req.body);
  if (body.monthly_salary) body.monthly_salary = Number(body.monthly_salary);
  const { data, error } = await supabase.from('staff').update(body).eq('id', req.params.id).eq('gym_id', req.user.gym_id).select().single();
  if (error || !data) return res.status(404).json({ success: false, message: 'Staff not found' });
  res.json({ success: true, data });
});

router.delete('/:id', async (req, res) => {
  const { permanent } = req.query;
  const staffId = req.params.id;
  const gymId = req.user.gym_id;

  let error;
  if (permanent === 'true') {
    // Hard delete staff and all associated records (via DB cascade)
    const result = await supabase.from('staff').delete().eq('id', staffId).eq('gym_id', gymId);
    error = result.error;
  } else {
    // Soft delete staff instead of unlinking/deleting, to preserve salary history names
    const result = await supabase.from('staff').update({ status: 'deleted' }).eq('id', staffId).eq('gym_id', gymId);
    error = result.error;
  }

  if (error) throw error;
  res.json({ success: true, message: permanent === 'true' ? 'Staff and all associated records permanently deleted' : 'Staff removed (records preserved)' });
});

// ── Staff Salary Payments ─────────────────
router.post('/:id/salary', async (req, res) => {
  const { id, month, year, amount_paid, paid_date, payment_method = 'cash', notes } = req.body;
  const { data: existing } = await supabase.from('staff_payments').select('id').eq('staff_id', req.params.id).eq('month', month).eq('year', year).maybeSingle();
  if (existing) return res.status(409).json({ success: false, message: 'Salary already paid for this month' });
  
  const payload = { 
    staff_id: req.params.id, 
    gym_id: req.user.gym_id, 
    month: Number(month), 
    year: Number(year), 
    amount_paid: Number(amount_paid), 
    payment_method, 
    notes 
  };
  if (id) payload.id = id;

  const { data, error } = await supabase.from('staff_payments').insert(payload).select().single();
  if (error) throw error;

  // Audit Log
  const { data: staffData } = await supabase.from('staff').select('name').eq('id', req.params.id).single();
  await supabase.from('admin_notes').insert({
    gym_id: req.user.gym_id,
    admin: 'AuditLog',
    date: new Date().toISOString(),
    text: JSON.stringify({ action: 'ADDED', type: 'STAFF_SALARY', amount: Number(amount_paid), details: `Paid salary to ${staffData?.name || 'Staff'}` })
  });

  res.status(201).json({ success: true, data });
});

router.get('/:id/salary', async (req, res) => {
  const { data, error } = await supabase.from('staff_payments').select('*').eq('staff_id', req.params.id).eq('gym_id', req.user.gym_id).order('year', { ascending: false }).order('month', { ascending: false });
  if (error) throw error;
  res.json({ success: true, data });
});

router.delete('/:staffId/salary/:salaryId', async (req, res) => {
  const { staffId, salaryId } = req.params;

  const { data: salary } = await supabase.from('staff_payments').select('*, staff(name)').eq('id', salaryId).single();
  if (salary) {
    await supabase.from('admin_notes').insert({
      gym_id: req.user.gym_id,
      admin: 'AuditLog',
      date: new Date().toISOString(),
      text: JSON.stringify({ action: 'DELETED', type: 'STAFF_SALARY', amount: salary.amount_paid, details: `Deleted salary record for ${salary.staff?.name || 'Staff'}` })
    });
  }

  const { error } = await supabase.from('staff_payments').delete().eq('id', salaryId).eq('gym_id', req.user.gym_id);
  if (error) throw error;
  res.json({ success: true, message: 'Salary record deleted' });
});

module.exports = router;
