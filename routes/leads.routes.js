const express = require('express');
const { z } = require('zod');
const { supabase } = require('../db/supabase');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

const gymOf = (req) => req.user.gym_id;

const leadSchema = z.object({
  name: z.string().min(2).max(100),
  phone: z.string().max(30).optional().or(z.literal('')),
  email: z.string().email().optional().or(z.literal('')),
  source: z.enum(['walk_in', 'referral', 'social', 'website', 'phone', 'other']).default('walk_in'),
  status: z.enum(['new', 'contacted', 'trial_booked', 'negotiating', 'converted', 'lost']).default('new'),
  interest: z.string().max(200).optional().or(z.literal('')),
  assigned_to: z.string().uuid().nullable().optional(),
  follow_up_at: z.string().optional().nullable(),
  notes: z.string().max(1000).optional().or(z.literal('')),
  lost_reason: z.string().max(200).optional().or(z.literal('')),
});

/** Activity rows are the history; never let a failed write lose the lead update. */
async function logActivity(gymId, leadId, kind, body, actor) {
  try {
    await supabase.from('lead_activities').insert({
      gym_id: gymId, lead_id: leadId, kind, body, actor: actor || null,
    });
  } catch (err) {
    console.error('[leads] could not record activity:', err.message);
  }
}

// ── GET /api/leads ────────────────────────
router.get('/', async (req, res) => {
  let query = supabase
    .from('leads')
    .select('*, assignee:staff(id, name)')
    .eq('gym_id', gymOf(req));

  if (req.query.status) query = query.eq('status', req.query.status);
  if (req.query.source) query = query.eq('source', req.query.source);
  if (req.query.search) {
    const s = req.query.search;
    query = query.or(`name.ilike.%${s}%,phone.ilike.%${s}%,email.ilike.%${s}%`);
  }
  // "Who do I call today" — everything due on or before today, still open.
  if (req.query.due === 'true') {
    query = query
      .lte('follow_up_at', new Date().toISOString().slice(0, 10))
      .not('status', 'in', '("converted","lost")');
  }

  const { data, error } = await query.order('created_at', { ascending: false }).limit(500);
  if (error) throw error;

  const rows = data || [];
  const today = new Date().toISOString().slice(0, 10);

  res.json({
    success: true,
    data: rows,
    stats: {
      total: rows.length,
      open: rows.filter((l) => !['converted', 'lost'].includes(l.status)).length,
      converted: rows.filter((l) => l.status === 'converted').length,
      due_today: rows.filter(
        (l) => l.follow_up_at && l.follow_up_at <= today && !['converted', 'lost'].includes(l.status)
      ).length,
    },
  });
});

router.get('/:id', async (req, res) => {
  const gymId = gymOf(req);
  const [{ data: lead }, { data: activities }] = await Promise.all([
    supabase.from('leads').select('*, assignee:staff(id, name)').eq('id', req.params.id).eq('gym_id', gymId).maybeSingle(),
    supabase.from('lead_activities').select('*').eq('lead_id', req.params.id).order('created_at', { ascending: false }),
  ]);

  if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });
  res.json({ success: true, data: { ...lead, activities: activities || [] } });
});

router.post('/', async (req, res) => {
  const body = leadSchema.parse(req.body);
  const gymId = gymOf(req);

  // A duplicate enquiry from the same number is usually a follow-up call, not a
  // new lead — surface the existing one rather than fragmenting the history.
  if (body.phone) {
    const { data: existing } = await supabase
      .from('leads').select('id, name, status')
      .eq('gym_id', gymId).eq('phone', body.phone)
      .not('status', 'in', '("converted","lost")')
      .maybeSingle();

    if (existing) {
      return res.status(409).json({
        success: false,
        data: existing,
        message: `${existing.name} is already an open lead on that number.`,
      });
    }
  }

  const { data, error } = await supabase
    .from('leads')
    .insert({ ...body, gym_id: gymId, follow_up_at: body.follow_up_at || null })
    .select('*, assignee:staff(id, name)')
    .single();
  if (error) throw error;

  await logActivity(gymId, data.id, 'note', `Lead created from ${body.source.replace('_', ' ')}.`, req.user?.email);
  res.status(201).json({ success: true, data, message: 'Lead added.' });
});

