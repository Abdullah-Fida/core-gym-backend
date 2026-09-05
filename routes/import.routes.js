const express = require('express');
const { z } = require('zod');
const { randomUUID } = require('crypto');
const { supabase } = require('../db/supabase');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

/**
 * Bulk import.
 *
 * Two properties matter more than speed here:
 *
 *   1. A dry run must write nothing, so an owner can check a file against their
 *      real data before committing to it.
 *   2. A partial failure must not leave half a file imported. Supabase's REST
 *      API has no interactive transaction, so every row written in one request
 *      is tagged with a shared `import_batch` id and deleted again if a later
 *      chunk fails. That token is also returned so the import can be undone
 *      afterwards from the UI.
 */

const CHUNK = 200;
const MAX_ROWS = 5000;

const ENTITY_CONFIG = {
  members: {
    table: 'members',
    // Same rule as POST /members: a name+phone pair already on file is the
    // same person, not a new one.
    dedupeKeys: ['name', 'phone'],
    allowed: ['name', 'phone', 'join_date', 'emergency_contact', 'notes'],
    defaults: () => ({ status: 'active' }),
  },
  staff: {
    table: 'staff',
    dedupeKeys: ['name', 'phone'],
    allowed: ['name', 'role', 'phone', 'monthly_salary', 'join_date'],
    defaults: () => ({}),
  },
  expenses: {
    table: 'expenses',
    // Expenses legitimately repeat (same rent, same day each month), so there
    // is no dedupe rule — silently dropping them would lose real spend.
    dedupeKeys: null,
    allowed: ['title', 'amount', 'category', 'expense_date', 'notes'],
    defaults: () => ({}),
  },
  payments: {
    table: 'payments',
    dedupeKeys: null,
    allowed: ['member_id', 'amount', 'payment_date', 'plan_duration_months', 'payment_method', 'notes'],
    defaults: () => ({ payment_type: 'membership' }),
    // Payments arrive keyed by member phone and must be resolved to an id.
    resolve: async (rows, gymId) => {
      const { data: members } = await supabase
        .from('members')
        .select('id, phone, name')
        .eq('gym_id', gymId);

      const byPhone = new Map(
        (members || []).map((m) => [String(m.phone || '').replace(/\D/g, ''), m])
      );

      const resolved = [];
      const unmatched = [];

      rows.forEach((row, i) => {
        const key = String(row.member_phone || '').replace(/\D/g, '');
        const member = byPhone.get(key);
        if (!member) {
          unmatched.push({ row: i + 2, errors: [`No member with phone "${row.member_phone}".`], raw: row });
          return;
        }
        const { member_phone: _phone, ...rest } = row;
        resolved.push({ ...rest, member_id: member.id });
      });

      return { rows: resolved, errors: unmatched };
    },
  },
};

const importSchema = z.object({
  rows: z.array(z.record(z.any())).min(1).max(MAX_ROWS),
  dry_run: z.boolean().default(true),
});

/** Keep only columns the table actually has, so one stray header cannot 400 the whole import. */
const pick = (row, allowed) =>
  Object.fromEntries(Object.entries(row).filter(([k]) => allowed.includes(k)));

// ── POST /api/import/:entity ──────────────
router.post('/:entity', async (req, res) => {
  const config = ENTITY_CONFIG[req.params.entity];
  if (!config) {
    return res.status(400).json({ success: false, message: `Cannot import "${req.params.entity}".` });
  }

  const { rows, dry_run: dryRun } = importSchema.parse(req.body);
  const gymId = req.user.gym_id;

  let working = rows;
  const errors = [];

  // 1. Resolve foreign keys (payments -> member_id).
  if (config.resolve) {
    const resolved = await config.resolve(working, gymId);
    working = resolved.rows;
    errors.push(...resolved.errors);
  }

  // 2. Drop rows that already exist.
  let duplicates = 0;
  if (config.dedupeKeys) {
    const { data: existing } = await supabase
      .from(config.table)
      .select(config.dedupeKeys.join(', '))
      .eq('gym_id', gymId);

    const keyOf = (r) =>
      config.dedupeKeys
        .map((k) => String(r[k] ?? '').toLowerCase().replace(/\s+/g, ' ').trim())
        .join('|');

    const seen = new Set((existing || []).map(keyOf));
    const deduped = [];
    for (const row of working) {
      const key = keyOf(row);
      // Also guards against the same row appearing twice inside one file.
      if (seen.has(key)) {
        duplicates += 1;
        continue;
      }
      seen.add(key);
      deduped.push(row);
    }
    working = deduped;
  }

  const prepared = working.map((row) => ({
    ...config.defaults(),
    ...pick(row, config.allowed),
    gym_id: gymId,
  }));

  // 3. Dry run stops here, having written nothing.
  if (dryRun) {
    return res.json({
      success: true,
      dry_run: true,
      data: {
        will_import: prepared.length,
        duplicates_skipped: duplicates,
        errors,
        sample: prepared.slice(0, 5),
      },
      message: `${prepared.length} row${prepared.length === 1 ? '' : 's'} ready to import.`,
    });
  }

  if (!prepared.length) {
    return res.status(400).json({ success: false, message: 'Nothing left to import after validation.' });
  }

  // 4. Commit. Every row carries the batch id so the whole import can be undone.
  const batchId = randomUUID();
  const tagged = prepared.map((r) => ({ ...r, import_batch: batchId }));
  let inserted = 0;

  try {
    for (let i = 0; i < tagged.length; i += CHUNK) {
      const chunk = tagged.slice(i, i + CHUNK);
      const { data, error } = await supabase.from(config.table).insert(chunk).select('id');
      if (error) throw error;
      inserted += (data || []).length;
    }
  } catch (err) {
    // Roll back everything this request wrote — a half-imported file is worse
    // than a failed one, because the owner cannot tell what is missing.
    await supabase.from(config.table).delete().eq('import_batch', batchId).eq('gym_id', gymId);
    return res.status(400).json({
      success: false,
      message: `Import failed after ${inserted} row${inserted === 1 ? '' : 's'} and was rolled back. ${err.message}`,
    });
  }

  res.status(201).json({
    success: true,
    data: { imported: inserted, duplicates_skipped: duplicates, errors, batch_id: batchId },
    message: `${inserted} row${inserted === 1 ? '' : 's'} imported.`,
  });
});

// ── DELETE /api/import/:entity/:batchId — undo an import ──
router.delete('/:entity/:batchId', async (req, res) => {
  const config = ENTITY_CONFIG[req.params.entity];
  if (!config) return res.status(400).json({ success: false, message: 'Unknown entity.' });

  const { data, error } = await supabase
    .from(config.table)
    .delete()
    .eq('import_batch', req.params.batchId)
    .eq('gym_id', req.user.gym_id)
    .select('id');

  if (error) throw error;
  res.json({
    success: true,
    data: { removed: (data || []).length },
    message: `${(data || []).length} imported row${(data || []).length === 1 ? '' : 's'} removed.`,
  });
});

module.exports = router;
