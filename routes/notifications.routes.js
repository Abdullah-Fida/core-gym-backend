const express = require('express');
const { supabase } = require('../db/supabase');
const { authenticate, requireGymOwner } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireGymOwner);

router.get('/', async (req, res) => {
  const { status } = req.query;
  let query = supabase.from('notifications').select(`
    *, 
    members(
      id, 
      name, 
      phone, 
      status, 
      payments(expiry_date)
    )
  `).eq('gym_id', req.user.gym_id).order('scheduled_for', { ascending: false });
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw error;
  res.json({ success: true, data });
});

router.patch('/:id/sent', async (req, res) => {
  const { data, error } = await supabase.from('notifications').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', req.params.id).eq('gym_id', req.user.gym_id).select().single();
  if (error) throw error;
  res.json({ success: true, data });
});

router.post('/', async (req, res) => {
  const { member_id, notification_type, message_template, scheduled_for } = req.body;
  const { data, error } = await supabase.from('notifications').insert({ gym_id: req.user.gym_id, member_id, notification_type, message_template, scheduled_for, status: 'pending' }).select().single();
  if (error) throw error;
  res.status(201).json({ success: true, data });
});

module.exports = router;
