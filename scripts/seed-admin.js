require('dotenv').config();
const { supabase } = require('../db/supabase');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL || 'wahabwaqas345@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || crypto.randomBytes(10).toString('hex');

async function seedAdmin() {
  console.log('Checking Supabase connection...');
  
  if (process.env.SUPABASE_URL === 'https://your-project.supabase.co') {
    console.error('❌ ERROR: You still have placeholder credentials in your backend/.env file!');
    console.error('Please put your actual Supabase URL and Keys inside backend/.env and try again.');
    process.exit(1);
  }

  const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  const emails = SUPER_ADMIN_EMAIL.split(',').map(e => e.trim());

  for (const email of emails) {
    if (!email) continue;
    console.log(`Creating Admin user: ${email} ...`);
    
    // Instead of using onConflict which requires a unique constraint, let's select first
    const { data: existing } = await supabase.from('gyms').select('id').eq('email', email).maybeSingle();

    if (existing) {
      // Update password hash if exists
      const { error } = await supabase.from('gyms').update({
        auth_password_hash: hash,
        plan_type: 'pro',
        is_active: true
      }).eq('id', existing.id);
      
      if (error) {
        console.error(`❌ Error updating admin user ${email}:`, error.message);
      } else {
        console.log(`✅ Success! Admin user ${email} already exists and password updated.`);
      }
    } else {
      // Insert if doesn't exist
      const { error } = await supabase.from('gyms').insert({
        id: uuidv4(),
        email: email,
        auth_password_hash: hash,
        gym_name: 'Core System Admin',
        owner_name: 'Super Admin',
        phone: '0000000000',
        plan_type: 'pro',
        is_active: true
      });

      if (error) {
        console.error(`❌ Error creating admin user ${email}:`, error.message);
      } else {
        console.log(`✅ Success! Admin user ${email} created.`);
      }
    }
  }
  if (process.env.SHOW_SEED_PASSWORD === 'true') {
    console.log(`ONE-TIME admin password for ${SUPER_ADMIN_EMAIL}: ${ADMIN_PASSWORD}`);
    console.log('This password is shown because SHOW_SEED_PASSWORD=true. Rotate it immediately.');
  } else {
    console.log('Admin account created. To display the generated password, run with SHOW_SEED_PASSWORD=true');
  }
}

seedAdmin();
