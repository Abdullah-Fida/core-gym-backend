const express = require('express');
const { z } = require('zod');
const { supabase } = require('../db/supabase');
const { authenticate } = require('../middleware/auth');
// The money arithmetic lives in lib/pos.js so the unit tests cover the code
// that actually runs, not a second copy of it.
const { round2, priceLine, basketTotals, checkStock } = require('../lib/pos');

const router = express.Router();
router.use(authenticate);

const gymOf = (req) => req.user.gym_id;

// ════════════════════════════════════════════════════
// PRODUCTS
// ════════════════════════════════════════════════════

const productSchema = z.object({
  name: z.string().min(1).max(100),
  sku: z.string().max(40).optional().or(z.literal('')),
  category: z.enum(['supplement', 'drink', 'apparel', 'equipment', 'service', 'other']).default('supplement'),
  price: z.coerce.number().min(0),
  cost: z.coerce.number().min(0).default(0),
  stock: z.coerce.number().int().default(0),
  low_stock_at: z.coerce.number().int().min(0).default(5),
  track_stock: z.boolean().default(true),
  is_active: z.boolean().default(true),
});

router.get('/products', async (req, res) => {
  let query = supabase.from('products').select('*').eq('gym_id', gymOf(req));
  if (req.query.category) query = query.eq('category', req.query.category);
  if (req.query.active === 'true') query = query.eq('is_active', true);

  const { data, error } = await query.order('name');
  if (error) throw error;

  const rows = data || [];
  res.json({
    success: true,
    data: rows.map((p) => ({ ...p, is_low: p.track_stock && p.stock <= p.low_stock_at })),
    stats: {
      total: rows.length,
      low_stock: rows.filter((p) => p.is_active && p.track_stock && p.stock <= p.low_stock_at).length,
      // What the shelf is worth at cost — the number an owner needs for accounts.
      stock_value: round2(rows.reduce((s, p) => s + (p.track_stock ? p.stock * Number(p.cost || 0) : 0), 0)),
    },
  });
});

router.post('/products', async (req, res) => {
  const body = productSchema.parse(req.body);
  const gymId = gymOf(req);

  const { data, error } = await supabase
    .from('products')
    .insert({ ...body, sku: body.sku || null, gym_id: gymId })
    .select().single();

  if (error?.code === '23505') {
    return res.status(409).json({ success: false, message: `SKU "${body.sku}" is already in use.` });
  }
  if (error) throw error;

  // Opening stock is a movement too, so the ledger explains every unit.
  if (body.track_stock && body.stock > 0) {
    await supabase.from('stock_movements').insert({
      gym_id: gymId, product_id: data.id, delta: body.stock,
      reason: 'restock', note: 'Opening stock', actor: req.user?.email || null,
    });
  }

  res.status(201).json({ success: true, data, message: 'Product added.' });
});

router.patch('/products/:id', async (req, res) => {
  // `stock` is deliberately excluded: it moves only through /restock or a sale,
  // so the movements ledger can never disagree with the stock column.
  const body = productSchema.partial().omit({ stock: true }).parse(req.body);

  const { data, error } = await supabase
    .from('products')
    .update({ ...body, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('gym_id', gymOf(req)).select().single();
  if (error) throw error;
  if (!data) return res.status(404).json({ success: false, message: 'Product not found.' });
  res.json({ success: true, data, message: 'Product updated.' });
});

router.post('/products/:id/restock', async (req, res) => {
  const schema = z.object({
    delta: z.coerce.number().int().refine((n) => n !== 0, 'Enter a non-zero quantity.'),
    reason: z.enum(['restock', 'adjustment', 'damage']).default('restock'),
    note: z.string().max(200).optional(),
  });
  const body = schema.parse(req.body);
  const gymId = gymOf(req);

  const { data: product } = await supabase
    .from('products').select('*').eq('id', req.params.id).eq('gym_id', gymId).maybeSingle();
  if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });

  const next = product.stock + body.delta;
  if (next < 0) {
    return res.status(400).json({
      success: false,
      message: `That would leave ${next} in stock. There are only ${product.stock}.`,
    });
  }

  const { data, error } = await supabase
    .from('products').update({ stock: next, updated_at: new Date().toISOString() })
    .eq('id', product.id).select().single();
  if (error) throw error;

  await supabase.from('stock_movements').insert({
    gym_id: gymId, product_id: product.id, delta: body.delta,
    reason: body.reason, note: body.note || null, actor: req.user?.email || null,
  });

  res.json({ success: true, data, message: `Stock updated to ${next}.` });
});

