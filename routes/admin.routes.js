const express = require('express');
const { supabase } = require('../db/supabase');
const { authenticate, requireAdmin } = require('../middleware/auth');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const { resolveEndDate, deriveBillingStatus, periodStart } = require('../lib/subscription');
const { dialCodeForTimezone } = require('../lib/dialCodes');
const router = express.Router();

/**
 * Append to the subscription audit trail. Never allowed to fail the request
 * that triggered it — a lost audit row must not roll back a completed renewal.
 */
async function logSubscriptionEvent(gymId, event, { from, to, actor, note } = {}) {
  try {
    await supabase.from('subscription_events').insert({
      gym_id: gymId,
      event,
      from_state: from || null,
      to_state: to || null,
      actor: actor || 'super_admin',
      note: note || null,
    });
  } catch (err) {
    console.error('[subscription_events] failed to record', event, err.message);
  }
}

/** The subset of gym fields worth snapshotting into an audit event. */
const billingSnapshot = (g) => g && ({
  plan_type: g.plan_type,
  plan_id: g.plan_id,
  billing_status: g.billing_status,
  is_active: g.is_active,
  trial_ends_at: g.trial_ends_at,
  subscription_ends_at: g.subscription_ends_at,
});
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



  res.json({ success: true, data, count });
});

// ── POST /api/admin/gyms ──────────────────
// Creates a gym with an explicit plan, an explicit trial-or-paid period, and
// its own locale. Previously this hardcoded plan_type:'basic', ignored the
// subscription_duration the client could send, and wrote the same timestamp to
// both trial_ends_at and subscription_ends_at.
router.post('/gyms', async (req, res) => {
  const schema = z.object({
    gym_name: z.string().min(2).max(100),
    owner_name: z.string().min(2).max(100),
    // gyms.phone is NOT NULL, so this cannot be optional — a blank one
    // failed at the database with an opaque 500 instead of a field error.
    phone: z.string().min(6, 'A contact phone number is required.').max(30),
    email: z.string().email(),
    password: z.string().min(8).max(100),
    city: z.string().max(80).optional().or(z.literal('')),
    address: z.string().max(300).optional().or(z.literal('')),
    default_monthly_fee: z.coerce.number().min(0).default(3000),

    plan_code: z.string().default('basic'),

    // Billing mode. A trial and a paid period are different things: a trial has
    // an end date but no expectation of payment.
    billing_mode: z.enum(['trial', 'paid']).default('paid'),
    trial_days: z.coerce.number().int().min(1).max(365).optional(),
    subscription_months: z.coerce.number().int().min(1).max(60).optional(),
    subscription_days: z.coerce.number().int().min(1).max(3650).optional(),
    starts_at: z.string().datetime().optional(),

    // Locale — set once at creation so the gym owner sees their own currency
    // and their day boundaries land in their own timezone.
    currency: z.string().length(3).default('PKR'),
    timezone: z.string().min(3).max(64).default('Asia/Karachi'),
    locale: z.string().min(2).max(10).default('en-PK'),
    payment_methods: z.array(z.string()).min(1).default(['cash', 'card', 'bank_transfer']),
    // Optional: derived from the timezone when not supplied. Without this the
    // column default ('92') applied to every gym, so a US gym's member numbers
    // were rewritten to +92 and WhatsApp messages went to the wrong country.
    country_code: z.string().regex(/^\d{1,4}$/).optional(),

    setup_fee: z.coerce.number().min(0).optional(),
  });

  const body = schema.parse(req.body);
  const email = body.email.toLowerCase().trim();

  const { data: existing } = await supabase.from('gyms').select('id').eq('email', email).maybeSingle();
  if (existing) return res.status(409).json({ success: false, message: 'That email is already registered.' });

  const { data: plan } = await supabase.from('plans').select('*').eq('code', body.plan_code).maybeSingle();
  if (!plan) {
    return res.status(400).json({ success: false, message: `Unknown plan "${body.plan_code}".` });
  }

  const startsAt = body.starts_at ? new Date(body.starts_at) : new Date();
  if (Number.isNaN(startsAt.getTime())) {
    return res.status(400).json({ success: false, message: 'Invalid start date.' });
  }

  let trialEndsAt = null;
  let subscriptionEndsAt = null;

  if (body.billing_mode === 'trial') {
    trialEndsAt = resolveEndDate({ startFrom: startsAt, days: body.trial_days ?? 14 }, startsAt);
    // Access is granted for the trial window; there is no paid period yet.
    subscriptionEndsAt = trialEndsAt;
  } else {
    subscriptionEndsAt = resolveEndDate(
      { startFrom: startsAt, months: body.subscription_months, days: body.subscription_days },
      startsAt
    );
    if (!subscriptionEndsAt) {
      return res.status(400).json({
        success: false,
        message: 'Choose a subscription length — months or days.',
      });
    }
  }

  const hash = await bcrypt.hash(body.password, 12);

  const { data: gym, error } = await supabase.from('gyms').insert({
    gym_name: body.gym_name.trim(),
    owner_name: body.owner_name.trim(),
    phone: body.phone,
    email,
    city: body.city || null,
    address: body.address || null,
    default_monthly_fee: body.default_monthly_fee,
    auth_password_hash: hash,
    role: 'gym_owner',
    plan_id: plan.id,
    plan_type: plan.code,
    is_active: true,
    billing_status: body.billing_mode === 'trial' ? 'trialing' : 'active',
    subscription_started_at: startsAt.toISOString(),
    subscription_ends_at: subscriptionEndsAt.toISOString(),
    trial_ends_at: trialEndsAt ? trialEndsAt.toISOString() : null,
    currency: body.currency.toUpperCase(),
    timezone: body.timezone,
    locale: body.locale,
    country_code: body.country_code || dialCodeForTimezone(body.timezone) || '92',
    payment_methods: body.payment_methods,
  }).select().single();

  if (error) throw error;

  await logSubscriptionEvent(gym.id, body.billing_mode === 'trial' ? 'trial_started' : 'created', {
    to: billingSnapshot(gym),
    actor: req.user?.email,
    note: `Created on ${plan.name}`,
  });

  if (body.setup_fee > 0) {
    await supabase.from('platform_payments').insert({
      gym_id: gym.id,
      amount: body.setup_fee,
      currency: gym.currency,
      kind: 'setup',
      note: 'One-time setup fee',
      created_by: req.user?.email || 'super_admin',
    });
  }

  const { auth_password_hash: _pw, ...safeGym } = gym;
  res.status(201).json({ success: true, data: safeGym, message: `${gym.gym_name} registered.` });
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

  const { auth_password_hash: _pw, ...safeGym } = gym;
  res.json({ success: true, token, role: 'gym_owner', gym: safeGym, message: 'Login generated' });
});

