const express = require('express');
const { supabase } = require('../db/supabase');
const { authenticate, requireAdmin } = require('../middleware/auth');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const router = express.Router();
router.use(authenticate, requireAdmin);

// ── GET /api/admin/gyms ───────────────────
router.get('/gyms', async (req, res) => {
  const { search, plan_type, is_active, limit = 50, offset = 0 } = req.query;
  let query = supabase.from('gyms').select(`
    id, gym_name, owner_name, phone, city, email, plan_type, is_active,
    created_at, last_login_at, subscription_ends_at, trial_ends_at,
    default_monthly_fee,
    members(count), staff(count)
  `);
  if (search) query = query.or(`gym_name.ilike.%${search}%,owner_name.ilike.%${search}%,city.ilike.%${search}%`);
  if (plan_type) query = query.eq('plan_type', plan_type);
  if (is_active !== undefined) query = query.eq('is_active', is_active === 'true');
  const { data, error, count } = await query.range(Number(offset), Number(offset) + Number(limit) - 1);
  if (error) throw error;

  // Proactive Suspension check for the returned list
  const now = new Date();
  for (const g of data || []) {
    const isExpired = g.subscription_ends_at && new Date(g.subscription_ends_at) < now;
    if (isExpired && g.is_active) {
      await supabase.from('gyms').update({ is_active: false }).eq('id', g.id);
      g.is_active = false;
    }
  }

  res.json({ success: true, data, count });
});

// ── POST /api/admin/gyms ──────────────────
router.post('/gyms', async (req, res) => {
  const schema = z.object({
    gym_name: z.string().min(2).max(100),
    owner_name: z.string().min(2).max(100),
    phone: z.string().optional().or(z.literal('')),
    email: z.string().email(),
    password: z.string().min(4).max(100),
    city: z.string().optional().or(z.literal('')),
    address: z.string().optional().or(z.literal('')),
    default_monthly_fee: z.union([z.string(), z.number()]).optional().default(3000),
    subscription_duration: z.string().optional(),
    custom_days: z.union([z.string(), z.number()]).optional(),
  });

  try {
    const body = schema.parse({ ...req.body, default_monthly_fee: Number(req.body.default_monthly_fee) || 3000 });
    
    // Check duplicate
    const { data: existing } = await supabase.from('gyms').select('id').eq('email', body.email.toLowerCase()).maybeSingle();
    if (existing) return res.status(409).json({ success: false, message: 'Email already registered' });

    let subscription_ends_at = new Date();
    if (body.subscription_duration === 'custom') {
      subscription_ends_at.setDate(subscription_ends_at.getDate() + (Number(body.custom_days) || 14));
    } else {
      const months = Number(body.subscription_duration) || 1;
      subscription_ends_at.setMonth(subscription_ends_at.getMonth() + months);
    }

    const hash = await bcrypt.hash(body.password, 12);
    // Store only the bcrypt hash; never persist plaintext password
    const storedHash = hash;
    
    const { data: gym, error } = await supabase.from('gyms').insert({
      gym_name: body.gym_name,
      owner_name: body.owner_name,
      phone: body.phone,
      email: body.email.toLowerCase(),
      city: body.city,
      address: body.address,
      default_monthly_fee: body.default_monthly_fee,
      auth_password_hash: storedHash,
      plan_type: 'basic',
      is_active: true,
      subscription_ends_at: subscription_ends_at.toISOString(),
      trial_ends_at: subscription_ends_at.toISOString(), // Keep it in sync for MVP logic if used elsewhere
    }).select().single();

    if (error) throw error;
    res.status(201).json({ success: true, data: gym, message: 'Gym registered successfully!' });
  } catch (err) {
    if (err instanceof z.ZodError) {
      const errorMsg = err.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
      return res.status(400).json({ success: false, message: `Validation error: ${errorMsg}` });
    }
    throw err;
  }
});