router.get('/products/:id/movements', async (req, res) => {
  const { data, error } = await supabase
    .from('stock_movements').select('*')
    .eq('product_id', req.params.id).eq('gym_id', gymOf(req))
    .order('created_at', { ascending: false }).limit(200);
  if (error) throw error;
  res.json({ success: true, data });
});

router.delete('/products/:id', async (req, res) => {
  const { count } = await supabase
    .from('sale_items').select('id', { count: 'exact', head: true }).eq('product_id', req.params.id);

  if (count > 0) {
    // Past receipts reference this product; deactivate so history survives.
    const { data } = await supabase
      .from('products').update({ is_active: false })
      .eq('id', req.params.id).eq('gym_id', gymOf(req)).select().single();
    return res.json({
      success: true, data,
      message: `This product appears on ${count} past sale${count === 1 ? '' : 's'}, so it was deactivated rather than deleted.`,
    });
  }

  const { error } = await supabase
    .from('products').delete().eq('id', req.params.id).eq('gym_id', gymOf(req));
  if (error) throw error;
  res.json({ success: true, message: 'Product deleted.' });
});

// ════════════════════════════════════════════════════
// SALES
// ════════════════════════════════════════════════════

/**
 * POST /api/pos/sales
 *
 * Stock is checked and decremented per line. If any line fails, everything
 * written so far is undone — a sale that took payment for stock it could not
 * reserve is worse than a rejected sale.
 */
router.post('/sales', async (req, res) => {
  const schema = z.object({
    member_id: z.string().uuid().nullable().optional(),
    items: z.array(z.object({
      product_id: z.string().uuid(),
      quantity: z.coerce.number().int().min(1).max(999),
    })).min(1),
    discount: z.coerce.number().min(0).default(0),
    payment_method: z.string().max(30).default('cash'),
    sold_by: z.string().max(80).optional(),
    note: z.string().max(300).optional(),
  });
  const body = schema.parse(req.body);
  const gymId = gymOf(req);

  const ids = [...new Set(body.items.map((i) => i.product_id))];
  const { data: products } = await supabase
    .from('products').select('*').eq('gym_id', gymId).in('id', ids);

  const byId = new Map((products || []).map((p) => [p.id, p]));

  // Validate the whole basket before writing anything: a sale that half-commits
  // is worse than one that is refused outright.
  const lines = [];
  for (const item of body.items) {
    const product = byId.get(item.product_id);
    const check = checkStock(product, item.quantity);
    if (!check.ok) return res.status(400).json({ success: false, message: check.reason });

    const priced = priceLine(product, item.quantity);
    if (!priced) {
      return res.status(400).json({ success: false, message: `Invalid quantity for ${product.name}.` });
    }
    lines.push({ ...priced, product });
  }

  const { subtotal, discount, total } = basketTotals(lines, body.discount);

  const { data: sale, error: saleErr } = await supabase.from('sales').insert({
    gym_id: gymId,
    member_id: body.member_id || null,
    subtotal, discount, total,
    payment_method: body.payment_method,
    sold_by: body.sold_by || req.user?.email || null,
    note: body.note || null,
    status: 'completed',
  }).select().single();
  if (saleErr) throw saleErr;

  /** Undo everything this request wrote. */
  const rollback = async () => {
    await supabase.from('sale_items').delete().eq('sale_id', sale.id);
    await supabase.from('stock_movements').delete().eq('sale_id', sale.id);
    await supabase.from('sales').delete().eq('id', sale.id);
  };

  try {
    const { error: itemsErr } = await supabase.from('sale_items').insert(
      lines.map((l) => ({
        gym_id: gymId,
        sale_id: sale.id,
        product_id: l.product_id,
        // Snapshotted so repricing later cannot rewrite this receipt.
        name: l.name,
        unit_price: l.unit_price,
        unit_cost: l.unit_cost,
        quantity: l.quantity,
        line_total: l.line_total,
      }))
    );
    if (itemsErr) throw itemsErr;

    for (const line of lines) {
      if (!line.product.track_stock) continue;

      const nextStock = line.product.stock - line.quantity;
      const { error: stockErr } = await supabase
        .from('products')
        .update({ stock: nextStock, updated_at: new Date().toISOString() })
        .eq('id', line.product.id)
        // Guard against a concurrent sale of the same item: if stock moved
        // since we read it, this matches nothing and we roll back.
        .eq('stock', line.product.stock);
      if (stockErr) throw stockErr;

      await supabase.from('stock_movements').insert({
        gym_id: gymId, product_id: line.product.id,
        delta: -line.quantity, reason: 'sale', sale_id: sale.id,
        actor: req.user?.email || null,
      });
    }
  } catch (err) {
    await rollback();
    return res.status(409).json({
      success: false,
      message: `The sale could not be completed and nothing was charged. ${err.message}`,
    });
  }

  const { data: full } = await supabase
    .from('sales').select('*, items:sale_items(*), member:members(id, name)')
    .eq('id', sale.id).single();

  res.status(201).json({ success: true, data: full, message: 'Sale recorded.' });
});

