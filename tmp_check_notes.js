require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

async function checkAdminNotes() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  console.log('Checking admin_notes table...');
  const { data, error } = await supabase.from('admin_notes').select('*').limit(5);
  if (error) {
    console.error('admin_notes error:', error.message);
  } else {
    console.log('Found', data.length, 'notes.');
    data.forEach(note => {
      console.log('ID:', note.id, 'Admin:', note.admin, 'Text:', JSON.stringify(note.text), 'Type of Text:', typeof note.text);
    });
  }
}

checkAdminNotes();
