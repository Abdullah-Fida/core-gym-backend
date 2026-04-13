require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase environment variables');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function setupDraftsTable() {
  console.log('Checking for form_drafts table...');
  
  // Since we can't run raw SQL via the client easily without RPC, 
  // we'll try a dummy query and if it fails with 42P01 (relation does not exist), 
  // we know it's missing. However, we can't CREATE the table via the client.
  
  const { error } = await supabase.from('form_drafts').select('count', { count: 'exact', head: true });
  
  if (error) {
    if (error.code === '42P01') {
      console.log('Table "form_drafts" is missing. Please run the SQL in schema.sql in your Supabase dashboard.');
    } else {
      console.error('Error checking table:', error);
    }
  } else {
    console.log('Table "form_drafts" exists.');
  }
}

setupDraftsTable();
