const express = require('express');
const { z } = require('zod');
const { supabase } = require('../db/supabase');
const { authenticate, requireGymOwner } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireGymOwner);

const paymentSchema = z.object({
  id: z.string().optional(), // allow client-generated offline id
  member_id: z.string().uuid(),
  // Allow zero for trials or promotional entries
  amount: z.number().nonnegative(),
  payment_date: z.string(),
  plan_duration_months: z.union([z.number(), z.string()]), // Can be number or "custom"
  custom_days: z.number().int().optional().default(0),
  payment_method: z.enum(['cash', 'bank_transfer', 'easypaisa', 'jazzcash', 'card']).default('cash'),
  received_by: z.string().optional(),
  notes: z.string().optional(),
  // logical type for clients to mark registration/trial payments — stored in notes for compatibility
  payment_type: z.enum(['membership', 'registration', 'trial']).optional(),
});

// ── GET /api/payments ─── List payments with filter
router.get('/', async (req, res) => {
  const { month, year, member_id } = req.query;
  let query = supabase.from('payments').select('*, members(name, phone)').eq('gym_id', req.user.gym_id);

  if (member_id) query = query.eq('member_id', member_id);
  if (month && year) {
    const start = `${year}-${String(month).padStart(2, '0')}-01`;
    const end = new Date(year, month, 0).toISOString().split('T')[0];
    query = query.gte('payment_date', start).lte('payment_date', end);
  }
  const { data, error } = await query.order('payment_date', { ascending: false });
  if (error) throw error;
  res.json({ success: true, data });
});

// ── GET /api/payments/pending ─── Expired / due members
router.get('/pending', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const { data, error } = await supabase.from('members').select('*, payments(id, amount, payment_date, expiry_date)').eq('gym_id', req.user.gym_id).in('status', ['expired', 'due_soon']).order('name');
  if (error) throw error;
  res.json({ success: true, data });
});

// ── GET /api/payments/all-transactions ─── 
router.get('/all-transactions', async (req, res) => {
  const { month, year } = req.query;
  const gymId = req.user.gym_id;

  let start, end;
  if (month && year) {
    start = `${year}-${String(month).padStart(2, '0')}-01`;
    end = new Date(year, month, 0).toISOString().split('T')[0];
  }

  let payQuery = supabase.from('payments').select('id, amount, payment_date, payment_method, plan_duration_months, created_at, members(name)').eq('gym_id', gymId);
  let expQuery = supabase.from('expenses').select('id, amount, expense_date, category, description, created_at').eq('gym_id', gymId);
  let staffQuery = supabase.from('staff_payments').select('id, staff_id, amount_paid, paid_date, payment_method, notes, created_at, staff(name, role)').eq('gym_id', gymId);
  let auditQuery = supabase.from('admin_notes').select('id, text, date, created_at').eq('gym_id', gymId).eq('admin', 'AuditLog');

  if (start && end) {
    payQuery = payQuery.gte('payment_date', start).lte('payment_date', end);
    expQuery = expQuery.gte('expense_date', start).lte('expense_date', end);
    staffQuery = staffQuery.gte('paid_date', start).lte('paid_date', end);
    auditQuery = auditQuery.gte('date', start).lte('date', `${end}T23:59:59Z`); // Adjust for ISO string matching
  }

  const [payRes, expRes, staffRes, auditRes] = await Promise.all([payQuery, expQuery, staffQuery, auditQuery]);

  const transactions = [];

  (payRes.data || []).forEach(p => {
    let reason = 'Membership Fee';
    let subtitle = p.plan_duration_months === 'custom' ? 'Custom Plan' : `${p.plan_duration_months} Month Plan`;
    if (p.notes && p.notes.includes('payment_type:registration')) {
      reason = 'Registration Fee';
      subtitle = 'Registration';
    } else if (p.notes && p.notes.includes('payment_type:trial')) {
      reason = 'Free Trial';
      subtitle = 'Trial';
    }
    transactions.push({
      id: `pay_${p.id}`,
      type: 'member_payment',
      amount: p.amount,
      date: p.payment_date,
      created_at: p.created_at,
      title: p.members?.name || 'Unknown Member',
      subtitle,
      method: p.payment_method,
      reason
    });
  });

  (staffRes.data || []).forEach(p => {
    transactions.push({
      id: `staff_${p.id}`,
      staff_id: p.staff_id,
      type: 'staff_payment',
      amount: p.amount_paid,
      date: p.paid_date,
      created_at: p.created_at,
      title: p.staff?.name || 'Unknown Staff',
      subtitle: `Salary (${p.staff?.role || 'Staff'})`,
      method: p.payment_method,
      reason: p.notes || 'Monthly Salary'
    });
  });

  (expRes.data || []).forEach(p => {
    transactions.push({
      id: `exp_${p.id}`,
      type: 'expense',
      amount: p.amount,
      date: p.expense_date,
      created_at: p.created_at,
      title: p.category ? p.category.replace(/_/g, ' ').toUpperCase() : 'EXPENSE',
      subtitle: 'General Expense',
      method: 'cash', // Expenses don't track method currently
      reason: p.description || 'N/A'
    });
  });

  (auditRes.data || []).forEach(a => {
    try {
      const payload = JSON.parse(a.text);
      transactions.push({
        id: `audit_${a.id}`,
        type: 'history',
        amount: payload.amount || 0,
        date: a.date.split('T')[0],
        created_at: a.created_at,
        title: `${payload.action} - ${payload.type.replace('_', ' ')}`,
        subtitle: 'System Trace',
        method: 'LOG',
        reason: payload.details || 'N/A'
      });
    } catch(e) {}
  });

  transactions.sort((a, b) => new Date(b.date) - new Date(a.date));

  res.json({ success: true, data: transactions });
});


