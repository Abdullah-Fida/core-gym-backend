const express = require('express');
const { z } = require('zod');
const { supabase } = require('../db/supabase');
const { authenticate, requireGymOwner } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireGymOwner);

const expenseSchema = z.object({
  id: z.string().optional(),
  category: z.enum(['rent', 'electricity', 'equipment_repair', 'staff_bonus', 'marketing', 'cleaning', 'internet', 'water', 'fuel', 'supplements', 'custom']),
  custom_category: z.string().optional(),
  amount: z.number().positive(),
  expense_date: z.string(),
  description: z.string().optional(),
  is_recurring: z.boolean().default(false),
  recurrence_day: z.number().int().min(1).max(31).optional().nullable(),
  logged_by: z.string().optional(),
});

// ── GET /api/expenses ─────────────────────
router.get('/', async (req, res) => {
  const { month, year, category } = req.query;
  const gymId = req.user.gym_id;

  try {
    // 1. Fetch regular expenses
    let expQuery = supabase.from('expenses').select('*').eq('gym_id', gymId);
    if (month && year) {
      const start = `${year}-${String(month).padStart(2, '0')}-01`;
      const end = new Date(Date.UTC(year, month, 0)).toISOString().split('T')[0];
      expQuery = expQuery.gte('expense_date', start).lte('expense_date', end);
    }
    if (category && category !== 'staff_salary') {
      expQuery = expQuery.eq('category', category);
    }
    const { data: expData, error: expError } = await expQuery.order('expense_date', { ascending: false });
    if (expError) throw expError;

    // 2. Fetch staff salaries (staff_payments) if not filtering by a specific regular category
    let salaryData = [];
    if (!category || category === 'staff_salary') {
      let salQuery = supabase.from('staff_payments').select('*, staff:staff_id(name)').eq('gym_id', gymId);
      if (month && year) {
        salQuery = salQuery.eq('month', Number(month)).eq('year', Number(year));
      }
      const { data: sData, error: sError } = await salQuery.order('paid_date', { ascending: false });
      if (sError) throw sError;
      
      // Map staff payments to match expense object structure expected by frontend
      salaryData = (sData || []).map(sp => ({
        id: sp.id,
        gym_id: sp.gym_id,
        category: 'staff_salary',
        amount: sp.amount_paid,
        expense_date: sp.paid_date,
        description: `Salary: ${sp.staff?.name || 'Staff'}`,
        is_staff_salary: true,
        created_at: sp.created_at
      }));
    }

    // 3. Combine and sort
    const combined = [...(expData || []), ...salaryData].sort((a, b) => new Date(b.expense_date) - new Date(a.expense_date));

    // If category is staff_salary, only return salaries
    if (category === 'staff_salary') {
      return res.json({ success: true, data: salaryData });
    }

    res.json({ success: true, data: combined });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/expenses/summary/:year ──────
// IMPORTANT: This route MUST be defined BEFORE /:id so 'summary' isn't caught as an id param
router.get('/summary/:year', async (req, res) => {
  const { year } = req.params;
  const gymId = req.user.gym_id;

  const [expenses, payments, salaries] = await Promise.all([
    supabase.from('expenses').select('amount, expense_date, category').eq('gym_id', gymId).gte('expense_date', `${year}-01-01`).lte('expense_date', `${year}-12-31`),
    supabase.from('payments').select('amount, payment_date').eq('gym_id', gymId).gte('payment_date', `${year}-01-01`).lte('payment_date', `${year}-12-31`),
    supabase.from('staff_payments').select('amount_paid, paid_date').eq('gym_id', gymId).gte('paid_date', `${year}-01-01`).lte('paid_date', `${year}-12-31`),
  ]);

  const allExpenses = expenses.data || [];
  const allPayments = payments.data || [];
  const allSalaries = salaries.data || [];

  const monthly = Array.from({ length: 12 }, (_, i) => {
    const m = i + 1;
    const rev = allPayments.filter(p => new Date(p.payment_date).getMonth() === i).reduce((s, p) => s + p.amount, 0);
    const exp = allExpenses.filter(e => new Date(e.expense_date).getMonth() === i).reduce((s, e) => s + e.amount, 0);
    const sal = allSalaries.filter(sl => new Date(sl.paid_date).getMonth() === i).reduce((sum, sl) => sum + sl.amount_paid, 0);
    const totalExp = exp + sal;
    return { month: m, revenue: rev, expenses: totalExp, profit: rev - totalExp, salaryOnly: sal, generalExpenseOnly: exp };
  });

  // By category
  const byCategory = {};
  allExpenses.forEach(e => { byCategory[e.category] = (byCategory[e.category] || 0) + e.amount; });
  
  // Add salaries as a category
  const totalSalaries = allSalaries.reduce((s, sl) => s + sl.amount_paid, 0);
  if (totalSalaries > 0) {
    byCategory['staff_salary'] = totalSalaries;
  }

  const totalRevenue = allPayments.reduce((s, p) => s + p.amount, 0);
  const totalGeneralExpenses = allExpenses.reduce((s, e) => s + e.amount, 0);
  const totalAllExpenses = totalGeneralExpenses + totalSalaries;

  res.json({ 
    success: true, 
    data: { 
      monthly, 
      byCategory, 
      totals: { 
        revenue: totalRevenue, 
        expenses: totalAllExpenses,
        salaries: totalSalaries,
        generalExpenses: totalGeneralExpenses,
        profit: totalRevenue - totalAllExpenses
      } 
    } 
  });
});

// ── GET /api/expenses/:id ─────────────────
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase.from('expenses').select('*').eq('id', req.params.id).eq('gym_id', req.user.gym_id).single();
  if (error || !data) return res.status(404).json({ success: false, message: 'Expense not found' });
  res.json({ success: true, data });
});

// ── POST /api/expenses ───────────────────
router.post('/', async (req, res) => {
  const body = expenseSchema.parse({ ...req.body, amount: Number(req.body.amount), is_recurring: Boolean(req.body.is_recurring) });
  
  const insertData = { ...body, gym_id: req.user.gym_id };
  if (body.id) insertData.id = body.id;

  // Use upsert to safely handle re-sync of offline expenses (duplicate IDs)
  const { data, error } = await supabase.from('expenses').upsert(insertData, { onConflict: 'id' }).select().single();
  if (error) throw error;
  res.status(201).json({ success: true, data });
});

// ── PUT /api/expenses/:id ─────────────────
router.put('/:id', async (req, res) => {
  const body = expenseSchema.partial().parse(req.body);
  if (body.amount) body.amount = Number(body.amount);
  const { data, error } = await supabase.from('expenses').update(body).eq('id', req.params.id).eq('gym_id', req.user.gym_id).select().single();
  if (error || !data) return res.status(404).json({ success: false, message: 'Expense not found' });
  res.json({ success: true, data });
});

// ── DELETE /api/expenses/:id ──────────────
router.delete('/:id', async (req, res) => {
  const { error } = await supabase.from('expenses').delete().eq('id', req.params.id).eq('gym_id', req.user.gym_id);
  if (error) throw error;
  res.json({ success: true, message: 'Expense deleted' });
});

module.exports = router;
