require('dotenv').config({ path: '.env' });
const { createClient } = require('@supabase/supabase-js');

async function migrateFingerprint() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing Supabase credentials');
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  console.log('Running members fingerprint migration...');

  const alterSql = [
    'ALTER TABLE public.members ADD COLUMN IF NOT EXISTS fingerprint_id TEXT;',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_members_gym_fingerprint_unique ON public.members(gym_id, fingerprint_id) WHERE fingerprint_id IS NOT NULL;'
  ].join(' ');

  const { error } = await supabase.rpc('exec_sql', { sql: alterSql });

  if (error) {
    if (String(error.message || '').includes('not found')) {
      console.log('RPC exec_sql is not available in this project.');
      console.log('Run this SQL manually in Supabase SQL Editor:\n');
      console.log(alterSql);
    } else {
      console.error('Migration error:', error.message || error);
    }
  } else {
    console.log('Migration complete: members.fingerprint_id is ready.');
  }

  const { data, error: verifyError } = await supabase.from('members').select('fingerprint_id').limit(1);
  if (verifyError) {
    console.error('Verification failed:', verifyError.message);
  } else {
    console.log('Verification success. Sample rows checked:', Array.isArray(data) ? data.length : 0);
  }
}

migrateFingerprint();
