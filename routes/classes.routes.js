const express = require('express');
const { z } = require('zod');
const { supabase } = require('../db/supabase');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

const gymOf = (req) => req.user.gym_id;

// ════════════════════════════════════════════════════
// TEMPLATES
// ════════════════════════════════════════════════════

const templateSchema = z.object({
  name: z.string().min(2).max(80),
  description: z.string().max(400).optional().or(z.literal('')),
  staff_id: z.string().uuid().nullable().optional(),
  capacity: z.coerce.number().int().min(1).max(500).default(20),
  duration_min: z.coerce.number().int().min(5).max(480).default(60),
  weekdays: z.array(z.coerce.number().int().min(0).max(6)).default([]),
  start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).default('07:00'),
  color: z.string().max(20).default('accent'),
  is_active: z.boolean().default(true),
});

router.get('/templates', async (req, res) => {
  const { data, error } = await supabase
    .from('class_templates')
    .select('*, staff:staff(id, name)')
    .eq('gym_id', gymOf(req))
    .order('start_time');
  if (error) throw error;
  res.json({ success: true, data });
});

router.post('/templates', async (req, res) => {
  const body = templateSchema.parse(req.body);
  const { data, error } = await supabase
    .from('class_templates')
    .insert({ ...body, gym_id: gymOf(req) })
    .select('*, staff:staff(id, name)')
    .single();
  if (error) throw error;
  res.status(201).json({ success: true, data, message: 'Class created.' });
});

router.patch('/templates/:id', async (req, res) => {
  const body = templateSchema.partial().parse(req.body);
  const { data, error } = await supabase
    .from('class_templates')
    .update({ ...body, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('gym_id', gymOf(req))
    .select('*, staff:staff(id, name)').single();
  if (error) throw error;
  if (!data) return res.status(404).json({ success: false, message: 'Class not found.' });
  res.json({ success: true, data, message: 'Class updated.' });
});

router.delete('/templates/:id', async (req, res) => {
  const { count } = await supabase
    .from('class_sessions')
    .select('id', { count: 'exact', head: true })
    .eq('template_id', req.params.id)
    .gte('starts_at', new Date().toISOString());

  if (count > 0) {
    // Future occurrences exist and may already have bookings. Deactivating
    // stops new ones being generated without erasing what members booked.
    const { data } = await supabase
      .from('class_templates').update({ is_active: false })
      .eq('id', req.params.id).eq('gym_id', gymOf(req)).select().single();
    return res.json({
      success: true, data,
      message: `${count} upcoming session${count === 1 ? '' : 's'} already scheduled, so the class was deactivated instead of deleted.`,
    });
  }

  const { error } = await supabase
    .from('class_templates').delete().eq('id', req.params.id).eq('gym_id', gymOf(req));
  if (error) throw error;
  res.json({ success: true, message: 'Class deleted.' });
});

// ════════════════════════════════════════════════════
// SESSIONS
// ════════════════════════════════════════════════════

/**
 * Materialise occurrences for the next `days` from every active template.
 *
 * Occurrences are rows, not a computed view, because each one carries its own
 * bookings, attendance and cancellation. The unique index on
 * (template_id, starts_at) makes this safe to call repeatedly.
 */
router.post('/sessions/generate', async (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.body?.days) || 28));
  const gymId = gymOf(req);

  const { data: templates } = await supabase
    .from('class_templates').select('*').eq('gym_id', gymId).eq('is_active', true);

  if (!templates?.length) {
    return res.json({ success: true, data: { created: 0 }, message: 'No active classes to schedule.' });
  }

  const rows = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let offset = 0; offset < days; offset += 1) {
    const day = new Date(today);
    day.setDate(day.getDate() + offset);

    for (const t of templates) {
      if (!t.weekdays?.includes(day.getDay())) continue;

      const [h, m] = String(t.start_time).split(':').map(Number);
      const startsAt = new Date(day);
      startsAt.setHours(h, m || 0, 0, 0);

      // Skip slots that have already passed today.
      if (startsAt < new Date()) continue;

      rows.push({
        gym_id: gymId,
        template_id: t.id,
        name: t.name,
        staff_id: t.staff_id,
        starts_at: startsAt.toISOString(),
        duration_min: t.duration_min,
        capacity: t.capacity,
        status: 'scheduled',
      });
    }
  }

  if (!rows.length) {
    return res.json({ success: true, data: { created: 0 }, message: 'Nothing new to schedule.' });
  }

  // Filter against what already exists rather than relying on ON CONFLICT.
  // Postgres refuses to match ON CONFLICT to a partial unique index, and
  // PostgREST cannot send the index predicate, so an upsert here failed
  // outright. Reading first also keeps this working on databases where
  // migration 007 has not been applied yet.
  const { data: existing } = await supabase
    .from('class_sessions')
    .select('template_id, starts_at')
    .eq('gym_id', gymId)
    .gte('starts_at', new Date().toISOString());

  const taken = new Set(
    (existing || []).map((e) => `${e.template_id}|${new Date(e.starts_at).getTime()}`)
  );

  const fresh = rows.filter(
    (r) => !taken.has(`${r.template_id}|${new Date(r.starts_at).getTime()}`)
  );

  if (!fresh.length) {
    return res.json({ success: true, data: { created: 0 }, message: 'Already up to date.' });
  }

  const { data, error } = await supabase.from('class_sessions').insert(fresh).select('id');
  if (error) throw error;

  const created = (data || []).length;
  res.json({
    success: true,
    data: { created },
    message: created ? `${created} session${created === 1 ? '' : 's'} scheduled.` : 'Already up to date.',
  });
});

