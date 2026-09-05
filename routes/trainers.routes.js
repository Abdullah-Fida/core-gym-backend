const express = require('express');
const { z } = require('zod');
const { supabase } = require('../db/supabase');
const { authenticate } = require('../middleware/auth');
const {
  commissionOnSale,
  commissionOnSession,
  sessionsRemaining,
  canLogSession,
  deriveSubscriptionStatus,
} = require('../lib/commission');

const router = express.Router();
router.use(authenticate);

/** Every query is scoped to the caller's gym; nothing here trusts a body-supplied gym_id. */
const gymOf = (req) => req.user.gym_id;

// ════════════════════════════════════════════════════
// PT PACKAGES
// ════════════════════════════════════════════════════

const packageSchema = z.object({
  name: z.string().min(2).max(80),
  description: z.string().max(300).optional().or(z.literal('')),
  sessions_total: z.coerce.number().int().min(1).max(500),
  price: z.coerce.number().min(0),
  validity_days: z.coerce.number().int().min(1).max(3650).default(90),
  commission_type: z.enum(['percent', 'flat']).default('percent'),
  commission_value: z.coerce.number().min(0),
  is_active: z.boolean().default(true),
}).refine(
  (p) => p.commission_type !== 'percent' || p.commission_value <= 100,
  { message: 'A percentage commission cannot exceed 100.', path: ['commission_value'] }
);

router.get('/packages', async (req, res) => {
  const { data, error } = await supabase
    .from('pt_packages')
    .select('*')
    .eq('gym_id', gymOf(req))
    .order('created_at', { ascending: false });
  if (error) throw error;
  res.json({ success: true, data });
});

router.post('/packages', async (req, res) => {
  const body = packageSchema.parse(req.body);
  const { data, error } = await supabase
    .from('pt_packages')
    .insert({ ...body, gym_id: gymOf(req) })
    .select()
    .single();
  if (error) throw error;
  res.status(201).json({ success: true, data, message: 'Package created.' });
});