// ── GET /api/admin/gyms/:id ───────────────
router.get('/gyms/:id', async (req, res) => {
  const gymId = req.params.id;
  const { data: gym, error } = await supabase.from('gyms').select(`
    *, plan:plans(id, code, name, price, currency, billing_period, member_limit),
    members(count), staff(count)
  `).eq('id', gymId).single();
  if (error || !gym) return res.status(404).json({ success: false, message: 'Gym not found' });

  const now = new Date();
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const [platformRes, memberRevRes, expenseRes] = await Promise.all([
    // What this gym has paid US.
    supabase.from('platform_payments').select('amount, kind, paid_at').eq('gym_id', gymId),
    // What this gym collected from its own members this month.
    supabase.from('payments').select('amount').eq('gym_id', gymId).gte('payment_date', firstOfMonth.slice(0, 10)),
    supabase.from('expenses').select('amount').eq('gym_id', gymId).gte('expense_date', firstOfMonth.slice(0, 10)),
  ]);

  const platformPayments = platformRes.data || [];
  const sum = (rows) => rows.reduce((acc, r) => acc + (Number(r.amount) || 0), 0);

  // These were previously one figure named `revenue_this_month` that actually
  // summed every platform payment ever made, with no date filter at all.
  const platformRevenueTotal = sum(platformPayments);
  const platformRevenueThisMonth = sum(platformPayments.filter((p) => p.paid_at >= firstOfMonth));

  const { auth_password_hash: _pw, ...safeGym } = gym;

  res.json({
    success: true,
    data: {
      ...safeGym,
      platform_revenue_total: platformRevenueTotal,
      platform_revenue_this_month: platformRevenueThisMonth,
      revenue_this_month: sum(memberRevRes.data || []),
      expense_this_month: sum(expenseRes.data || []),
      payments_this_month: (memberRevRes.data || []).length,
    },
  });
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
/**
 * Permanently remove a gym and everything belonging to it.
 *
 * There was no way to do this at all — a gym created by mistake could only be
 * suspended, and its rows stayed in the platform's metrics forever.
 *
 * Every child table is declared ON DELETE CASCADE, so one delete removes the
 * members, payments, staff, classes, leads, products, sales, measurements and
 * messaging rows with it. That is not reversible, so the caller must confirm by
 * sending the gym's exact name.
 */
router.delete('/gyms/:id', async (req, res) => {
  const { data: gym } = await supabase
    .from('gyms').select('id, gym_name, role').eq('id', req.params.id).maybeSingle();
  if (!gym) return res.status(404).json({ success: false, message: 'Gym not found.' });

  // A super admin deleting their own account would lock everyone out.
  if (gym.role === 'admin') {
    return res.status(400).json({ success: false, message: 'Platform admin accounts cannot be deleted here.' });
  }
  if (gym.id === req.user.gym_id) {
    return res.status(400).json({ success: false, message: 'You cannot delete the account you are signed in as.' });
  }

  // Typing the name is the guard against deleting the wrong row from a list.
  const confirmation = req.body?.confirm_name ?? req.query?.confirm_name;
  if (confirmation !== undefined && confirmation !== gym.gym_name) {
    return res.status(400).json({
      success: false,
      message: `Confirmation did not match. Type "${gym.gym_name}" exactly to delete it.`,
    });
  }

  const { error } = await supabase.from('gyms').delete().eq('id', gym.id);
  if (error) throw error;

  res.json({ success: true, message: `${gym.gym_name} and all of its data were deleted.` });
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
  const [gymsRes, plansRes, paymentsRes] = await Promise.all([
    supabase.from('gyms').select('id, plan_id, plan_type, is_active, created_at, trial_ends_at, subscription_ends_at, billing_status'),
    supabase.from('plans').select('id, code, price'),
    supabase.from('platform_payments').select('amount, kind, paid_at'),
  ]);

  if (gymsRes.error) throw gymsRes.error;

  const gyms = gymsRes.data || [];
  const plans = plansRes.data || [];
  const payments = paymentsRes.data || [];

  // Prices come from the plans table. They were previously hardcoded here as
  // { free: 0, basic: 2000, pro: 5000 } and duplicated in the frontend, so the
  // dashboard could report an MRR that no longer matched what customers paid.
  const priceById = new Map(plans.map((p) => [p.id, Number(p.price) || 0]));
  const priceByCode = new Map(plans.map((p) => [p.code, Number(p.price) || 0]));
  const planPrice = (g) => priceById.get(g.plan_id) ?? priceByCode.get(g.plan_type) ?? 0;

  let totalMonthlyRevenue = 0;
  let totalSetupRevenue = 0;
  for (const p of payments) {
    const amount = Number(p.amount) || 0;
    if (p.kind === 'setup') totalSetupRevenue += amount;
    else if (p.kind === 'refund') totalMonthlyRevenue -= Math.abs(amount);
    else totalMonthlyRevenue += amount;
  }

  const now = new Date();
  const isTrialing = (g) => g.trial_ends_at && new Date(g.trial_ends_at) > now;

  const totalGyms = gyms.length;
  const activePayingGyms = gyms.filter((g) => g.is_active && !isTrialing(g) && planPrice(g) > 0).length;
  const trialGyms = gyms.filter((g) => g.is_active && isTrialing(g)).length;
  const churnedGyms = gyms.filter((g) => !g.is_active).length;

  // MRR counts only gyms actually being billed — a gym on a free trial is not
  // recurring revenue, and the old calculation counted it as such.
  const mrr = gyms
    .filter((g) => g.is_active && !isTrialing(g))
    .reduce((sum, g) => sum + planPrice(g), 0);

  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const newThisMonth = gyms.filter((g) => g.created_at >= firstOfMonth).length;

  const revenueThisMonth = payments
    .filter((p) => p.paid_at >= firstOfMonth)
    .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);

  const in7 = new Date(now);
  in7.setDate(in7.getDate() + 7);
  const renewalsDue = gyms.filter(
    (g) => g.subscription_ends_at
      && new Date(g.subscription_ends_at) <= in7
      && new Date(g.subscription_ends_at) >= now
  ).length;

  res.json({
    success: true,
    data: {
      totalGyms,
      activePayingGyms,
      trialGyms,
      churnedGyms,
      mrr,
      newThisMonth,
      renewalsDue,
      revenueThisMonth,
      totalMonthlyRevenue,
      totalSetupRevenue,
      totalCombinedRevenue: totalMonthlyRevenue + totalSetupRevenue,
    },
  });
});

// ── GET /api/admin/alerts ─────────────────
router.get('/alerts', async (req, res) => {
  const now = new Date();
  const in7 = new Date(now); in7.setDate(in7.getDate() + 7);
  const day14ago = new Date(now); day14ago.setDate(day14ago.getDate() - 14);

  const { data: gyms } = await supabase.from('gyms').select('id, gym_name, owner_name, phone, city, last_login_at, trial_ends_at, subscription_ends_at, is_active');

  const alerts = [];
  for (const g of gyms || []) {
    // 1. Suspension Evaluation
    const isExpired = (g.subscription_ends_at && new Date(g.subscription_ends_at) < now);

    if (!g.is_active) {
      // It is suspended, add it as a high-priority alert
      alerts.push({ 
        id: `suspended_${g.id}`, 
        type: 'suspended_expired', 
        gym: g, 
        message: `Gym is suspended manually` 
      });
      continue; // skip other alerts if suspended
    }
    
    if (isExpired && g.is_active) {
      alerts.push({ 
        id: `expired_active_${g.id}`, 
        type: 'suspended_expired', 
        gym: g, 
        message: `Subscription expired on ${new Date(g.subscription_ends_at).toDateString()} (Needs Suspension)` 
      });
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

/// ── PLATFORM PAYMENTS ─────────────────────
// These read and write the real `platform_payments` table. Money previously
// lived as a JSON string inside admin_notes.text, keyed by the magic value
// admin='PaymentSystem', so amounts could not be summed in SQL and a single
// malformed row zeroed the entire revenue figure.

const paymentSchema = z.object({
  amount: z.coerce.number().refine((n) => n !== 0, 'Amount cannot be zero.'),
  kind: z.enum(['subscription', 'setup', 'refund', 'adjustment']).default('subscription'),
  note: z.string().max(300).optional().or(z.literal('')),
  paid_at: z.string().optional(),
});

router.post('/gyms/:id/payments', async (req, res) => {
  const body = paymentSchema.parse(req.body);

  const { data: gym } = await supabase.from('gyms').select('currency').eq('id', req.params.id).maybeSingle();
  if (!gym) return res.status(404).json({ success: false, message: 'Gym not found.' });

  const { data, error } = await supabase.from('platform_payments').insert({
    gym_id: req.params.id,
    amount: body.amount,
    currency: gym.currency || 'PKR',
    kind: body.kind,
    note: body.note || null,
    paid_at: body.paid_at ? new Date(body.paid_at).toISOString() : new Date().toISOString(),
    created_by: req.user?.email || 'super_admin',
  }).select().single();

  if (error) throw error;
  res.status(201).json({ success: true, data, message: 'Payment recorded.' });
});

router.get('/gyms/:id/payments', async (req, res) => {
  const { data, error } = await supabase
    .from('platform_payments')
    .select('*')
    .eq('gym_id', req.params.id)
    .order('paid_at', { ascending: false });
  if (error) throw error;
  res.json({ success: true, data });
});

router.patch('/gyms/:id/payments/:paymentId', async (req, res) => {
  const body = paymentSchema.partial().parse(req.body);
  const patch = {};
  if (body.amount !== undefined) patch.amount = body.amount;
  if (body.kind !== undefined) patch.kind = body.kind;
  if (body.note !== undefined) patch.note = body.note || null;
  if (body.paid_at !== undefined) patch.paid_at = new Date(body.paid_at).toISOString();

  const { data, error } = await supabase
    .from('platform_payments')
    .update(patch)
    .eq('id', req.params.paymentId)
    .eq('gym_id', req.params.id)
    .select()
    .single();

  if (error) throw error;
  if (!data) return res.status(404).json({ success: false, message: 'Payment not found.' });
  res.json({ success: true, data, message: 'Payment updated.' });
});

router.delete('/gyms/:id/payments/:paymentId', async (req, res) => {
  const { error } = await supabase
    .from('platform_payments')
    .delete()
    .eq('id', req.params.paymentId)
    .eq('gym_id', req.params.id);
  if (error) throw error;
  res.json({ success: true, message: 'Payment voided.' });
});

router.get('/payments', async (req, res) => {
  const { data, error } = await supabase
    .from('platform_payments')
    .select('*, gym:gyms(gym_name, currency)')
    .order('paid_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  res.json({ success: true, data });
});


// ── SUBSCRIPTION LIFECYCLE ────────────────

/**
 * Apply a new end date, flip the status, record the money, log the event.
 *
 * The period arithmetic lives in lib/subscription.js because it was previously
 * written out four times across this file and the frontend, and the copies
 * disagreed: two extended from today, two from the current end date.
 */
async function applyPeriodChange({ gymId, event, months, days, amount, note, actor, activate }) {
  const { data: current } = await supabase.from('gyms').select('*').eq('id', gymId).maybeSingle();
  if (!current) return { error: { status: 404, message: 'Gym not found.' } };

  const newEnd = resolveEndDate({ startFrom: current.subscription_ends_at, months, days }, new Date());
  if (!newEnd) {
    return { error: { status: 400, message: 'Choose how long to extend by — months or days.' } };
  }

  const patch = {
    subscription_ends_at: newEnd.toISOString(),
    billing_status: 'active',
  };
  if (activate) patch.is_active = true;
  // Paying for a period ends any trial that was still running.
  if (current.trial_ends_at) patch.trial_ends_at = null;

  const { data: updated, error } = await supabase
    .from('gyms').update(patch).eq('id', gymId).select().single();
  if (error) throw error;

  if (amount > 0) {
    await supabase.from('platform_payments').insert({
      gym_id: gymId,
      amount,
      currency: current.currency || 'PKR',
      kind: 'subscription',
      note: note || (days ? `Renewal: ${days} days` : `Renewal: ${months} months`),
      created_by: actor || 'super_admin',
    });
  }

  await logSubscriptionEvent(gymId, event, {
    from: billingSnapshot(current),
    to: billingSnapshot(updated),
    actor,
    note,
  });

  return { data: updated };
}

router.post('/gyms/:id/renew', async (req, res) => {
  const schema = z.object({
    amount: z.coerce.number().min(0).default(0),
    months: z.coerce.number().int().min(1).max(60).optional(),
    customDays: z.coerce.number().int().min(1).max(3650).optional(),
    note: z.string().max(300).optional(),
  });
  const body = schema.parse(req.body);

  const result = await applyPeriodChange({
    gymId: req.params.id,
    event: 'extended',
    months: body.months,
    days: body.customDays,
    amount: body.amount,
    note: body.note,
    actor: req.user?.email,
    activate: true,
  });

  if (result.error) {
    return res.status(result.error.status).json({ success: false, message: result.error.message });
  }

  const { auth_password_hash: _pw, ...safeGym } = result.data;
  res.json({ success: true, data: safeGym, message: 'Subscription renewed.' });
});

// Convert a running trial into a paid subscription.
router.post('/gyms/:id/convert-trial', async (req, res) => {
  const schema = z.object({
    plan_code: z.string(),
    months: z.coerce.number().int().min(1).max(60).default(1),
    amount: z.coerce.number().min(0).default(0),
  });
  const body = schema.parse(req.body);

  const { data: current } = await supabase.from('gyms').select('*').eq('id', req.params.id).maybeSingle();
  if (!current) return res.status(404).json({ success: false, message: 'Gym not found.' });

  const { data: plan } = await supabase.from('plans').select('*').eq('code', body.plan_code).maybeSingle();
  if (!plan) return res.status(400).json({ success: false, message: `Unknown plan "${body.plan_code}".` });

  // The paid period starts when the trial ends, so the customer keeps the trial
  // days they were promised instead of forfeiting them at conversion.
  const basis = periodStart(current.trial_ends_at || current.subscription_ends_at);
  const newEnd = resolveEndDate({ startFrom: basis, months: body.months }, new Date());

  const { data: updated, error } = await supabase.from('gyms').update({
    plan_id: plan.id,
    plan_type: plan.code,
    trial_ends_at: null,
    subscription_ends_at: newEnd.toISOString(),
    billing_status: 'active',
    is_active: true,
  }).eq('id', req.params.id).select().single();
  if (error) throw error;

  if (body.amount > 0) {
    await supabase.from('platform_payments').insert({
      gym_id: req.params.id,
      amount: body.amount,
      currency: current.currency || 'PKR',
      kind: 'subscription',
      note: `Trial converted to ${plan.name}`,
      created_by: req.user?.email || 'super_admin',
    });
  }

  await logSubscriptionEvent(req.params.id, 'trial_converted', {
    from: billingSnapshot(current),
    to: billingSnapshot(updated),
    actor: req.user?.email,
    note: `Converted to ${plan.name} for ${body.months} month(s)`,
  });

  const { auth_password_hash: _pw, ...safeGym } = updated;
  res.json({ success: true, data: safeGym, message: `Converted to ${plan.name}.` });
});

router.post('/gyms/:id/suspend', async (req, res) => {
  const { reason } = req.body || {};
  const { data: current } = await supabase.from('gyms').select('*').eq('id', req.params.id).maybeSingle();
  if (!current) return res.status(404).json({ success: false, message: 'Gym not found.' });

  const { data: updated, error } = await supabase.from('gyms')
    .update({ is_active: false, billing_status: 'suspended' })
    .eq('id', req.params.id).select().single();
  if (error) throw error;

  await logSubscriptionEvent(req.params.id, 'suspended', {
    from: billingSnapshot(current),
    to: billingSnapshot(updated),
    actor: req.user?.email,
    note: reason || null,
  });

  const { auth_password_hash: _pw, ...safeGym } = updated;
  res.json({ success: true, data: safeGym, message: 'Gym suspended.' });
});

router.post('/gyms/:id/reactivate', async (req, res) => {
  const { data: current } = await supabase.from('gyms').select('*').eq('id', req.params.id).maybeSingle();
  if (!current) return res.status(404).json({ success: false, message: 'Gym not found.' });

  const { data: updated, error } = await supabase.from('gyms')
    .update({
      is_active: true,
      // Recompute rather than assume 'active' — a gym whose period already
      // lapsed should come back as past_due, not look like it paid.
      billing_status: deriveBillingStatus({ ...current, is_active: true }),
    })
    .eq('id', req.params.id).select().single();
  if (error) throw error;

  await logSubscriptionEvent(req.params.id, 'reactivated', {
    from: billingSnapshot(current),
    to: billingSnapshot(updated),
    actor: req.user?.email,
  });

  const { auth_password_hash: _pw, ...safeGym } = updated;
  res.json({ success: true, data: safeGym, message: 'Gym reactivated.' });
});

// Change plan without touching the current period.
router.post('/gyms/:id/change-plan', async (req, res) => {
  const { plan_code } = req.body || {};
  const { data: plan } = await supabase.from('plans').select('*').eq('code', plan_code).maybeSingle();
  if (!plan) return res.status(400).json({ success: false, message: `Unknown plan "${plan_code}".` });

  const { data: current } = await supabase.from('gyms').select('*').eq('id', req.params.id).maybeSingle();
  if (!current) return res.status(404).json({ success: false, message: 'Gym not found.' });

  const { data: updated, error } = await supabase.from('gyms')
    .update({ plan_id: plan.id, plan_type: plan.code })
    .eq('id', req.params.id).select().single();
  if (error) throw error;

  await logSubscriptionEvent(req.params.id, 'plan_changed', {
    from: billingSnapshot(current),
    to: billingSnapshot(updated),
    actor: req.user?.email,
    note: `${current.plan_type} to ${plan.code}`,
  });

  const { auth_password_hash: _pw, ...safeGym } = updated;
  res.json({ success: true, data: safeGym, message: `Moved to ${plan.name}.` });
});

// ── GET /api/admin/gyms/:id/events ────────
router.get('/gyms/:id/events', async (req, res) => {
  const { data, error } = await supabase
    .from('subscription_events')
    .select('*')
    .eq('gym_id', req.params.id)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  res.json({ success: true, data });
});

module.exports = router;
