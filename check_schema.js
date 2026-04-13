require('dotenv').config({ path: '.env' });
const { createClient } = require('@supabase/supabase-js');

async function checkSchema() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  console.log('Checking gyms table...');
  const { data: gData, error: gError } = await supabase.from('gyms').select('*').limit(1);
  if (gError) console.error('Gyms error:', gError.message);
  else {
    const cols = Object.keys(gData[0] || {});
    console.log('Gyms columns:', cols.join(', '));
    if (!cols.includes('attendance_active')) console.log('❌ MISSING: gyms.attendance_active');
  }
  
  console.log('Checking payments table...');
  const { data: pData, error: pError } = await supabase.from('payments').select('*').limit(1);
  if (pError) console.error('Payments error:', pError.message);
  else {
    const cols = Object.keys(pData[0] || {});
    console.log('Payments columns:', cols.join(', '));
    if (!cols.includes('custom_days')) console.log('❌ MISSING: payments.custom_days');
  }

  console.log('\nChecking members table...');
  const { data: mData, error: mError } = await supabase.from('members').select('*').limit(1);
  if (mError) console.error('Members error:', mError.message);
  else {
    const cols = Object.keys(mData[0] || {});
    console.log('Members columns:', cols.join(', '));
    if (!cols.includes('latest_expiry')) console.log('❌ MISSING: members.latest_expiry');
    if (!cols.includes('fingerprint_id')) console.log('❌ MISSING: members.fingerprint_id');
  }

  console.log('\nChecking expenses table...');
  const { data: eData, error: eError } = await supabase.from('expenses').select('*').limit(1);
  if (eError) console.error('Expenses error:', eError.message);
  else {
    const cols = Object.keys(eData[0] || {});
    console.log('Expenses columns:', cols.join(', '));
  }
}

checkSchema();