// ── POST /api/admin/gyms/:id/login ───────
router.post('/gyms/:id/login', async (req, res) => {
  const { data: gym, error } = await supabase.from('gyms').select('*').eq('id', req.params.id).single();
  if (error || !gym) return res.status(404).json({ success: false, message: 'Gym not found' });

  // Generate session token for this gym
  const token = jwt.sign(
    { gym_id: gym.id, email: gym.email, role: 'gym_owner' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  const { auth_password_hash, ...safeGym } = gym;
  res.json({ success: true, token, role: 'gym_owner', gym: safeGym, message: 'Login generated' });
});

// ── GET /api/admin/gyms/:id ───────────────
router.get('/gyms/:id', async (req, res) => {
  const gymId = req.params.id;
  const { data: gym, error } = await supabase.from('gyms').select(`
    *, members(count), staff(count)
  `).eq('id', gymId).single();
  if (error || !gym) return res.status(404).json({ success: false, message: 'Gym not found' });

  // Proactive Suspension
  const now = new Date();
  const isExpired = gym.subscription_ends_at && new Date(gym.subscription_ends_at) < now;
  if (isExpired && gym.is_active) {
    await supabase.from('gyms').update({ is_active: false }).eq('id', gym.id);
    gym.is_active = false;
  }

  // Get sums manually
  const { data: payments } = await supabase.from('admin_notes').select('text').eq('gym_id', gymId).eq('admin', 'PaymentSystem');
  const { data: expenses } = await supabase.from('expenses').select('amount').eq('gym_id', gymId);
  const revenue = (payments || []).reduce((acc, p) => {
    try { 
      const val = JSON.parse(p.text).amount || 0;
      return acc + Number(val); 
    } catch(e) { return acc; }
  }, 0);
  const totalExpenses = (expenses || []).reduce((acc, e) => acc + Number(e.amount || 0), 0);

  const { auth_password_hash, ...safeGym } = gym;

  res.json({ success: true, data: { ...safeGym, revenue_this_month: revenue, expense_this_month: totalExpenses } });
});

// ── PATCH /api/admin/gyms/:id ─────────────
router.patch('/gyms/:id', async (req, res) => {
  const payload = { ...req.body };
  
  // Protect against non-columns
  delete payload.members;
  delete payload.staff;
  delete payload.revenue_this_month;
  delete payload.expense_this_month;
  delete payload.raw_password;
  
  if (payload.new_password) {
    const rawPass = payload.new_password;
    const hash = await bcrypt.hash(rawPass, 12);
    payload.auth_password_hash = hash;
    delete payload.new_password;
  }
  
  const { data, error } = await supabase.from('gyms').update(payload).eq('id', req.params.id).select().single();
  if (error) throw error;
  res.json({ success: true, data, message: 'Gym updated' });
});

// ── DELETE /api/admin/gyms/:id ────────────
router.delete('/gyms/:id', async (req, res) => {
  const { error } = await supabase.from('gyms').delete().eq('id', req.params.id);
  if (error) throw error;
  res.json({ success: true, message: 'Gym deleted entirely' });
});

// ── PATCH /api/admin/gyms/:id/plan ────────
router.patch('/gyms/:id/plan', async (req, res) => {
  const { plan_type, subscription_ends_at, is_active } = req.body;
  const { data, error } = await supabase.from('gyms').update({ plan_type, subscription_ends_at, is_active }).eq('id', req.params.id).select().single();
  if (error) throw error;
  res.json({ success: true, data, message: `Plan updated to ${plan_type}` });
});

// ── GET /api/admin/metrics ────────────────
router.get('/metrics', async (req, res) => {
  const { data: gyms, error } = await supabase.from('gyms').select('id, plan_type, is_active, created_at, trial_ends_at, subscription_ends_at');
  if (error) throw error;
  
  // Calculate total super admin revenue (Split)
  const { data: payments } = await supabase.from('admin_notes').select('text').eq('admin', 'PaymentSystem');
  let totalMonthlyRevenue = 0;
  let totalSetupRevenue = 0;
  
  for (const p of payments || []) {
    try { 
      const payload = JSON.parse(p.text);
      const val = Number(payload.amount || 0);
      if (payload.type === 'SETUP') {
        totalSetupRevenue += val;
      } else {
        totalMonthlyRevenue += val;
      }
    } catch(e) {}
  }

  const totalCombinedRevenue = totalMonthlyRevenue + totalSetupRevenue;

  const now = new Date();
  const totalGyms = gyms.length;
  const activePayingGyms = gyms.filter(g => g.is_active && g.plan_type !== 'free').length;
  const trialGyms = gyms.filter(g => g.trial_ends_at && new Date(g.trial_ends_at) > now).length;
  const churnedGyms = gyms.filter(g => !g.is_active).length;

  const planPrices = { free: 0, basic: 2000, pro: 5000 };
  const mrr = gyms.filter(g => g.is_active).reduce((s, g) => s + (planPrices[g.plan_type] || 0), 0);

  // New gyms this month
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const newThisMonth = gyms.filter(g => g.created_at >= firstOfMonth).length;

  // Renewals due next 7 days
  const in7 = new Date(now);
  in7.setDate(in7.getDate() + 7);
  const renewalsDue = gyms.filter(g => g.subscription_ends_at && new Date(g.subscription_ends_at) <= in7 && new Date(g.subscription_ends_at) >= now).length;

  res.json({ success: true, data: { 
    totalGyms, activePayingGyms, trialGyms, churnedGyms, mrr, newThisMonth, renewalsDue, 
    totalMonthlyRevenue, totalSetupRevenue, totalCombinedRevenue 
  } });
});

// ── GET /api/admin/alerts ─────────────────
router.get('/alerts', async (req, res) => {
  const now = new Date();
  const in7 = new Date(now); in7.setDate(in7.getDate() + 7);
  const day14ago = new Date(now); day14ago.setDate(day14ago.getDate() - 14);

  const { data: gyms } = await supabase.from('gyms').select('id, gym_name, owner_name, phone, city, last_login_at, trial_ends_at, subscription_ends_at, is_active');

  const alerts = [];
  for (const g of gyms || []) {
    // 1. Suspension Evaluation (Lazy Cron)
    const isExpired = (g.subscription_ends_at && new Date(g.subscription_ends_at) < now);
    if (isExpired && g.is_active) {
      await supabase.from('gyms').update({ is_active: false }).eq('id', g.id);
      g.is_active = false; // update local state
    }

    if (!g.is_active) {
      // It is suspended, add it as a high-priority alert
      alerts.push({ 
        id: `suspended_${g.id}`, 
        type: 'suspended_expired', 
        gym: g, 
        message: `Subscription expired on ${new Date(g.subscription_ends_at).toDateString()}` 
      });
      continue; // skip other alerts if suspended
    }

    // 2. Trial/Subscription Ending Soon
    if (g.subscription_ends_at && new Date(g.subscription_ends_at) <= in7 && new Date(g.subscription_ends_at) >= now) {
      alerts.push({ id: `expiring_${g.id}`, type: 'trial_ending', gym: g, message: `Access ends ${new Date(g.subscription_ends_at).toDateString()}` });
    }
    
    // 3. No Login Alert
    if (g.last_login_at && new Date(g.last_login_at) < day14ago) {
      alerts.push({ id: `nologin_${g.id}`, type: 'no_login', gym: g, message: `No login for 14+ days` });
    }
  }

  res.json({ success: true, data: alerts, count: alerts.length });
});

// ── POST /api/admin/gyms/:id/notes ────────
router.post('/gyms/:id/notes', async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ success: false, message: 'Note text required' });
  const { data, error } = await supabase.from('admin_notes').insert({ gym_id: req.params.id, text: text.trim(), admin: 'Super Admin', date: new Date().toISOString() }).select().single();
  if (error) throw error;
  res.status(201).json({ success: true, data });
});

