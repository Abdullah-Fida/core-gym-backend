const express = require('express');
const { supabase } = require('../db/supabase');
const { authenticate, requireGymOwner } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireGymOwner);

const getTodayDate = () => new Date().toISOString().split('T')[0];

const normalizeDate = (value) => {
  if (!value) return null;
  return String(value).split('T')[0];
};

const isFingerprintColumnMissing = (error) => {
  const msg = String(error?.message || '').toLowerCase();
  return error?.code === '42703' || (msg.includes('fingerprint_id') && msg.includes('column'));
};

const fingerprintFromNotes = (notes) => {
  const match = String(notes || '').match(/(?:^|;)fingerprint_id:([^;]+)/i);
  return match ? String(match[1]).trim() : null;
};

const withFingerprint = (member) => {
  if (!member) return null;
  return {
    ...member,
    fingerprint_id: member.fingerprint_id || fingerprintFromNotes(member.notes),
  };
};

const injectFingerprintIntoNotes = (notes, fingerprintId) => {
  const value = String(fingerprintId || '').trim();
  const source = String(notes || '');
  if (!value) return source;

  if (/(^|;)fingerprint_id:[^;]*;?/i.test(source)) {
    return source.replace(/(^|;)fingerprint_id:[^;]*;?/i, `$1fingerprint_id:${value};`);
  }

  return source ? `fingerprint_id:${value};${source}` : `fingerprint_id:${value};`;
};

async function findFingerprintConflict(gymId, fingerprintId, memberId) {
  const direct = await supabase
    .from('members')
    .select('id, name, notes, fingerprint_id')
    .eq('gym_id', gymId)
    .eq('fingerprint_id', fingerprintId)
    .neq('id', memberId)
    .maybeSingle();

  if (!direct.error) return withFingerprint(direct.data);
  if (!isFingerprintColumnMissing(direct.error)) throw direct.error;

  const fallback = await supabase
    .from('members')
    .select('id, name, notes')
    .eq('gym_id', gymId)
    .neq('id', memberId);

  if (fallback.error) throw fallback.error;

  const found = (fallback.data || []).find((m) => fingerprintFromNotes(m.notes) === fingerprintId);
  return withFingerprint(found || null);
}

async function assignFingerprintToMember(gymId, memberId, fingerprintId) {
  const direct = await supabase
    .from('members')
    .update({ fingerprint_id: fingerprintId })
    .eq('id', memberId)
    .eq('gym_id', gymId)
    .select('id, name, phone, status, latest_expiry, notes, fingerprint_id')
    .single();

  if (!direct.error) return withFingerprint(direct.data);
  if (!isFingerprintColumnMissing(direct.error)) throw direct.error;

  const current = await supabase
    .from('members')
    .select('id, name, phone, status, latest_expiry, notes')
    .eq('id', memberId)
    .eq('gym_id', gymId)
    .maybeSingle();

  if (current.error) throw current.error;
  if (!current.data) return null;

  const mergedNotes = injectFingerprintIntoNotes(current.data.notes, fingerprintId);

  const fallbackUpdate = await supabase
    .from('members')
    .update({ notes: mergedNotes })
    .eq('id', memberId)
    .eq('gym_id', gymId)
    .select('id, name, phone, status, latest_expiry, notes')
    .single();

  if (fallbackUpdate.error) throw fallbackUpdate.error;
  return withFingerprint(fallbackUpdate.data);
}

async function findMemberByFingerprint(gymId, fingerprintId) {
  const direct = await supabase
    .from('members')
    .select('id, name, phone, status, latest_expiry, notes, fingerprint_id')
    .eq('gym_id', gymId)
    .eq('fingerprint_id', fingerprintId)
    .maybeSingle();

  if (!direct.error) return withFingerprint(direct.data);
  if (!isFingerprintColumnMissing(direct.error)) throw direct.error;

  const fallback = await supabase
    .from('members')
    .select('id, name, phone, status, latest_expiry, notes')
    .eq('gym_id', gymId);

  if (fallback.error) throw fallback.error;

  const found = (fallback.data || []).find((m) => fingerprintFromNotes(m.notes) === fingerprintId);
  return withFingerprint(found || null);
}

