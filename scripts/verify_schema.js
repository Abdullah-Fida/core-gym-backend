/**
 * Verify a Supabase project matches db/schema.sql.
 *
 *   node scripts/verify_schema.js           read-only: every table + column
 *   node scripts/verify_schema.js --write   also exercises the four upserts
 *
 * --write creates one throwaway gym, runs the real API write paths under it,
 * then deletes that gym (ON DELETE CASCADE removes everything it made). Only
 * use it on an empty/new project.
 *
 * Columns are probed individually via select(), so this works on empty tables —
 * a missing column returns 42703, a missing table returns 42P01/PGRST205.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('✖  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from backend/.env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Every column the backend routes actually read or write.
const EXPECTED = {
  gyms: ['id', 'owner_name', 'gym_name', 'phone', 'email', 'auth_password_hash', 'city',
    'address', 'plan_type', 'trial_ends_at', 'subscription_ends_at', 'is_active',
    'last_login_at', 'default_monthly_fee', 'attendance_active', 'grace_period_days',
    'wa_msg_active', 'wa_msg_due_soon', 'wa_msg_expired', 'created_at'],
  members: ['id', 'gym_id', 'name', 'phone', 'membership_id', 'cnic', 'fingerprint_id',
    'gender', 'join_date', 'status', 'profile_photo_url', 'emergency_contact', 'notes',
    'latest_expiry', 'created_at'],
  payments: ['id', 'gym_id', 'member_id', 'amount', 'payment_date', 'plan_duration_months',
    'custom_days', 'expiry_date', 'payment_method', 'received_by', 'notes', 'created_at'],
  staff: ['id', 'gym_id', 'name', 'phone', 'role', 'custom_role', 'join_date',
    'monthly_salary', 'status', 'notes', 'created_at'],
  staff_payments: ['id', 'gym_id', 'staff_id', 'month', 'year', 'amount_paid', 'paid_date',
    'payment_method', 'notes', 'created_at'],
  staff_attendance: ['id', 'gym_id', 'staff_id', 'date', 'status', 'created_at'],
  expenses: ['id', 'gym_id', 'category', 'custom_category', 'amount', 'expense_date',
    'description', 'receipt_photo_url', 'is_recurring', 'recurrence_day', 'logged_by',
    'created_at'],
  notifications: ['id', 'gym_id', 'member_id', 'staff_id', 'notification_type',
    'scheduled_for', 'recipient_phone', 'message_template', 'status', 'sent_at', 'created_at'],
  attendance: ['id', 'gym_id', 'member_id', 'check_in_time', 'check_out_time', 'date'],
  access_logs: ['id', 'gym_id', 'member_id', 'fingerprint_id', 'timestamp', 'device',
    'status', 'created_at'],
  admin_notes: ['id', 'gym_id', 'text', 'admin', 'date', 'created_at'],
  form_drafts: ['id', 'gym_id', 'page_id', 'form_data', 'updated_at'],
  whatsapp_auth: ['id', 'gym_id', 'key', 'data', 'updated_at', 'created_at'],
};

let failures = 0;
const fail = (msg) => { failures++; console.log(`  ✖  ${msg}`); };

// A dead host or a bad key makes EVERY query fail, which would otherwise be
// reported as "every column is missing". Catch that first and say what it is.
function connectionProblem(error) {
  if (!error) return null;
  const text = `${error.message} ${error.details || ''}`;
  if (/ENOTFOUND|EAI_AGAIN|fetch failed|ECONNREFUSED|ETIMEDOUT/i.test(text)) {
    return `Cannot reach ${SUPABASE_URL}\n   The host does not resolve — the project is paused, deleted, or SUPABASE_URL is wrong.`;
  }
  if (/JWT|API key|Invalid authentication|not authorized/i.test(text) || error.code === '401' || error.code === 'PGRST301') {
    return `Rejected by ${SUPABASE_URL}\n   SUPABASE_SERVICE_ROLE_KEY is wrong or belongs to a different project.`;
  }
  return null;
}

async function checkTables() {
  console.log(`\nProject: ${SUPABASE_URL}`);

  const { error: preflight } = await supabase.from('gyms').select('id').limit(1);
  const problem = connectionProblem(preflight);
  if (problem) {
    console.log(`\n✖  ${problem}`);
    console.log('\n   Fix backend/.env, then re-run. Nothing about the schema was checked.');
    process.exit(1);
  }

  console.log('\n── Tables & columns ──────────────────────────────');

  for (const [table, columns] of Object.entries(EXPECTED)) {
    const { error } = await supabase.from(table).select(columns.join(',')).limit(1);
    if (!error) { console.log(`  ✔  ${table}  (${columns.length} columns)`); continue; }

    // Whole table absent
    if (error.code === '42P01' || error.code === 'PGRST205') { fail(`${table} — TABLE MISSING`); continue; }

    // Narrow down which columns are missing
    const missing = [];
    for (const col of columns) {
      const { error: e } = await supabase.from(table).select(col).limit(1);
      if (e) missing.push(col);
    }
    fail(missing.length ? `${table} — missing column(s): ${missing.join(', ')}`
                        : `${table} — ${error.message}`);
  }
}

async function checkWrites() {
  console.log('\n── Upsert paths (writes then cleans up) ──────────');
  let gymId;
  try {
    const email = `schema-check-${Date.now()}@example.invalid`;
    const { data: gym, error } = await supabase.from('gyms').insert({
      owner_name: 'Schema Check', gym_name: 'Schema Check', phone: '0000000000',
      email, auth_password_hash: 'not-a-real-hash',
    }).select().single();
    if (error) throw new Error(`could not create test gym — ${error.message}`);
    gymId = gym.id;

    const { data: member, error: mErr } = await supabase.from('members')
      .insert({ gym_id: gymId, name: 'Schema Check', phone: '0000000000', status: 'inactive' })
      .select().single();
    if (mErr) throw new Error(`members insert — ${mErr.message}`);

    const { data: staff, error: sErr } = await supabase.from('staff')
      .insert({ gym_id: gymId, name: 'Schema Check', role: 'trainer' }).select().single();
    if (sErr) throw new Error(`staff insert — ${sErr.message}`);

    // POST /api/attendance/staff
    for (const status of ['present', 'absent']) {
      const { error: e } = await supabase.from('staff_attendance')
        .upsert({ staff_id: staff.id, date: '2000-01-01', status, gym_id: gymId },
                { onConflict: 'staff_id,date' });
      if (e) throw new Error(`staff_attendance upsert (needs unique index on staff_id,date) — ${e.message}`);
    }
    const { count: saCount } = await supabase.from('staff_attendance')
      .select('*', { count: 'exact', head: true }).eq('gym_id', gymId);
    if (saCount !== 1) throw new Error(`staff_attendance upsert made ${saCount} rows, expected 1 — unique index missing`);
    console.log("  ✔  staff_attendance upsert  onConflict 'staff_id,date'");

    // POST /api/drafts
    for (const v of [{ a: 1 }, { a: 2 }]) {
      const { error: e } = await supabase.from('form_drafts')
        .upsert({ gym_id: gymId, page_id: 'schema-check', form_data: v },
                { onConflict: 'gym_id, page_id' });
      if (e) throw new Error(`form_drafts upsert (needs unique index on gym_id,page_id) — ${e.message}`);
    }
    const { count: fdCount } = await supabase.from('form_drafts')
      .select('*', { count: 'exact', head: true }).eq('gym_id', gymId);
    if (fdCount !== 1) throw new Error(`form_drafts upsert made ${fdCount} rows, expected 1 — unique index missing`);
    console.log("  ✔  form_drafts upsert  onConflict 'gym_id, page_id'");

    // POST /api/notifications with no scheduled_for — relies on DEFAULT NOW()
    const { error: nErr } = await supabase.from('notifications').insert({
      gym_id: gymId, member_id: member.id, notification_type: 'automated_reminder', status: 'sent',
    });
    if (nErr) throw new Error(`notifications insert without scheduled_for — ${nErr.message}`);
    console.log('  ✔  notifications insert without scheduled_for  (DEFAULT NOW())');

    // Duplicate fingerprint must be rejected
    await supabase.from('members').update({ fingerprint_id: `SCHEMA-CHECK-${gymId}` }).eq('id', member.id);
    const { error: dupErr } = await supabase.from('members').insert({
      gym_id: gymId, name: 'Dup', phone: '1', fingerprint_id: `SCHEMA-CHECK-${gymId}`,
    });
    if (!dupErr) throw new Error('duplicate fingerprint was accepted — partial unique index missing');
    console.log('  ✔  duplicate fingerprint rejected  (partial unique index)');
  } catch (e) {
    fail(e.message);
  } finally {
    if (gymId) {
      const { error } = await supabase.from('gyms').delete().eq('id', gymId);
      console.log(error ? `  ⚠  CLEANUP FAILED — delete gym ${gymId} by hand: ${error.message}`
                        : '  ✔  test data cleaned up (gym deleted, cascade)');
    }
  }
}

(async () => {
  await checkTables();
  if (process.argv.includes('--write')) await checkWrites();
  else console.log('\n(run with --write to also exercise the upsert paths)');

  console.log(failures ? `\n✖  ${failures} problem(s) — re-run db/schema.sql in the Supabase SQL Editor.`
                       : '\n✔  Schema matches. Backend is good to go.');
  process.exit(failures ? 1 : 0);
})();
