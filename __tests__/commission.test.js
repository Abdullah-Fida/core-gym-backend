const {
  commissionOnSale,
  commissionOnSession,
  projectedTotal,
  sessionsRemaining,
  canLogSession,
  deriveSubscriptionStatus,
} = require('../lib/commission');

const PERCENT_20 = { commission_type: 'percent', commission_value: 20 };
const FLAT_500 = { commission_type: 'flat', commission_value: 500 };

describe('commissionOnSale', () => {
  it('takes the percentage of the price actually paid', () => {
    // The scenario from the plan: a 12-session package at 20%.
    expect(commissionOnSale(PERCENT_20, 12000)).toBe(2400);
  });

  it('uses the discounted price, not the list price', () => {
    expect(commissionOnSale(PERCENT_20, 10000)).toBe(2000);
  });

  it('pays nothing at sale time for a flat package', () => {
    // Flat packages earn per session; paying at sale as well would double-pay.
    expect(commissionOnSale(FLAT_500, 12000)).toBe(0);
  });

  it('rounds to two decimal places', () => {
    expect(commissionOnSale({ commission_type: 'percent', commission_value: 7.5 }, 3333)).toBe(249.98);
  });

  it('returns 0 for junk input rather than NaN', () => {
    expect(commissionOnSale(PERCENT_20, undefined)).toBe(0);
    expect(commissionOnSale(PERCENT_20, 'abc')).toBe(0);
    expect(commissionOnSale({ commission_type: 'percent', commission_value: 0 }, 5000)).toBe(0);
    expect(commissionOnSale(PERCENT_20, -100)).toBe(0);
  });

  it('clamps a percentage above 100', () => {
    expect(commissionOnSale({ commission_type: 'percent', commission_value: 150 }, 1000)).toBe(1000);
  });
});

describe('commissionOnSession', () => {
  it('pays the flat amount per session', () => {
    expect(commissionOnSession(FLAT_500)).toBe(500);
  });

  it('pays nothing per session for a percent package', () => {
    // Already fully earned at sale.
    expect(commissionOnSession(PERCENT_20)).toBe(0);
  });

  it('returns 0 for junk input', () => {
    expect(commissionOnSession({ commission_type: 'flat', commission_value: -5 })).toBe(0);
    expect(commissionOnSession({})).toBe(0);
  });
});

describe('projectedTotal', () => {
  it('matches the sale commission for a percent package regardless of sessions', () => {
    expect(projectedTotal(PERCENT_20, 12000, 12)).toBe(2400);
  });

  it('multiplies out for a flat package', () => {
    expect(projectedTotal(FLAT_500, 12000, 12)).toBe(6000);
  });
});

describe('sessionsRemaining', () => {
  it('subtracts used from total', () => {
    // The plan's check: 12 bought, 3 logged, 9 left.
    expect(sessionsRemaining({ sessions_total: 12, sessions_used: 3 })).toBe(9);
  });

  it('never goes negative', () => {
    expect(sessionsRemaining({ sessions_total: 5, sessions_used: 9 })).toBe(0);
  });

  it('treats missing values as zero', () => {
    expect(sessionsRemaining({})).toBe(0);
  });
});

describe('canLogSession', () => {
  const now = new Date('2026-06-15T00:00:00Z');
  const base = { sessions_total: 12, sessions_used: 3, expires_at: '2026-09-01T00:00:00Z', status: 'active' };

  it('allows a session with balance and validity remaining', () => {
    expect(canLogSession(base, now).ok).toBe(true);
  });

  it('refuses when the balance is spent', () => {
    const r = canLogSession({ ...base, sessions_used: 12 }, now);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no sessions remaining/i);
  });

  it('refuses an expired package even with sessions left', () => {
    // An unused package past its validity is not redeemable.
    const r = canLogSession({ ...base, expires_at: '2026-01-01T00:00:00Z' }, now);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/expired/i);
  });

  it('refuses a cancelled package', () => {
    expect(canLogSession({ ...base, status: 'cancelled' }, now).ok).toBe(false);
  });

  it('refuses when there is no subscription at all', () => {
    expect(canLogSession(null, now).ok).toBe(false);
  });
});

describe('deriveSubscriptionStatus', () => {
  const now = new Date('2026-06-15T00:00:00Z');

  it('completes once every session is used', () => {
    expect(deriveSubscriptionStatus(
      { sessions_total: 12, sessions_used: 12, expires_at: '2026-09-01', status: 'active' }, now
    )).toBe('completed');
  });

  it('stays active with sessions left and validity remaining', () => {
    expect(deriveSubscriptionStatus(
      { sessions_total: 12, sessions_used: 3, expires_at: '2026-09-01', status: 'active' }, now
    )).toBe('active');
  });

  it('expires when past validity with sessions unused', () => {
    expect(deriveSubscriptionStatus(
      { sessions_total: 12, sessions_used: 3, expires_at: '2026-01-01', status: 'active' }, now
    )).toBe('expired');
  });

  it('completion wins over expiry', () => {
    // Fully delivered, so the trainer earned it — not a lapsed package.
    expect(deriveSubscriptionStatus(
      { sessions_total: 12, sessions_used: 12, expires_at: '2026-01-01', status: 'active' }, now
    )).toBe('completed');
  });

  it('a cancelled package stays cancelled', () => {
    expect(deriveSubscriptionStatus(
      { sessions_total: 12, sessions_used: 0, expires_at: '2026-09-01', status: 'cancelled' }, now
    )).toBe('cancelled');
  });
});

describe('the plan scenario, end to end', () => {
  it('12 sessions at 20% of 12000, 3 logged: 9 left, 2400 earned once', () => {
    const pkg = { ...PERCENT_20, sessions_total: 12, price: 12000 };
    const sub = { sessions_total: 12, sessions_used: 0, expires_at: '2026-12-01', status: 'active' };

    const atSale = commissionOnSale(pkg, 12000);
    expect(atSale).toBe(2400);

    let used = 0;
    let perSessionTotal = 0;
    for (let i = 0; i < 3; i += 1) {
      expect(canLogSession({ ...sub, sessions_used: used }, new Date('2026-06-15')).ok).toBe(true);
      used += 1;
      perSessionTotal += commissionOnSession(pkg);
    }

    expect(sessionsRemaining({ sessions_total: 12, sessions_used: used })).toBe(9);
    // Percent packages must not accrue again per session.
    expect(perSessionTotal).toBe(0);
    expect(atSale + perSessionTotal).toBe(2400);
  });
});
