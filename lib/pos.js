/**
 * Point-of-sale arithmetic.
 *
 * Extracted so the money maths is unit-tested rather than only exercised
 * through a live database. Floating-point drift on a basket of items is a real
 * problem: 0.1 + 0.2 is 0.30000000000000004, and a receipt that does not add up
 * destroys a shop owner's trust in the whole system.
 */

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** One basket line, priced. */
function priceLine(product, quantity) {
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1) return null;
  return {
    product_id: product.id,
    name: product.name,
    unit_price: Number(product.price),
    unit_cost: Number(product.cost || 0),
    quantity: qty,
    line_total: round2(Number(product.price) * qty),
  };
}

/**
 * Basket totals.
 *
 * The discount is clamped to the subtotal — a discount larger than the basket
 * would otherwise produce a negative total and a refund the shop never agreed to.
 */
function basketTotals(lines, discountInput = 0) {
  const subtotal = round2(lines.reduce((s, l) => s + l.line_total, 0));
  const requested = Number(discountInput) || 0;
  const discount = round2(Math.min(Math.max(0, requested), subtotal));
  return { subtotal, discount, total: round2(subtotal - discount) };
}

/** Whether a line can be fulfilled from stock. */
function checkStock(product, quantity) {
  if (!product) return { ok: false, reason: 'That product no longer exists.' };
  if (!product.is_active) return { ok: false, reason: `${product.name} is no longer for sale.` };
  // Services have no physical stock to draw down.
  if (!product.track_stock) return { ok: true };
  if (product.stock < quantity) {
    return { ok: false, reason: `Only ${product.stock} × ${product.name} left in stock.` };
  }
  return { ok: true };
}

/** Gross margin on a completed sale. */
function saleMargin(items, discount = 0) {
  const revenue = round2(items.reduce((s, i) => s + Number(i.line_total || 0), 0) - Number(discount || 0));
  const cost = round2(items.reduce((s, i) => s + Number(i.unit_cost || 0) * i.quantity, 0));
  return { revenue, cost, profit: round2(revenue - cost) };
}

module.exports = { round2, priceLine, basketTotals, checkStock, saleMargin };