// ── GET /api/admin/gyms/:id/notes ─────────
router.get('/gyms/:id/notes', async (req, res) => {
  const { data, error } = await supabase.from('admin_notes').select('*').eq('gym_id', req.params.id).eq('admin', 'Super Admin').order('date', { ascending: false });
  if (error) throw error;
  res.json({ success: true, data });
});

// ── PAYMENTS ROUTING ──────────────────────
router.post('/gyms/:id/payments', async (req, res) => {
  const { amount, type = 'RECURRING', date = new Date().toISOString() } = req.body;
  if (!amount || isNaN(Number(amount))) return res.status(400).json({ success: false, message: 'Valid amount required' });
  const text = JSON.stringify({ amount: Number(amount), date, type });
  const { data, error } = await supabase.from('admin_notes').insert({ 
    gym_id: req.params.id, text, admin: 'PaymentSystem', date
  }).select().single();
  if (error) throw error;
  res.status(201).json({ success: true, data });
});

router.patch('/gyms/:id/payments/:noteId', async (req, res) => {
  const { amount, type, date } = req.body;
  const { data: oldNote } = await supabase.from('admin_notes').select('text').eq('id', req.params.noteId).single();
  if (!oldNote) return res.status(404).json({ success: false, message: 'Payment not found' });

  const payload = JSON.parse(oldNote.text);
  if (amount !== undefined) payload.amount = Number(amount);
  if (type !== undefined) payload.type = type;
  if (date !== undefined) payload.date = date;

  const { data, error } = await supabase.from('admin_notes').update({ 
    text: JSON.stringify(payload),
    date: date || new Date().toISOString()
  }).eq('id', req.params.noteId).select().single();
  
  if (error) throw error;
  res.json({ success: true, data, message: 'Payment updated' });
});

