require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function debugBackend() {
  console.log('--- Debugging Drafts Backend ---');
  
  // Test 1: Simple Select
  console.log('Test 1: Selecting from form_drafts...');
  const { data: d1, error: e1 } = await supabase.from('form_drafts').select('*').limit(1);
  if (e1) {
    console.error('Test 1 Error:', e1.message, e1.code);
  } else {
    console.log('Test 1 Success:', d1);
  }

  // Test 2: Try to insert/upsert
  console.log('Test 2: Upserting data...');
  const { error: e2 } = await supabase.from('form_drafts').upsert({
    gym_id: 'db-debug-gym',
    page_id: 'test-page',
    form_data: { test: true },
    updated_at: new Date().toISOString()
  });
  if (e2) {
    console.error('Test 2 Error:', e2.message, e2.code, e2.details);
  } else {
    console.log('Test 2 Success');
  }
}

debugBackend();
