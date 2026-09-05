const {
  periodStart,
  addPeriod,
  resolveEndDate,
  deriveBillingStatus,
  daysUntil,
} = require('../lib/subscription');

describe('periodStart', () => {
  const now = new Date('2026-06-15T12:00:00Z');

  it('extends from the existing end date when the subscription is still valid', () => {
    // Renewing early must not forfeit days already paid for.
    expect(periodStart('2026-08-01T00:00:00Z', now).toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('restarts from now when the subscription has lapsed', () => {
    expect(periodStart('2026-01-01T00:00:00Z', now).getTime()).toBe(now.getTime());
  });

  it('falls back to now for a missing or unparseable date', () => {
    expect(periodStart(null, now).getTime()).toBe(now.getTime());
    expect(periodStart('not-a-date', now).getTime()).toBe(now.getTime());
  });
});

describe('addPeriod', () => {
  it('adds whole months', () => {
    expect(addPeriod(new Date('2026-01-15T00:00:00Z'), 3).toISOString().slice(0, 10)).toBe('2026-04-15');
  });

  it('clamps to the end of a shorter month instead of overflowing', () => {
    // Bare setMonth() turns Jan 31 + 1 month into Mar 3.
    const result = addPeriod(new Date('2026-01-31T00:00:00Z'), 1);
    expect(result.toISOString().slice(0, 10)).toBe('2026-02-28');
  });

  it('handles a leap year', () => {
    const result = addPeriod(new Date('2028-01-31T00:00:00Z'), 1);
    expect(result.toISOString().slice(0, 10)).toBe('2028-02-29');
  });

  it('adds days', () => {
    expect(addPeriod(new Date('2026-06-15T00:00:00Z'), 14, 'day').toISOString().slice(0, 10)).toBe('2026-06-29');
  });

  it('is a no-op for a non-numeric amount', () => {
    const from = new Date('2026-06-15T00:00:00Z');
    expect(addPeriod(from, undefined).getTime()).toBe(from.getTime());
  });
});

describe('resolveEndDate', () => {
  const now = new Date('2026-06-15T00:00:00Z');

  it('prefers days over months when both are supplied', () => {
    const end = resolveEndDate({ startFrom: null, months: 6, days: 7 }, now);
    expect(end.toISOString().slice(0, 10)).toBe('2026-06-22');
  });

  it('returns null when neither is usable, rather than an Invalid Date', () => {
    // The renew endpoint used to send NaN here when "custom days" was picked
    // with no value, silently writing an invalid subscription end.
    expect(resolveEndDate({ startFrom: null }, now)).toBeNull();
    expect(resolveEndDate({ startFrom: null, days: NaN }, now)).toBeNull();
    expect(resolveEndDate({ startFrom: null, months: 0 }, now)).toBeNull();
    expect(resolveEndDate({ startFrom: null, days: 'abc' }, now)).toBeNull();
  });

  it('stacks onto a future end date', () => {
    const end = resolveEndDate({ startFrom: '2026-09-01T00:00:00Z', months: 1 }, now);
    expect(end.toISOString().slice(0, 10)).toBe('2026-10-01');
  });
});

describe('deriveBillingStatus', () => {
  const now = new Date('2026-06-15T00:00:00Z');

  it('reports suspended regardless of dates', () => {
    expect(deriveBillingStatus({ is_active: false, subscription_ends_at: '2027-01-01' }, now)).toBe('suspended');
  });

  it('reports trialing while the trial is running', () => {
    expect(deriveBillingStatus({ is_active: true, trial_ends_at: '2026-07-01' }, now)).toBe('trialing');
  });

  it('does not report trialing once the trial has passed', () => {
    expect(deriveBillingStatus(
      { is_active: true, trial_ends_at: '2026-01-01', subscription_ends_at: '2027-01-01' },
      now
    )).toBe('active');
  });

  it('reports past_due once the period has lapsed', () => {
    expect(deriveBillingStatus({ is_active: true, subscription_ends_at: '2026-01-01' }, now)).toBe('past_due');
  });

  it('reports active with no dates at all', () => {
    expect(deriveBillingStatus({ is_active: true }, now)).toBe('active');
  });
});

describe('daysUntil', () => {
  const now = new Date('2026-06-15T00:00:00Z');

  it('counts forward', () => {
    expect(daysUntil('2026-06-22T00:00:00Z', now)).toBe(7);
  });

  it('goes negative once past', () => {
    expect(daysUntil('2026-06-10T00:00:00Z', now)).toBe(-5);
  });

  it('returns null for missing or invalid input', () => {
    expect(daysUntil(null, now)).toBeNull();
    expect(daysUntil('nope', now)).toBeNull();
  });
});
