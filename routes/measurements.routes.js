const express = require('express');
const { z } = require('zod');
const { supabase } = require('../db/supabase');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

const gymOf = (req) => req.user.gym_id;

// Every field is optional: a gym that only records weight should not be forced
// to fill in eight circumferences.
const measurementSchema = z.object({
  member_id: z.string().uuid(),
  recorded_on: z.string().optional(),
  weight_kg: z.coerce.number().min(20).max(400).nullable().optional(),
  height_cm: z.coerce.number().min(50).max(260).nullable().optional(),
  body_fat_pct: z.coerce.number().min(1).max(70).nullable().optional(),
  muscle_mass_kg: z.coerce.number().min(1).max(200).nullable().optional(),
  chest_cm: z.coerce.number().min(20).max(250).nullable().optional(),
  waist_cm: z.coerce.number().min(20).max(250).nullable().optional(),
  hips_cm: z.coerce.number().min(20).max(250).nullable().optional(),
  arm_cm: z.coerce.number().min(10).max(100).nullable().optional(),
  thigh_cm: z.coerce.number().min(10).max(150).nullable().optional(),
  note: z.string().max(400).optional().or(z.literal('')),
});

/** BMI, when both numbers are present. Derived rather than stored so it cannot drift. */
function bmi(weightKg, heightCm) {
  if (!weightKg || !heightCm) return null;
  const m = Number(heightCm) / 100;
  if (m <= 0) return null;
  return Math.round((Number(weightKg) / (m * m)) * 10) / 10;
}

function bmiBand(value) {
  if (value === null) return null;
  if (value < 18.5) return 'underweight';
  if (value < 25) return 'healthy';
  if (value < 30) return 'overweight';
  return 'obese';
}

const decorate = (row, fallbackHeight) => {
  const height = row.height_cm ?? fallbackHeight;
  const value = bmi(row.weight_kg, height);
  return { ...row, bmi: value, bmi_band: bmiBand(value) };
};

// ── GET /api/measurements?member_id= ──────
router.get('/', async (req, res) => {
  const { member_id: memberId } = req.query;
  if (!memberId) return res.status(400).json({ success: false, message: 'member_id is required.' });

  const { data, error } = await supabase
    .from('member_measurements')
    .select('*')
    .eq('member_id', memberId)
    .eq('gym_id', gymOf(req))
    .order('recorded_on', { ascending: true });
  if (error) throw error;

  const rows = data || [];

  // Height is usually recorded once and left blank afterwards; carry the most
  // recent known value forward so BMI keeps working on later entries.
  const lastKnownHeight = [...rows].reverse().find((r) => r.height_cm)?.height_cm ?? null;
  const decorated = rows.map((r) => decorate(r, lastKnownHeight));

  const first = decorated[0];
  const latest = decorated[decorated.length - 1];

  const change = (key) =>
    first && latest && first[key] != null && latest[key] != null
      ? Math.round((latest[key] - first[key]) * 10) / 10
      : null;

  res.json({
    success: true,
    data: decorated,
    stats: latest
      ? {
        entries: decorated.length,
        latest,
        since_first: {
          weight_kg: change('weight_kg'),
          body_fat_pct: change('body_fat_pct'),
          waist_cm: change('waist_cm'),
          muscle_mass_kg: change('muscle_mass_kg'),
        },
      }
      : null,
  });
});

// ── POST /api/measurements ────────────────
router.post('/', async (req, res) => {
  const body = measurementSchema.parse(req.body);
  const gymId = gymOf(req);

  const { data: member } = await supabase
    .from('members').select('id, name').eq('id', body.member_id).eq('gym_id', gymId).maybeSingle();
  if (!member) return res.status(404).json({ success: false, message: 'Member not found.' });

  const row = {
    ...body,
    gym_id: gymId,
    recorded_on: body.recorded_on || new Date().toISOString().slice(0, 10),
    recorded_by: req.user?.email || null,
  };

  // One entry per member per day. Re-recording the same day is a correction, so
  // update in place rather than adding a second point that makes the chart
  // zig-zag between two readings taken minutes apart.
  const { data, error } = await supabase
    .from('member_measurements')
    .upsert(row, { onConflict: 'member_id,recorded_on' })
    .select().single();
  if (error) throw error;

  res.status(201).json({ success: true, data: decorate(data), message: 'Measurement saved.' });
});

router.delete('/:id', async (req, res) => {
  const { error } = await supabase
    .from('member_measurements').delete()
    .eq('id', req.params.id).eq('gym_id', gymOf(req));
  if (error) throw error;
  res.json({ success: true, message: 'Measurement removed.' });
});

module.exports = router;
