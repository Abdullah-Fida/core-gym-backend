require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function checkConstraints() {
  // We can't query information_schema easily via the client.
  // We'll try to insert two drafts for the same page and see if it fails or creates two.
  console.log('Testing UNIQUE constraint on (gym_id, page_id)...');
  
  const testId = 'test-gym-123';
  const pageId = 'test-page';
  
  // Clean up
  await supabase.from('form_drafts').delete().eq('gym_id', testId).eq('page_id', pageId);
  
  // Insert 1
  await supabase.from('form_drafts').insert({ gym_id: testId, page_id: pageId, form_data: { val: 1 } });
  
  // Insert 2 (This should trigger a conflict if UNIQUE is working, but it depends on how we call insert)
  // Let's use upsert with onConflict.
  const { error } = await supabase.from('form_drafts').upsert(
    { gym_id: testId, page_id: pageId, form_data: { val: 2 } },
    { onConflict: 'gym_id, page_id' }
  );
  
  if (error) {
    console.log('Upsert conflict/error:', error.message);
  }
  
  // Check count
  const { data, count } = await supabase.from('form_drafts')
    .select('*', { count: 'exact' })
    .eq('gym_id', testId)
    .eq('page_id', pageId);
    
  console.log('Rows found:', count);
  console.log('Data:', data);
  
  if (count > 1) {
    console.error('CRITICAL: UNIQUE constraint is MISSING! Multiple rows found for same gym+page.');
  } else {
    console.log('UNIQUE constraint appears to be WORKING.');
  }
  
  // Cleanup
  await supabase.from('form_drafts').delete().eq('gym_id', testId).eq('page_id', pageId);
}

checkConstraints();
