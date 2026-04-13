require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function inspectSchema() {
  console.log('Inspecting public tables...');
  // We can't query information_schema directly via Supabase client easily 
  // without a custom function (RPC).
  // But we can try to find ANY existing table to see if the connection is even right.
  const { data, error } = await supabase.from('gyms').select('id').limit(1);
  if (error) {
    console.error('Gyms table error:', error.message);
  } else {
    console.log('Gyms table found. Data:', data);
  }

  console.log('Trying to find form_drafts table via GET request to PostgREST...');
  // Manual fetch to see headers/body
  const url = `${supabaseUrl}/rest/v1/form_drafts?select=*&limit=1`;
  const response = await fetch(url, {
    headers: {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`
    }
  });
  console.log('Response Status:', response.status);
  const body = await response.text();
  console.log('Response Body:', body);
}

inspectSchema();