router.patch('/packages/:id', async (req, res) => {
  const body = packageSchema.partial().parse(req.body);
  const { data, error } = await supabase
    .from('pt_packages')
    .update({ ...body, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('gym_id', gymOf(req))
    .select()
    .single();
  if (error) throw error;
  if (!data) return res.status(404).json({ success: false, message: 'Package not found.' });
  res.json({ success: true, data, message: 'Package updated.' });
});

router.delete('/packages/:id', async (req, res) => {
  const { count } = await supabase
    .from('pt_subscriptions')
    .select('id', { count: 'exact', head: true })
    .eq('package_id', req.params.id);

  if (count > 0) {
    // Sold subscriptions reference this package. Deactivate instead of deleting
    // so their history stays intact.
    const { data, error } = await supabase
      .from('pt_packages')
      .update({ is_active: false })
      .eq('id', req.params.id)
      .eq('gym_id', gymOf(req))
      .select()
      .single();
    if (error) throw error;
    return res.json({
      success: true,
      data,
      message: `${count} member${count === 1 ? ' has' : 's have'} bought this package, so it was deactivated rather than deleted.`,
    });
  }

  const { error } = await supabase
    .from('pt_packages')
    .delete()
    .eq('id', req.params.id)
    .eq('gym_id', gymOf(req));
  if (error) throw error;
  res.json({ success: true, message: 'Package deleted.' });
});

// ════════════════════════════════════════════════════
// ASSIGNMENTS
// ════════════════════════════════════════════════════

// GET /api/trainers/assignments?member_id= | ?staff_id=
router.get('/assignments', async (req, res) => {
  let query = supabase
    .from('trainer_assignments')
    .select('*, staff:staff(id, name, role, phone), member:members(id, name, phone, status)')
    .eq('gym_id', gymOf(req))
    .is('ended_at', null);

  if (req.query.member_id) query = query.eq('member_id', req.query.member_id);
  if (req.query.staff_id) query = query.eq('staff_id', req.query.staff_id);

  const { data, error } = await query.order('assigned_at', { ascending: false });
  if (error) throw error;
  res.json({ success: true, data });
});

// POST /api/trainers/assignments — assign a trainer to a member
router.post('/assignments', async (req, res) => {
  const schema = z.object({
    member_id: z.string().uuid(),
    staff_id: z.string().uuid(),
    is_primary: z.boolean().default(true),
    note: z.string().max(300).optional(),
  });
  const body = schema.parse(req.body);
  const gymId = gymOf(req);

  // Both sides must belong to this gym, and the staff member must be a trainer.
  const [{ data: member }, { data: staff }] = await Promise.all([
    supabase.from('members').select('id').eq('id', body.member_id).eq('gym_id', gymId).maybeSingle(),
    supabase.from('staff').select('id, role, name').eq('id', body.staff_id).eq('gym_id', gymId).maybeSingle(),
  ]);

  if (!member) return res.status(404).json({ success: false, message: 'Member not found.' });
  if (!staff) return res.status(404).json({ success: false, message: 'Staff member not found.' });
  if (staff.role !== 'trainer') {
    return res.status(400).json({ success: false, message: `${staff.name} is not a trainer.` });
  }

  // Close any existing primary assignment. The partial unique index would
  // otherwise reject the insert, and silently replacing is what the UI means.
  if (body.is_primary) {
    await supabase
      .from('trainer_assignments')
      .update({ ended_at: new Date().toISOString() })
      .eq('member_id', body.member_id)
      .eq('is_primary', true)
      .is('ended_at', null);
  }

  const { data, error } = await supabase
    .from('trainer_assignments')
    .insert({ ...body, gym_id: gymId })
    .select('*, staff:staff(id, name, role)')
    .single();
  if (error) throw error;

  res.status(201).json({ success: true, data, message: `${staff.name} assigned.` });
});

// DELETE /api/trainers/assignments/:id — end an assignment (never hard-delete)
router.delete('/assignments/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('trainer_assignments')
    .update({ ended_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('gym_id', gymOf(req))
    .select()
    .single();
  if (error) throw error;
  if (!data) return res.status(404).json({ success: false, message: 'Assignment not found.' });
  res.json({ success: true, message: 'Assignment ended.' });
});

// ════════════════════════════════════════════════════
// PT SUBSCRIPTIONS (selling a package)
// ════════════════════════════════════════════════════

router.get('/subscriptions', async (req, res) => {
  let query = supabase
    .from('pt_subscriptions')
    .select('*, staff:staff(id, name), member:members(id, name, phone)')
    .eq('gym_id', gymOf(req));

  if (req.query.member_id) query = query.eq('member_id', req.query.member_id);
  if (req.query.staff_id) query = query.eq('staff_id', req.query.staff_id);
  if (req.query.status) query = query.eq('status', req.query.status);

  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) throw error;

  res.json({
    success: true,
    data: (data || []).map((s) => ({ ...s, sessions_remaining: sessionsRemaining(s) })),
  });
});

// POST /api/trainers/subscriptions — sell a package to a member
router.post('/subscriptions', async (req, res) => {
  const schema = z.object({
    member_id: z.string().uuid(),
    staff_id: z.string().uuid(),
    package_id: z.string().uuid(),
    price_paid: z.coerce.number().min(0).optional(),
    starts_at: z.string().optional(),
  });
  const body = schema.parse(req.body);
  const gymId = gymOf(req);

  const [{ data: pkg }, { data: staff }, { data: member }] = await Promise.all([
    supabase.from('pt_packages').select('*').eq('id', body.package_id).eq('gym_id', gymId).maybeSingle(),
    supabase.from('staff').select('id, name, role').eq('id', body.staff_id).eq('gym_id', gymId).maybeSingle(),
    supabase.from('members').select('id, name').eq('id', body.member_id).eq('gym_id', gymId).maybeSingle(),
  ]);

  if (!pkg) return res.status(404).json({ success: false, message: 'Package not found.' });
  if (!staff) return res.status(404).json({ success: false, message: 'Trainer not found.' });
  if (staff.role !== 'trainer') {
    return res.status(400).json({ success: false, message: `${staff.name} is not a trainer.` });
  }
  if (!member) return res.status(404).json({ success: false, message: 'Member not found.' });

  const startsAt = body.starts_at ? new Date(body.starts_at) : new Date();
  const expiresAt = new Date(startsAt);
  expiresAt.setDate(expiresAt.getDate() + pkg.validity_days);

  const pricePaid = body.price_paid ?? Number(pkg.price);

  const { data: sub, error } = await supabase.from('pt_subscriptions').insert({
    gym_id: gymId,
    member_id: body.member_id,
    staff_id: body.staff_id,
    package_id: pkg.id,
    // Snapshot the terms — the package may be renamed or repriced later.
    package_name: pkg.name,
    sessions_total: pkg.sessions_total,
    sessions_used: 0,
    price_paid: pricePaid,
    starts_at: startsAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    status: 'active',
  }).select('*, staff:staff(id, name), member:members(id, name)').single();

  if (error) throw error;

  // A percentage commission is fully earned at the point of sale; a flat one
  // accrues per session instead.
  const saleCommission = commissionOnSale(pkg, pricePaid);
  if (saleCommission > 0) {
    await supabase.from('trainer_commissions').insert({
      gym_id: gymId,
      staff_id: body.staff_id,
      member_id: body.member_id,
      subscription_id: sub.id,
      amount: saleCommission,
      source: 'package_sale',
      status: 'pending',
      note: `${pkg.commission_value}% of ${pkg.name}`,
    });
  }

  res.status(201).json({
    success: true,
    data: { ...sub, sessions_remaining: sessionsRemaining(sub) },
    message: `${pkg.name} sold to ${member.name}.`,
  });
});

router.post('/subscriptions/:id/cancel', async (req, res) => {
  const gymId = gymOf(req);
  const { data: sub } = await supabase
    .from('pt_subscriptions').select('*').eq('id', req.params.id).eq('gym_id', gymId).maybeSingle();
  if (!sub) return res.status(404).json({ success: false, message: 'Package not found.' });

  const { data, error } = await supabase
    .from('pt_subscriptions').update({ status: 'cancelled' }).eq('id', req.params.id).select().single();
  if (error) throw error;

  // Void commission that has not been paid out yet. Anything already settled
  // stays — the trainer has been paid and that is not reversible here.
  await supabase
    .from('trainer_commissions')
    .update({ status: 'cancelled', note: 'Package cancelled' })
    .eq('subscription_id', req.params.id)
    .eq('status', 'pending');

  res.json({ success: true, data, message: 'Package cancelled.' });
});

// ════════════════════════════════════════════════════
// PT SESSIONS
// ════════════════════════════════════════════════════

router.get('/sessions', async (req, res) => {
  let query = supabase
    .from('pt_sessions')
    .select('*, staff:staff(id, name), member:members(id, name)')
    .eq('gym_id', gymOf(req));

  if (req.query.subscription_id) query = query.eq('subscription_id', req.query.subscription_id);
  if (req.query.staff_id) query = query.eq('staff_id', req.query.staff_id);
  if (req.query.member_id) query = query.eq('member_id', req.query.member_id);
  if (req.query.from) query = query.gte('session_date', req.query.from);
  if (req.query.to) query = query.lte('session_date', req.query.to);

  const { data, error } = await query.order('session_date', { ascending: false }).limit(500);
  if (error) throw error;
  res.json({ success: true, data });
});

// POST /api/trainers/sessions — log a delivered session
router.post('/sessions', async (req, res) => {
  const schema = z.object({
    subscription_id: z.string().uuid(),
    session_date: z.string().optional(),
    duration_min: z.coerce.number().int().min(1).max(600).optional(),
    note: z.string().max(300).optional(),
  });
  const body = schema.parse(req.body);
  const gymId = gymOf(req);

  const { data: sub } = await supabase
    .from('pt_subscriptions')
    .select('*, package:pt_packages(commission_type, commission_value)')
    .eq('id', body.subscription_id)
    .eq('gym_id', gymId)
    .maybeSingle();

  const check = canLogSession(sub);
  if (!check.ok) return res.status(400).json({ success: false, message: check.reason });

  const { data: session, error } = await supabase.from('pt_sessions').insert({
    gym_id: gymId,
    subscription_id: sub.id,
    member_id: sub.member_id,
    staff_id: sub.staff_id,
    session_date: body.session_date || new Date().toISOString().slice(0, 10),
    duration_min: body.duration_min ?? null,
    note: body.note || null,
  }).select().single();

  if (error) throw error;

  // Decrement the balance. The CHECK constraint on the table is the real
  // guard against overrun — this recount just keeps the column honest.
  const nextUsed = (Number(sub.sessions_used) || 0) + 1;
  const updated = { ...sub, sessions_used: nextUsed };
  const { data: newSub, error: subErr } = await supabase
    .from('pt_subscriptions')
    .update({ sessions_used: nextUsed, status: deriveSubscriptionStatus(updated) })
    .eq('id', sub.id)
    .select()
    .single();

  if (subErr) {
    // Do not leave a session logged against a balance that never moved.
    await supabase.from('pt_sessions').delete().eq('id', session.id);
    throw subErr;
  }

  // Flat packages pay per session.
  const perSession = commissionOnSession(sub.package || {});
  if (perSession > 0) {
    await supabase.from('trainer_commissions').insert({
      gym_id: gymId,
      staff_id: sub.staff_id,
      member_id: sub.member_id,
      subscription_id: sub.id,
      session_id: session.id,
      amount: perSession,
      source: 'session',
      status: 'pending',
      note: `Session on ${session.session_date}`,
    });
  }

  res.status(201).json({
    success: true,
    data: { ...session, subscription: { ...newSub, sessions_remaining: sessionsRemaining(newSub) } },
    message: `Session logged. ${sessionsRemaining(newSub)} remaining.`,
  });
});

router.delete('/sessions/:id', async (req, res) => {
  const gymId = gymOf(req);
  const { data: session } = await supabase
    .from('pt_sessions').select('*').eq('id', req.params.id).eq('gym_id', gymId).maybeSingle();
  if (!session) return res.status(404).json({ success: false, message: 'Session not found.' });

  const { data: sub } = await supabase
    .from('pt_subscriptions').select('*').eq('id', session.subscription_id).maybeSingle();

  await supabase.from('pt_sessions').delete().eq('id', req.params.id);

  // Give the session back and drop the commission it generated.
  if (sub) {
    const nextUsed = Math.max(0, (Number(sub.sessions_used) || 0) - 1);
    const updated = { ...sub, sessions_used: nextUsed };
    await supabase
      .from('pt_subscriptions')
      .update({ sessions_used: nextUsed, status: deriveSubscriptionStatus(updated) })
      .eq('id', sub.id);
  }

  // Only unpaid commission is removed; a settled payout is not clawed back here.
  await supabase
    .from('trainer_commissions')
    .delete()
    .eq('session_id', req.params.id)
    .eq('status', 'pending');

  res.json({ success: true, message: 'Session removed.' });
});

// ════════════════════════════════════════════════════
// COMMISSION
// ════════════════════════════════════════════════════

router.get('/commissions', async (req, res) => {
  let query = supabase
    .from('trainer_commissions')
    .select('*, staff:staff(id, name), member:members(id, name)')
    .eq('gym_id', gymOf(req));

  if (req.query.staff_id) query = query.eq('staff_id', req.query.staff_id);
  if (req.query.status) query = query.eq('status', req.query.status);
  if (req.query.from) query = query.gte('earned_at', req.query.from);
  if (req.query.to) query = query.lte('earned_at', req.query.to);

  const { data, error } = await query.order('earned_at', { ascending: false }).limit(500);
  if (error) throw error;

  const rows = data || [];
  const sum = (s) => rows.filter((r) => r.status === s).reduce((a, r) => a + Number(r.amount || 0), 0);

  res.json({
    success: true,
    data: rows,
    totals: { pending: sum('pending'), paid: sum('paid') },
  });
});

/**
 * POST /api/trainers/:staffId/payout
 *
 * Settle pending commission into staff_payments, so trainer earnings show up in
 * the same profit-and-loss the owner already reads for salaries.
 */
router.post('/:staffId/payout', async (req, res) => {
  const gymId = gymOf(req);
  const { staffId } = req.params;
  const schema = z.object({
    commission_ids: z.array(z.string().uuid()).optional(),
    paid_date: z.string().optional(),
    note: z.string().max(300).optional(),
  });
  const body = schema.parse(req.body ?? {});

  const { data: staff } = await supabase
    .from('staff').select('id, name').eq('id', staffId).eq('gym_id', gymId).maybeSingle();
  if (!staff) return res.status(404).json({ success: false, message: 'Trainer not found.' });

  let pendingQuery = supabase
    .from('trainer_commissions')
    .select('id, amount')
    .eq('gym_id', gymId)
    .eq('staff_id', staffId)
    .eq('status', 'pending');

  if (body.commission_ids?.length) pendingQuery = pendingQuery.in('id', body.commission_ids);

  const { data: pending } = await pendingQuery;
  if (!pending?.length) {
    return res.status(400).json({ success: false, message: 'No pending commission to pay out.' });
  }

  const total = pending.reduce((s, c) => s + Number(c.amount || 0), 0);
  const paidDate = body.paid_date || new Date().toISOString().slice(0, 10);
  const when = new Date(paidDate);

  const { data: payment, error: payErr } = await supabase.from('staff_payments').insert({
    gym_id: gymId,
    staff_id: staffId,
    amount_paid: total,
    month: when.getMonth() + 1,
    year: when.getFullYear(),
    paid_date: paidDate,
    kind: 'commission',
    notes: body.note || `Commission payout — ${pending.length} item${pending.length === 1 ? '' : 's'}`,
  }).select().single();

  if (payErr) throw payErr;

  const { error: markErr } = await supabase
    .from('trainer_commissions')
    .update({ status: 'paid', settled_at: new Date().toISOString(), staff_payment_id: payment.id })
    .in('id', pending.map((c) => c.id));

  if (markErr) {
    // Never leave money recorded as paid out while the accruals still read
    // pending — that would let the same commission be paid twice.
    await supabase.from('staff_payments').delete().eq('id', payment.id);
    throw markErr;
  }

  res.status(201).json({
    success: true,
    data: { payment, settled: pending.length, total },
    message: `${staff.name} paid out.`,
  });
});

/** GET /api/trainers — trainers with their live workload and earnings. */
router.get('/', async (req, res) => {
  const gymId = gymOf(req);

  const [staffRes, assignRes, commRes, subsRes] = await Promise.all([
    supabase.from('staff').select('*').eq('gym_id', gymId).eq('role', 'trainer').order('name'),
    supabase.from('trainer_assignments').select('staff_id').eq('gym_id', gymId).is('ended_at', null),
    supabase.from('trainer_commissions').select('staff_id, amount, status').eq('gym_id', gymId),
    supabase.from('pt_subscriptions').select('staff_id, status').eq('gym_id', gymId).eq('status', 'active'),
  ]);

  if (staffRes.error) throw staffRes.error;

  const countBy = (rows, key) =>
    (rows || []).reduce((acc, r) => ({ ...acc, [r[key]]: (acc[r[key]] || 0) + 1 }), {});

  const members = countBy(assignRes.data, 'staff_id');
  const activePackages = countBy(subsRes.data, 'staff_id');

  const earnings = (commRes.data || []).reduce((acc, c) => {
    const bucket = acc[c.staff_id] || { pending: 0, paid: 0 };
    if (c.status === 'pending') bucket.pending += Number(c.amount || 0);
    if (c.status === 'paid') bucket.paid += Number(c.amount || 0);
    acc[c.staff_id] = bucket;
    return acc;
  }, {});

  res.json({
    success: true,
    data: (staffRes.data || []).map((t) => ({
      ...t,
      member_count: members[t.id] || 0,
      active_packages: activePackages[t.id] || 0,
      commission_pending: earnings[t.id]?.pending || 0,
      commission_paid: earnings[t.id]?.paid || 0,
    })),
  });
});

module.exports = router;