router.get('/sessions', async (req, res) => {
  const from = req.query.from || new Date().toISOString().slice(0, 10);
  const to = req.query.to;

  let query = supabase
    .from('class_sessions')
    .select('*, staff:staff(id, name), bookings:class_bookings(id, status, member_id)')
    .eq('gym_id', gymOf(req))
    .gte('starts_at', `${from}T00:00:00.000Z`);

  if (to) query = query.lte('starts_at', `${to}T23:59:59.999Z`);
  if (req.query.staff_id) query = query.eq('staff_id', req.query.staff_id);

  const { data, error } = await query.order('starts_at').limit(500);
  if (error) throw error;

  res.json({
    success: true,
    data: (data || []).map((s) => {
      const active = (s.bookings || []).filter((b) => b.status !== 'cancelled');
      const booked = active.filter((b) => b.status !== 'waitlisted').length;
      return {
        ...s,
        booked_count: booked,
        waitlist_count: active.length - booked,
        spots_left: Math.max(0, s.capacity - booked),
      };
    }),
  });
});

router.patch('/sessions/:id', async (req, res) => {
  const schema = z.object({
    status: z.enum(['scheduled', 'cancelled', 'completed']).optional(),
    staff_id: z.string().uuid().nullable().optional(),
    capacity: z.coerce.number().int().min(1).optional(),
    note: z.string().max(300).optional(),
  });
  const body = schema.parse(req.body);

  const { data, error } = await supabase
    .from('class_sessions').update(body)
    .eq('id', req.params.id).eq('gym_id', gymOf(req)).select().single();
  if (error) throw error;
  if (!data) return res.status(404).json({ success: false, message: 'Session not found.' });

  // Cancelling the class cancels its bookings — leaving them "booked" against a
  // cancelled session would show members a class that is not happening.
  if (body.status === 'cancelled') {
    await supabase.from('class_bookings')
      .update({ status: 'cancelled' })
      .eq('session_id', req.params.id)
      .in('status', ['booked', 'waitlisted']);
  }

  res.json({ success: true, data, message: 'Session updated.' });
});

// ════════════════════════════════════════════════════
// BOOKINGS
// ════════════════════════════════════════════════════

/** Move the first waitlisted member into a freed spot. */
async function promoteFromWaitlist(sessionId) {
  const { data: next } = await supabase
    .from('class_bookings')
    .select('id, member_id')
    .eq('session_id', sessionId)
    .eq('status', 'waitlisted')
    .order('waitlist_pos', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!next) return null;

  await supabase.from('class_bookings')
    .update({ status: 'booked', waitlist_pos: null })
    .eq('id', next.id);

  return next.member_id;
}

