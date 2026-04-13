const express = require('express');
const { supabase } = require('../db/supabase');
const { authenticate } = require('../middleware/auth');
const router = express.Router();

router.use(authenticate);

/**
 * @route   GET /api/drafts/:pageId
 * @desc    Load a form draft for a specific page
 */
router.get('/:pageId', async (req, res) => {
  try {
    const { pageId } = req.params;
    const { data, error } = await supabase
      .from('form_drafts')
      .select('form_data')
      .eq('gym_id', req.user.gym_id)
      .eq('page_id', pageId)
      .maybeSingle();

    if (error) {
      if (error.code === 'PGRST204' || error.code === 'PGRST205' || error.code === '42P01') {
        console.warn(`[Drafts] Table 'form_drafts' not found or not in cache. Drafts disabled for now.`);
        return res.json({ success: true, data: null });
      }
      throw error;
    }
    res.json({ success: true, data: data ? data.form_data : null });
  } catch (err) {
    console.error(`[Drafts] GET Error:`, err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * @route   POST /api/drafts
 * @desc    Save or update a form draft
 */
router.post('/', async (req, res) => {
  try {
    const { pageId, formData } = req.body;
    if (!pageId || !formData) {
      return res.status(400).json({ success: false, message: 'pageId and formData are required' });
    }

    const { error } = await supabase
      .from('form_drafts')
      .upsert({
        gym_id: req.user.gym_id,
        page_id: pageId,
        form_data: formData,
        updated_at: new Date().toISOString()
      }, { onConflict: 'gym_id, page_id' });

    if (error) {
      if (error.code === 'PGRST204' || error.code === 'PGRST205' || error.code === '42P01') {
        return res.status(200).json({ success: true, message: 'Draft skipped (table missing)' });
      }
      throw error;
    }
    res.json({ success: true, message: 'Draft saved' });
  } catch (err) {
    console.error(`[Drafts] POST Error:`, err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * @route   DELETE /api/drafts/:pageId
 * @desc    Clear a form draft
 */
router.delete('/:pageId', async (req, res) => {
  try {
    const { pageId } = req.params;
    const { error } = await supabase
      .from('form_drafts')
      .delete()
      .eq('gym_id', req.user.gym_id)
      .eq('page_id', pageId);

    if (error) throw error;
    res.json({ success: true, message: 'Draft cleared' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