// ── POST /api/payments ─── Log payment & update member expiry
router.post('/', async (req, res) => {
  // Safe parsing based on incoming types
  const incoming = { 
    ...req.body, 
    amount: Number(req.body.amount), 
    plan_duration_months: req.body.plan_duration_months === 'custom' ? 'custom' : Number(req.body.plan_duration_months),
    custom_days: Number(req.body.custom_days || 0),
    payment_type: req.body.payment_type || req.body.payment_type === '' ? req.body.payment_type : undefined
  };

  const body = paymentSchema.parse(incoming);

  // Default expiry_date to payment date. Some payment types (membership/trial) update it below.
  let expiry_date = body.payment_date;

  if (body.payment_type === 'membership' || body.payment_type === 'trial' || (!body.payment_type && Number(body.plan_duration_months) > 0)) {
    const payDate = new Date(body.payment_date);
    const expiry = new Date(payDate);
    if (body.plan_duration_months === 'custom') {
      expiry.setDate(expiry.getDate() + (body.custom_days || 0));
    } else {
      expiry.setMonth(expiry.getMonth() + Number(body.plan_duration_months));
    }
    expiry_date = expiry.toISOString().split('T')[0];
  }

  // Save a hint in notes to mark registration/trial without changing the DB schema
  const notesToInsert = `${body.payment_type ? `payment_type:${body.payment_type};` : ''}${body.notes || ''}`;

  const insertData = {
    member_id: body.member_id,
    amount: body.amount,
    payment_date: body.payment_date,
    plan_duration_months: body.plan_duration_months === 'custom' ? 'custom' : String(body.plan_duration_months),
    custom_days: body.plan_duration_months === 'custom' ? body.custom_days : 0,
    payment_method: body.payment_method,
    received_by: body.received_by,
    notes: notesToInsert,
    gym_id: req.user.gym_id,
    expiry_date,
  };
  if (body.id) insertData.id = body.id;

  const { data, error } = await supabase.from('payments').insert(insertData).select().single();
  if (error) throw error;

  // Update member status only for membership/trial payments
  if (body.payment_type === 'membership' || (!body.payment_type && Number(body.plan_duration_months) > 0)) {
    await supabase.from('members').update({ status: 'active', latest_expiry: expiry_date }).eq('id', body.member_id);

    // Auto-create notification for expiry warning (3 days before)
    const warnDate = new Date(expiry_date);
    warnDate.setDate(warnDate.getDate() - 3);
    await supabase.from('notifications').insert({
      gym_id: req.user.gym_id,
      member_id: body.member_id,
      notification_type: 'member_fee_expiry_warning',
      scheduled_for: warnDate.toISOString().split('T')[0],
      status: 'pending',
    });
  } else if (body.payment_type === 'trial') {
    // Mark member as trial and set expiry
    await supabase.from('members').update({ status: 'trial', latest_expiry: expiry_date }).eq('id', body.member_id);

    // Create a notification for trial expiry as well (3 days before)
    const warnDate = new Date(expiry_date);
    warnDate.setDate(warnDate.getDate() - 3);
    await supabase.from('notifications').insert({
      gym_id: req.user.gym_id,
      member_id: body.member_id,
      notification_type: 'member_fee_expiry_warning',
      scheduled_for: warnDate.toISOString().split('T')[0],
      status: 'pending',
    });
  }

  // Audit Log (include payment type in audit)
  const { data: memberData } = await supabase.from('members').select('name').eq('id', body.member_id).single();
  await supabase.from('admin_notes').insert({
    gym_id: req.user.gym_id,
    admin: 'AuditLog',
    date: new Date().toISOString(),
    text: JSON.stringify({ action: 'ADDED', type: 'MEMBER_PAYMENT', amount: body.amount, payment_type: body.payment_type || 'membership', details: `Received payment from ${memberData?.name || 'Member'}` })
  });

  res.status(201).json({ success: true, data, expiry_date, message: 'Payment logged successfully' });
});

// ── DELETE /api/payments/:id ─── Delete payment
router.delete('/:id', async (req, res) => {
  const { data: payment } = await supabase.from('payments').select('*, members(name)').eq('id', req.params.id).single();
  if (payment) {
    await supabase.from('admin_notes').insert({
      gym_id: req.user.gym_id,
      admin: 'AuditLog',
      date: new Date().toISOString(),
      text: JSON.stringify({ action: 'DELETED', type: 'MEMBER_PAYMENT', amount: payment.amount, details: `Deleted payment invoice for ${payment.members?.name || 'Member'}` })
    });
  }

  const { error } = await supabase.from('payments').delete().eq('id', req.params.id).eq('gym_id', req.user.gym_id);
  if (error) throw error;
  res.json({ success: true, message: 'Payment deleted' });
});

// ── GET /api/payments/revenue/:year ─── Monthly revenue summary
router.get('/revenue/:year', async (req, res) => {
  const { year } = req.params;
  const { data, error } = await supabase.from('payments').select('amount, payment_date').eq('gym_id', req.user.gym_id).gte('payment_date', `${year}-01-01`).lte('payment_date', `${year}-12-31`);
  if (error) throw error;

  const monthly = Array.from({ length: 12 }, (_, i) => {
    const monthPayments = data.filter(p => new Date(p.payment_date).getMonth() === i);
    return { month: i + 1, total: monthPayments.reduce((s, p) => s + p.amount, 0), count: monthPayments.length };
  });

  res.json({ success: true, data: monthly, year: Number(year) });
});

module.exports = router;