router.patch('/:id', async (req, res) => {
  const body = leadSchema.partial().parse(req.body);
  const gymId = gymOf(req);

  const { data: before } = await supabase
    .from('leads').select('status').eq('id', req.params.id).eq('gym_id', gymId).maybeSingle();
  if (!before) return res.status(404).json({ success: false, message: 'Lead not found.' });

  const { data, error } = await supabase
    .from('leads')
    .update({ ...body, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('gym_id', gymId)
    .select('*, assignee:staff(id, name)').single();
  if (error) throw error;

  if (body.status && body.status !== before.status) {
    await logActivity(gymId, data.id, 'status_change', `${before.status} → ${body.status}`, req.user?.email);
  }

  res.json({ success: true, data, message: 'Lead updated.' });
});

router.delete('/:id', async (req, res) => {
  const { error } = await supabase
    .from('leads').delete().eq('id', req.params.id).eq('gym_id', gymOf(req));
  if (error) throw error;
  res.json({ success: true, message: 'Lead deleted.' });
});

// ── POST /api/leads/:id/activities ────────
router.post('/:id/activities', async (req, res) => {
  const schema = z.object({
    kind: z.enum(['note', 'call', 'whatsapp', 'visit', 'status_change']).default('note'),
    body: z.string().min(1).max(1000),
    follow_up_at: z.string().optional().nullable(),
  });
  const input = schema.parse(req.body);
  const gymId = gymOf(req);

  const { data, error } = await supabase.from('lead_activities').insert({
    gym_id: gymId, lead_id: req.params.id,
    kind: input.kind, body: input.body, actor: req.user?.email || null,
  }).select().single();
  if (error) throw error;

  // Logging a call usually comes with "call again on…"; save the round trip.
  const patch = { updated_at: new Date().toISOString() };
  if (input.follow_up_at !== undefined) patch.follow_up_at = input.follow_up_at || null;
  await supabase.from('leads').update(patch).eq('id', req.params.id).eq('gym_id', gymId);

  res.status(201).json({ success: true, data, message: 'Activity logged.' });
});

/**
 * POST /api/leads/:id/convert
 *
 * Turns the lead into a member and links the two, so conversion rate is
 * measurable rather than guessed at.
 */
router.post('/:id/convert', async (req, res) => {
  const gymId = gymOf(req);

  const { data: lead } = await supabase
    .from('leads').select('*').eq('id', req.params.id).eq('gym_id', gymId).maybeSingle();
  if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });
  if (lead.converted_member_id) {
    return res.status(409).json({ success: false, message: 'This lead has already been converted.' });
  }
  if (!lead.phone) {
    return res.status(400).json({ success: false, message: 'Add a phone number before converting.' });
  }

  // Reuse an existing member on the same number rather than creating a second
  // record for the same person.
  const { data: existingMember } = await supabase
    .from('members').select('id, name').eq('gym_id', gymId).eq('phone', lead.phone).maybeSingle();

  let member = existingMember;

  if (!member) {
    const { data: created, error } = await supabase.from('members').insert({
      gym_id: gymId,
      name: lead.name,
      phone: lead.phone,
      join_date: new Date().toISOString().slice(0, 10),
      status: 'active',
      notes: [lead.interest && `Interest: ${lead.interest}`, lead.notes]
        .filter(Boolean).join('\n') || null,
    }).select().single();
    if (error) throw error;
    member = created;
  }

  const { data: updated, error: leadErr } = await supabase.from('leads').update({
    status: 'converted',
    converted_member_id: member.id,
    converted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', lead.id).select().single();
  if (leadErr) throw leadErr;

  await logActivity(gymId, lead.id, 'status_change',
    existingMember ? 'Linked to an existing member.' : 'Converted to a new member.', req.user?.email);

  res.json({
    success: true,
    data: { lead: updated, member },
    message: `${lead.name} is now a member.`,
  });
});

module.exports = router;