router.get('/sales', async (req, res) => {
  let query = supabase
    .from('sales')
    .select('*, items:sale_items(*), member:members(id, name)')
    .eq('gym_id', gymOf(req));

  if (req.query.from) query = query.gte('sold_at', `${req.query.from}T00:00:00.000Z`);
  if (req.query.to) query = query.lte('sold_at', `${req.query.to}T23:59:59.999Z`);
  if (req.query.member_id) query = query.eq('member_id', req.query.member_id);

  const { data, error } = await query.order('sold_at', { ascending: false }).limit(300);
  if (error) throw error;

  const rows = (data || []).filter((s) => s.status === 'completed');
  const revenue = round2(rows.reduce((s, r) => s + Number(r.total || 0), 0));
  const cost = round2(rows.reduce(
    (s, r) => s + (r.items || []).reduce((c, i) => c + Number(i.unit_cost || 0) * i.quantity, 0),
    0
  ));

  res.json({
    success: true,
    data,
    stats: { count: rows.length, revenue, cost, profit: round2(revenue - cost) },
  });
});

/** Refund a sale and put the stock back. */
router.post('/sales/:id/refund', async (req, res) => {
  const gymId = gymOf(req);
  const { data: sale } = await supabase
    .from('sales').select('*, items:sale_items(*)')
    .eq('id', req.params.id).eq('gym_id', gymId).maybeSingle();

  if (!sale) return res.status(404).json({ success: false, message: 'Sale not found.' });
  if (sale.status === 'refunded') {
    return res.status(409).json({ success: false, message: 'That sale was already refunded.' });
  }

  for (const item of sale.items || []) {
    if (!item.product_id) continue;
    const { data: product } = await supabase
      .from('products').select('stock, track_stock').eq('id', item.product_id).maybeSingle();
    if (!product?.track_stock) continue;

    await supabase.from('products')
      .update({ stock: product.stock + item.quantity }).eq('id', item.product_id);
    await supabase.from('stock_movements').insert({
      gym_id: gymId, product_id: item.product_id, delta: item.quantity,
      reason: 'refund', sale_id: sale.id, actor: req.user?.email || null,
    });
  }

  const { data, error } = await supabase
    .from('sales').update({ status: 'refunded' }).eq('id', sale.id).select().single();
  if (error) throw error;

  res.json({ success: true, data, message: 'Sale refunded and stock returned.' });
});

module.exports = router;
