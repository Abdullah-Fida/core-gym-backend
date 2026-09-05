const { round2, priceLine, basketTotals, checkStock, saleMargin } = require('../lib/pos');

const product = (over = {}) => ({
  id: 'p1', name: 'Whey Protein', price: 4500, cost: 3200,
  stock: 10, track_stock: true, is_active: true, ...over,
});

describe('round2', () => {
  it('kills floating-point drift', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(1.005)).toBe(1.01);
    expect(round2(4500 * 3)).toBe(13500);
  });
});

describe('priceLine', () => {
  it('prices a line', () => {
    expect(priceLine(product(), 3)).toMatchObject({
      name: 'Whey Protein', unit_price: 4500, unit_cost: 3200, quantity: 3, line_total: 13500,
    });
  });

  it('rejects a non-positive or fractional quantity', () => {
    expect(priceLine(product(), 0)).toBeNull();
    expect(priceLine(product(), -2)).toBeNull();
    expect(priceLine(product(), 1.5)).toBeNull();
  });
});

describe('basketTotals', () => {
  const lines = [
    { line_total: 4500 },
    { line_total: 250.5 },
    { line_total: 99.99 },
  ];

  it('sums and rounds cleanly', () => {
    expect(basketTotals(lines).subtotal).toBe(4850.49);
  });

  it('applies a discount', () => {
    expect(basketTotals(lines, 350.49)).toEqual({ subtotal: 4850.49, discount: 350.49, total: 4500 });
  });

  it('never lets a discount exceed the basket', () => {
    // Otherwise the total goes negative and the shop owes the customer money.
    const t = basketTotals(lines, 999999);
    expect(t.discount).toBe(4850.49);
    expect(t.total).toBe(0);
  });

  it('ignores a negative discount', () => {
    expect(basketTotals(lines, -100).total).toBe(4850.49);
  });

  it('handles junk input', () => {
    expect(basketTotals(lines, 'abc').total).toBe(4850.49);
    expect(basketTotals([]).total).toBe(0);
  });
});

describe('checkStock', () => {
  it('allows a line within stock', () => {
    expect(checkStock(product(), 5).ok).toBe(true);
  });

  it('allows exactly the last unit', () => {
    expect(checkStock(product({ stock: 3 }), 3).ok).toBe(true);
  });

  it('refuses one more than available', () => {
    const r = checkStock(product({ stock: 3 }), 4);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/only 3/i);
  });

  it('ignores stock for a service', () => {
    // A day pass has no shelf; it should never be blocked by a stock count.
    expect(checkStock(product({ track_stock: false, stock: 0 }), 99).ok).toBe(true);
  });

  it('refuses an inactive or missing product', () => {
    expect(checkStock(product({ is_active: false }), 1).ok).toBe(false);
    expect(checkStock(null, 1).ok).toBe(false);
  });
});

describe('saleMargin', () => {
  it('computes profit after discount', () => {
    const items = [
      { line_total: 9000, unit_cost: 3200, quantity: 2 },
      { line_total: 500, unit_cost: 150, quantity: 1 },
    ];
    expect(saleMargin(items, 500)).toEqual({ revenue: 9000, cost: 6550, profit: 2450 });
  });

  it('reports a loss when sold below cost', () => {
    // Over-discounting should surface as negative profit, not be hidden.
    expect(saleMargin([{ line_total: 1000, unit_cost: 1500, quantity: 1 }], 0).profit).toBe(-500);
  });

  it('treats a missing cost as zero rather than NaN', () => {
    expect(saleMargin([{ line_total: 1000, quantity: 1 }]).profit).toBe(1000);
  });
});

describe('a full basket, end to end', () => {
  it('prices, checks and totals a three-item sale', () => {
    const whey = product();
    const shaker = product({ id: 'p2', name: 'Shaker', price: 500, cost: 150, stock: 40 });
    const pass = product({ id: 'p3', name: 'Day pass', price: 300, cost: 0, track_stock: false, stock: 0 });

    const basket = [[whey, 2], [shaker, 1], [pass, 3]];

    for (const [p, q] of basket) expect(checkStock(p, q).ok).toBe(true);

    const lines = basket.map(([p, q]) => priceLine(p, q));
    expect(lines.map((l) => l.line_total)).toEqual([9000, 500, 900]);

    const totals = basketTotals(lines, 400);
    expect(totals).toEqual({ subtotal: 10400, discount: 400, total: 10000 });

    expect(saleMargin(lines, totals.discount)).toEqual({
      revenue: 10000, cost: 6550, profit: 3450,
    });
  });
});
