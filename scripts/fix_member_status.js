const { supabase } = require('../db/supabase');
require('dotenv').config();

async function fixStatus() {
  console.log('--- Fixing Member Statuses ---');
  
  // 1. Find all members with NO latest_expiry who are marked as 'active' or 'expired'
  // and mark them as 'inactive'
  const { data: unpaidMembers, error: fetchError } = await supabase
    .from('members')
    .select('id, name')
    .is('latest_expiry', null)
    .neq('status', 'inactive');

  if (fetchError) {
    console.error('Fetch error:', fetchError);
    return;
  }

  console.log(`Found ${unpaidMembers.length} members with no payments marked incorrectly.`);

  if (unpaidMembers.length === 0) {
    console.log('No members to fix.');
    return;
  }

  for (const member of unpaidMembers) {
    console.log(`Fixing ${member.name}...`);
    const { error: updateError } = await supabase
      .from('members')
      .update({ status: 'inactive' })
      .eq('id', member.id);
    
    if (updateError) {
      console.error(`Failed to update ${member.name}:`, updateError);
    }
  }

  console.log('--- Done ---');
}

fixStatus();