function evaluateMemberAccess(member, todayDate) {
  const expiry = normalizeDate(member.latest_expiry);
  const isTrial = member.status === 'trial';

  if (!expiry) {
    return {
      granted: false,
      reason: isTrial ? 'trial_finished' : 'fee_expired',
      message: isTrial
        ? 'Trial is not active. Please renew trial or add membership.'
        : 'Membership fee is not active. Access denied.',
      expiry: null,
    };
  }

  if (expiry < todayDate) {
    return {
      granted: false,
      reason: isTrial ? 'trial_finished' : 'fee_expired',
      message: isTrial
        ? `Trial expired on ${expiry}. Access denied.`
        : `Membership expired on ${expiry}. Access denied.`,
      expiry,
    };
  }

  return {
    granted: true,
    reason: 'active',
    message: 'Access granted',
    expiry,
  };
}

// ── POST /api/attendance/fingerprint/enroll ─────────────
router.post('/fingerprint/enroll', async (req, res) => {
  const member_id = String(req.body.member_id || '').trim();
  const fingerprint_id = String(req.body.fingerprint_id || '').trim();

  if (!member_id || !fingerprint_id) {
    return res.status(400).json({ success: false, message: 'member_id and fingerprint_id are required' });
  }

  const { data: member, error: memberError } = await supabase
    .from('members')
    .select('id, name')
    .eq('id', member_id)
    .eq('gym_id', req.user.gym_id)
    .maybeSingle();

  if (memberError) throw memberError;
  if (!member) {
    return res.status(404).json({ success: false, message: 'Member not found' });
  }

  const conflict = await findFingerprintConflict(req.user.gym_id, fingerprint_id, member_id);
  if (conflict) {
    return res.status(409).json({
      success: false,
      message: `Fingerprint ID already linked with ${conflict.name}`,
    });
  }

  const data = await assignFingerprintToMember(req.user.gym_id, member_id, fingerprint_id);
  if (!data) return res.status(404).json({ success: false, message: 'Member not found' });

  res.json({
    success: true,
    message: `Fingerprint linked for ${data.name}`,
    data,
  });
});

// ── POST /api/attendance/fingerprint/scan ───────────────
router.post('/fingerprint/scan', async (req, res) => {
  const fingerprint_id = String(req.body.fingerprint_id || '').trim();
  if (!fingerprint_id) {
    return res.status(400).json({ success: false, message: 'fingerprint_id is required' });
  }

  const scanTime = req.body.scan_time ? new Date(req.body.scan_time).toISOString() : new Date().toISOString();
  const today = normalizeDate(scanTime);

  const member = await findMemberByFingerprint(req.user.gym_id, fingerprint_id);

  if (!member) {
    return res.status(200).json({
      success: true,
      access: 'denied',
      reason: 'fingerprint_not_registered',
      message: 'Fingerprint not recognized. Access denied.',
    });
  }

  const access = evaluateMemberAccess(member, today);
  if (!access.granted) {
    return res.status(200).json({
      success: true,
      access: 'denied',
      reason: access.reason,
      message: access.message,
      member,
    });
  }

  const { data: existing, error: existingError } = await supabase
    .from('attendance')
    .select('id, member_id, check_in_time, date')
    .eq('member_id', member.id)
    .eq('date', today)
    .eq('gym_id', req.user.gym_id)
    .maybeSingle();

  if (existingError) throw existingError;

  if (existing) {
    return res.json({
      success: true,
      access: 'granted',
      already: true,
      message: `${member.name} already checked in today`,
      member,
      data: existing,
    });
  }

  const { data, error } = await supabase
    .from('attendance')
    .insert({
      member_id: member.id,
      date: today,
      gym_id: req.user.gym_id,
      check_in_time: scanTime,
    })
    .select('id, member_id, check_in_time, date')
    .single();

  if (error) throw error;

  res.status(201).json({
    success: true,
    access: 'granted',
    message: `Access granted. Welcome ${member.name}!`,
    member,
    data,
  });
});