router.get('/payments', async (req, res) => {
  const { data, error } = await supabase
    .from('admin_notes')
    .select('*, gym:gyms(gym_name)')
    .eq('admin', 'PaymentSystem')
    .order('date', { ascending: false });
  if (error) throw error;
  res.json({ success: true, data });
});

router.get('/gyms/:id/payments', async (req, res) => {
  const { data, error } = await supabase.from('admin_notes').select('*').eq('gym_id', req.params.id).eq('admin', 'PaymentSystem').order('date', { ascending: false });
  if (error) throw error;
  res.json({ success: true, data });
});

router.delete('/gyms/:id/payments/:noteId', async (req, res) => {
  const { error } = await supabase.from('admin_notes').delete().eq('id', req.params.noteId).eq('admin', 'PaymentSystem');
  if (error) throw error;
  res.json({ success: true, message: 'Payment deleted' });
});

router.post('/gyms/:id/renew', async (req, res) => {
  const { id } = req.params;
  const { amount, months, customDays } = req.body;
  if (!amount || isNaN(Number(amount))) return res.status(400).json({ success: false, message: 'Valid amount required' });

  // Fetch current gym state to determine start basis
  const { data: currentGym, error: fetchErr } = await supabase.from('gyms').select('subscription_ends_at').eq('id', id).single();
  if (fetchErr || !currentGym) return res.status(404).json({ success: false, message: 'Gym not found' });

  const now = new Date();
  const currentEnd = currentGym.subscription_ends_at ? new Date(currentGym.subscription_ends_at) : now;
  // If still active, add to existing end date. If expired, add from today.
  const startBasis = currentEnd > now ? currentEnd : now;
  
  let newEndDate = new Date(startBasis);
  if (customDays) {
    newEndDate.setDate(newEndDate.getDate() + Number(customDays));
  } else {
    newEndDate.setMonth(newEndDate.getMonth() + (Number(months) || 1));
  }

  const dateStr = newEndDate.toISOString();

  // 1. Update Gym
  const { data: updatedGym, error: gErr } = await supabase.from('gyms').update({
    subscription_ends_at: dateStr,
    trial_ends_at: dateStr, // Sync trial date too
    is_active: true
  }).eq('id', id).select().single();

  if (gErr) throw gErr;

  // 2. Log Payment in admin_notes
  const paymentText = JSON.stringify({ 
    amount: Number(amount), 
    date: now.toISOString(), 
    type: 'RECURRING',
    note: `Renewal for ${months || customDays} ${customDays ? 'days' : 'months'}`
  });
  
  await supabase.from('admin_notes').insert({
    gym_id: id,
    text: paymentText,
    admin: 'PaymentSystem',
    date: now.toISOString()
  });

  res.json({ success: true, data: updatedGym, message: 'Gym access renewed successfully!' });
});

module.exports = router;
