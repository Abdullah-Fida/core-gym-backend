const express = require('express');
const { z } = require('zod');
const { supabase } = require('../db/supabase');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireAdmin);

const planSchema = z.object({
  code: z.string().min(2).max(40).regex(/^[a-z0-9_-]+$/, 'lowercase letters, digits, - and _ only'),
  name: z.string().min(2).max(80),
  description: z.string().max(500).optional().or(z.literal('')),
  price: z.coerce.number().min(0),
  currency: z.string().length(3).default('PKR'),
  billing_period: z.enum(['month', 'year', 'one_time']).default('month'),
  // null means unlimited — distinct from 0, which would mean "no members allowed".
  member_limit: z.coerce.number().int().min(0).nullable().optional(),
  staff_limit: z.coerce.number().int().min(0).nullable().optional(),
  features: z.record(z.boolean()).default({}),
  is_active: z.boolean().default(true),
  sort_order: z.coerce.number().int().default(0),
});

// ── GET /api/admin/plans ──────────────────
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('plans')
    .select('*')
    .order('sort_order', { ascending: true });
  if (error) throw error;

  // Attach how many gyms sit on each plan, so the UI can warn before a delete.
  const { data: counts } = await supabase.from('gyms').select('plan_id');
  const byPlan = (counts || []).reduce((acc, g) => {
    if (g.plan_id) acc[g.plan_id] = (acc[g.plan_id] || 0) + 1;
    return acc;
  }, {});

  res.json({
    success: true,
    data: (data || []).map((p) => ({ ...p, gym_count: byPlan[p.id] || 0 })),
  });
});

// ── POST /api/admin/plans ─────────────────
router.post('/', async (req, res) => {
  const body = planSchema.parse(req.body);

  const { data: existing } = await supabase
    .from('plans')
    .select('id')
    .eq('code', body.code)
    .maybeSingle();
  if (existing) {
    return res.status(409).json({ success: false, message: `A plan with code "${body.code}" already exists.` });
  }

  const { data, error } = await supabase.from('plans').insert(body).select().single();
  if (error) throw error;
  res.status(201).json({ success: true, data, message: 'Plan created.' });
});

// ── PATCH /api/admin/plans/:id ────────────
router.patch('/:id', async (req, res) => {
  // `code` is the stable identifier other rows join on; renaming it would
  // orphan every gym pointing at this plan.
  const body = planSchema.partial().omit({ code: true }).parse(req.body);

  const { data, error } = await supabase
    .from('plans')
    .update({ ...body, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) throw error;
  if (!data) return res.status(404).json({ success: false, message: 'Plan not found.' });

  res.json({ success: true, data, message: 'Plan updated.' });
});

// ── DELETE /api/admin/plans/:id ───────────
router.delete('/:id', async (req, res) => {
  const { count } = await supabase
    .from('gyms')
    .select('id', { count: 'exact', head: true })
    .eq('plan_id', req.params.id);

  if (count > 0) {
    return res.status(409).json({
      success: false,
      message: `${count} gym${count === 1 ? ' is' : 's are'} on this plan. Move them to another plan first, or deactivate this one instead of deleting it.`,
    });
  }

  const { error } = await supabase.from('plans').delete().eq('id', req.params.id);
  if (error) throw error;
  res.json({ success: true, message: 'Plan deleted.' });
});

module.exports = router;