// ── POST /api/attendance/mark ─────────────
router.post('/mark', async (req, res) => {
  const member_id = String(req.body.member_id || '').trim();
  const date = normalizeDate(req.body.date) || getTodayDate();
  const check_in_time = req.body.check_in_time ? new Date(req.body.check_in_time).toISOString() : new Date().toISOString();

  if (!member_id) return res.status(400).json({ success: false, message: 'member_id is required' });

  const { data: member, error: memberError } = await supabase
    .from('members')
    .select('id, name, phone, status, latest_expiry, notes')
    .eq('id', member_id)
    .eq('gym_id', req.user.gym_id)
    .maybeSingle();

  if (memberError) throw memberError;
  if (!member) return res.status(404).json({ success: false, message: 'Member not found' });

  const normalizedMember = withFingerprint(member);

  // Check if already marked
  const { data: existing } = await supabase
    .from('attendance')
    .select('id, member_id, check_in_time, date')
    .eq('member_id', member_id)
    .eq('date', date)
    .eq('gym_id', req.user.gym_id)
    .maybeSingle();
  if (existing) {
    return res.json({ success: true, message: 'Already marked', already: true, data: existing, member: normalizedMember });
  }

  const { data, error } = await supabase
    .from('attendance')
    .insert({ member_id, date, gym_id: req.user.gym_id, check_in_time })
    .select('id, member_id, check_in_time, date')
    .single();

  if (error) throw error;
  res.status(201).json({ success: true, message: 'Attendance marked manually', data, member: normalizedMember });
});

// ── DELETE /api/attendance/unmark ─────────
router.delete('/unmark', async (req, res) => {
  const { member_id, date } = req.body;
  const { error } = await supabase.from('attendance').delete().eq('member_id', member_id).eq('date', date).eq('gym_id', req.user.gym_id);
  if (error) throw error;
  res.json({ success: true, message: 'Attendance unmarked' });
});

// ── GET /api/attendance/today ─────────────
router.get('/today', async (req, res) => {
  const today = getTodayDate();
  const { data, error } = await supabase
    .from('attendance')
    .select('id, member_id, check_in_time, date, members(id, name, phone, status, latest_expiry, notes)')
    .eq('gym_id', req.user.gym_id)
    .eq('date', today)
    .order('check_in_time', { ascending: false });

  if (error) throw error;
  const normalized = (data || []).map((row) => ({
    ...row,
    members: withFingerprint(row.members),
  }));
  res.json({ success: true, data: normalized, date: today, count: normalized.length });
});

// ── GET /api/attendance/report ────────────
router.get('/report', async (req, res) => {
  const { month, year } = req.query;
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const end = new Date(year, month, 0).toISOString().split('T')[0];

  const { data, error } = await supabase.from('attendance').select('date, member_id').eq('gym_id', req.user.gym_id).gte('date', start).lte('date', end);
  if (error) throw error;

  // Group by date
  const byDate = {};
  data.forEach(a => { byDate[a.date] = (byDate[a.date] || 0) + 1; });
  res.json({ success: true, data: byDate, total: data.length });
});

// ── POST /api/attendance/staff ────────────
router.post('/staff', async (req, res) => {
  const { staff_id, date, status } = req.body;
  const validStatuses = ['present', 'absent', 'half_day', 'leave'];
  if (!validStatuses.includes(status)) return res.status(400).json({ success: false, message: 'Invalid status' });

  // Upsert
  const { data, error } = await supabase.from('staff_attendance').upsert({ staff_id, date, status, gym_id: req.user.gym_id }, { onConflict: 'staff_id,date' }).select().single();
  if (error) throw error;
  res.json({ success: true, data });
});

// ── GET /api/attendance/staff/today ───────
router.get('/staff/today', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const { data, error } = await supabase.from('staff_attendance').select('*, staff(name, role)').eq('gym_id', req.user.gym_id).eq('date', today);
  if (error) throw error;
  res.json({ success: true, data });
});

module.exports = router;
