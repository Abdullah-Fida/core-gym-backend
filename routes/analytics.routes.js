const express = require('express');
const { supabase } = require('../db/supabase');
const { authenticate, requireGymOwner } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireGymOwner);

// ── GET /api/analytics/dashboard ──────────
// Returns all dashboard stats in one request
router.get('/dashboard', async (req, res) => {
  const gym_id = req.user.gym_id;
  if (!gym_id) return res.status(400).json({ success: false, message: 'Gym ID missing from session' });

  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  const today = now.toISOString().split('T')[0];
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const monthEnd = new Date(year, month, 0).toISOString().split('T')[0];

  const [members, payments, expenses, salaries, todayAtt] = await Promise.all([
    supabase.from('members').select('id, name, status, latest_expiry, join_date, phone').eq('gym_id', gym_id),
    supabase.from('payments').select('amount, payment_date').eq('gym_id', gym_id).gte('payment_date', monthStart).lte('payment_date', monthEnd),
    supabase.from('expenses').select('amount, expense_date').eq('gym_id', gym_id).gte('expense_date', monthStart).lte('expense_date', monthEnd),
    supabase.from('staff_payments').select('amount_paid, paid_date').eq('gym_id', gym_id).gte('paid_date', monthStart).lte('paid_date', monthEnd),
    supabase.from('attendance').select('id').eq('gym_id', gym_id).eq('date', today),
  ]);

  const allMembers = members.data || [];
  const revenue = (payments.data || []).reduce((s, p) => s + p.amount, 0);
  const expenseTotal = (expenses.data || []).reduce((s, e) => s + e.amount, 0);
  const salaryTotal = (salaries.data || []).reduce((s, sl) => s + sl.amount_paid, 0);
  const combinedExpenses = expenseTotal + salaryTotal;

  // Proactive Status Sync for Urgent Expiries
  const updatedMembers = allMembers.map(m => {
    if (!m.latest_expiry) return m;
    const target = new Date(m.latest_expiry);
    target.setHours(0,0,0,0);
    const nowLocal = new Date();
    nowLocal.setHours(0,0,0,0);
    const diff = Math.ceil((target - nowLocal) / (1000 * 60 * 60 * 24));
    
    let status = 'active';
    if (diff < 0) status = 'expired';
    else if (diff <= 3) status = 'due_soon';
    
    return { ...m, status };
  });

  const activeMembers = updatedMembers.filter(m => m.status === 'active').length;
  const expiredCount = updatedMembers.filter(m => m.status === 'expired').length;
  const dueSoonCount = updatedMembers.filter(m => m.status === 'due_soon').length;
  const newMembersThisMonth = allMembers.filter(m => m.join_date >= monthStart).length;

  // Sync member statuses in DB (fire and forget)
  for (const m of updatedMembers) {
    const original = allMembers.find(o => o.id === m.id);
    if (original && original.status !== m.status) {
      supabase.from('members').update({ status: m.status }).eq('id', m.id).then(() => {});
    }
  }

  // Get urgent expiries (expired or due_soon)
  const urgentExpiries = updatedMembers
    .filter(m => m.status !== 'active')
    .sort((a, b) => new Date(a.latest_expiry) - new Date(b.latest_expiry))
    .slice(0, 5);

  res.json({
    success: true,
    data: {
      activeMembers,
      expiredCount,
      dueSoonCount,
      newMembersThisMonth,
      totalMembers: allMembers.length,
      todayAttendance: (todayAtt.data || []).length,
      revenue,
      expenses: combinedExpenses,
      salaryTotal,
      generalExpenses: expenseTotal,
      profit: revenue - combinedExpenses,
      urgentExpiries,
      month, year,
    }
  });
});

// ── GET /api/analytics/revenue-trend ──────
// Last N months revenue vs expenses
router.get('/revenue-trend', async (req, res) => {
  const gym_id = req.user.gym_id;
  const months = Number(req.query.months) || 6;
  const now = new Date();
  const result = [];

  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const m = d.getMonth() + 1;
    const y = d.getFullYear();
    const start = `${y}-${String(m).padStart(2, '0')}-01`;
    const end = new Date(y, m, 0).toISOString().split('T')[0];

    const [pay, exp, sal] = await Promise.all([
      supabase.from('payments').select('amount').eq('gym_id', gym_id).gte('payment_date', start).lte('payment_date', end),
      supabase.from('expenses').select('amount').eq('gym_id', gym_id).gte('expense_date', start).lte('expense_date', end),
      supabase.from('staff_payments').select('amount_paid').eq('gym_id', gym_id).gte('paid_date', start).lte('paid_date', end),
    ]);

    const revenue = (pay.data || []).reduce((s, p) => s + p.amount, 0);
    const expenses = (exp.data || []).reduce((s, e) => s + e.amount, 0);
    const salaries = (sal.data || []).reduce((s, sl) => s + sl.amount_paid, 0);
    const totalExpenses = expenses + salaries;
    result.push({ month: m, year: y, revenue, expenses: totalExpenses, profit: revenue - totalExpenses });
  }

  res.json({ success: true, data: result });
});

// ── GET /api/analytics/member-growth ──────
router.get('/member-growth', async (req, res) => {
  const gym_id = req.user.gym_id;
  const { data, error } = await supabase.from('members').select('id, join_date, status').eq('gym_id', gym_id);
  if (error) throw error;

  const now = new Date();
  const growth = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - 5 + i, 1);
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const count = data.filter(m => new Date(m.join_date) <= end).length;
    return { month: d.getMonth() + 1, year: d.getFullYear(), totalMembers: count };
  });

  res.json({ success: true, data: growth });
});

// ── GET /api/analytics/attendance-heatmap ─
router.get('/attendance-heatmap', async (req, res) => {
  const { days = 30 } = req.query;
  const gym_id = req.user.gym_id;
  const since = new Date();
  since.setDate(since.getDate() - Number(days));

  const { data, error } = await supabase
    .from('attendance')
    .select('date')
    .eq('gym_id', gym_id)
    .gte('date', since.toISOString().split('T')[0]);

  if (error) throw error;

  const byDate = {};
  (data || []).forEach(a => { byDate[a.date] = (byDate[a.date] || 0) + 1; });
  res.json({ success: true, data: byDate });
});

module.exports = router;
