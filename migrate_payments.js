require('dotenv').config({ path: '.env' });
const { createClient } = require('@supabase/supabase-js');

async function migrate() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  
  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing Supabase credentials');
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  
  console.log('Adding custom_days column to payments...');
  
  // Using direct SQL if exec_sql RPC exists, otherwise we'll just try to insert and see
  const { error } = await supabase.rpc('exec_sql', { 
    sql: 'ALTER TABLE payments ADD COLUMN IF NOT EXISTS custom_days INTEGER DEFAULT 0;' 
  });

  if (error) {
    if (error.message.includes('not found')) {
      console.log('RPC exec_sql not found. This migration usually requires manual SQL execution in Supabase dashboard.');
      console.log('But let\'s try to insert a dummy record with custom_days to see if it exists.');
      const { error: insertError } = await supabase.from('payments').select('custom_days').limit(1);
      if (insertError) {
        console.error('Column custom_days does NOT exist. Action required!');
      } else {
        console.log('Column custom_days ALREADY exists.');
      }
    } else {
      console.error('Migration error:', error);
    }
  } else {
    console.log('Migration successful: custom_days column added.');
  }
}

migrate();