router.post('/sessions/:id/book', async (req, res) => {
  const { member_id: memberId } = req.body || {};
  if (!memberId) return res.status(400).json({ success: false, message: 'member_id is required.' });

  const gymId = gymOf(req);

  const [{ data: session }, { data: member }] = await Promise.all([
    supabase.from('class_sessions').select('*').eq('id', req.params.id).eq('gym_id', gymId).maybeSingle(),
    supabase.from('members').select('id, name').eq('id', memberId).eq('gym_id', gymId).maybeSingle(),
  ]);

  if (!session) return res.status(404).json({ success: false, message: 'Session not found.' });
  if (!member) return res.status(404).json({ success: false, message: 'Member not found.' });
  if (session.status !== 'scheduled') {
    return res.status(400).json({ success: false, message: 'That class is not open for booking.' });
  }
  if (new Date(session.starts_at) < new Date()) {
    return res.status(400).json({ success: false, message: 'That class has already started.' });
  }

  const { data: existing } = await supabase
    .from('class_bookings')
    .select('id, status')
    .eq('session_id', session.id)
    .neq('status', 'cancelled');

  if ((existing || []).some((b) => b.member_id === memberId)) {
    return res.status(409).json({ success: false, message: `${member.name} is already booked.` });
  }

  const booked = (existing || []).filter((b) => b.status !== 'waitlisted').length;
  const full = booked >= session.capacity;
  const waitlisted = (existing || []).filter((b) => b.status === 'waitlisted').length;

  const { data, error } = await supabase.from('class_bookings').insert({
    gym_id: gymId,
    session_id: session.id,
    member_id: memberId,
    status: full ? 'waitlisted' : 'booked',
    waitlist_pos: full ? waitlisted + 1 : null,
  }).select().single();

  // 23505 = uniq_active_booking. Two rapid taps race past the check above; the
  // index is what actually prevents the double booking.
  if (error?.code === '23505') {
    return res.status(409).json({ success: false, message: `${member.name} is already booked.` });
  }
  if (error) throw error;

  res.status(201).json({
    success: true,
    data,
    message: full
      ? `Class is full — ${member.name} is number ${waitlisted + 1} on the waitlist.`
      : `${member.name} booked.`,
  });
});

router.post('/bookings/:id/cancel', async (req, res) => {
  const gymId = gymOf(req);
  const { data: booking } = await supabase
    .from('class_bookings').select('*').eq('id', req.params.id).eq('gym_id', gymId).maybeSingle();
  if (!booking) return res.status(404).json({ success: false, message: 'Booking not found.' });

  await supabase.from('class_bookings')
    .update({ status: 'cancelled', waitlist_pos: null }).eq('id', req.params.id);

  // A confirmed cancellation frees a spot; a waitlist cancellation does not.
  let promoted = null;
  if (booking.status === 'booked') promoted = await promoteFromWaitlist(booking.session_id);

  res.json({
    success: true,
    data: { promoted_member_id: promoted },
    message: promoted ? 'Cancelled — the next person on the waitlist has a spot.' : 'Booking cancelled.',
  });
});

router.post('/bookings/:id/attend', async (req, res) => {
  const attended = req.body?.attended !== false;
  const { data, error } = await supabase
    .from('class_bookings')
    .update({
      status: attended ? 'attended' : 'no_show',
      attended_at: attended ? new Date().toISOString() : null,
    })
    .eq('id', req.params.id).eq('gym_id', gymOf(req)).select().single();
  if (error) throw error;
  if (!data) return res.status(404).json({ success: false, message: 'Booking not found.' });
  res.json({ success: true, data, message: attended ? 'Marked present.' : 'Marked absent.' });
});

router.get('/sessions/:id/bookings', async (req, res) => {
  const { data, error } = await supabase
    .from('class_bookings')
    .select('*, member:members(id, name, phone)')
    .eq('session_id', req.params.id)
    .eq('gym_id', gymOf(req))
    .neq('status', 'cancelled')
    .order('waitlist_pos', { ascending: true, nullsFirst: true });
  if (error) throw error;
  res.json({ success: true, data });
});

module.exports = router;
