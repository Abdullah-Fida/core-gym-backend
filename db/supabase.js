const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  if (process.env.NODE_ENV !== 'test') {
    console.warn('⚠️  Supabase env vars missing. Running in mock mode.');
  }
}

// Service role client — has full DB access, bypasses RLS
// ONLY use server-side, never expose to frontend
const supabase = createClient(supabaseUrl || 'http://localhost', supabaseServiceKey || 'mock-key', {
  auth: { autoRefreshToken: false, persistSession: false }
});

// Anon client — respects RLS policies
const supabaseAnon = createClient(
  supabaseUrl || 'http://localhost',
  process.env.SUPABASE_ANON_KEY || 'mock-key'
);

module.exports = { supabase, supabaseAnon };
