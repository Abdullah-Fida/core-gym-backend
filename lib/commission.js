/**
 * Personal-training commission rules.
 *
 * Two models, and they accrue at different moments:
 *
 *   percent — the trainer earns a share of the sale. The whole amount is
 *             known the instant the package is sold, so it accrues once, on
 *             sale. Logging sessions afterwards must not add more.
 *
 *   flat    — the trainer earns a fixed amount per session delivered. Nothing
 *             is owed at sale time; it accrues session by session.
 *
 * Getting this wrong in either direction is a real payroll error, so the split
 * lives here and is unit-tested rather than being inlined in a route.
 */

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Commission owed at the moment a package is sold.
 * Returns 0 for flat packages — they earn per session instead.
 */
function commissionOnSale({ commission_type, commission_value }, pricePaid) {
  if (commission_type !== 'percent') return 0;

  const pct = Number(commission_value);
  const price = Number(pricePaid);
  if (!Number.isFinite(pct) || !Number.isFinite(price) || pct <= 0 || price <= 0) return 0;

  return round2((price * Math.min(pct, 100)) / 100);
}

/**
 * Commission owed for one delivered session.
 * Returns 0 for percent packages — they were paid in full at sale.
 */
function commissionOnSession({ commission_type, commission_value }) {
  if (commission_type !== 'flat') return 0;

  const value = Number(commission_value);
  if (!Number.isFinite(value) || value <= 0) return 0;

  return round2(value);
}

/**
 * What the trainer will have earned once the package is fully delivered.
 * Used for the "projected" figure on the trainer dashboard.
 */
function projectedTotal(pkg, pricePaid, sessionsTotal) {
  if (pkg.commission_type === 'percent') return commissionOnSale(pkg, pricePaid);
  return round2(commissionOnSession(pkg) * (Number(sessionsTotal) || 0));
}

/** Sessions left on a subscription, never negative. */
function sessionsRemaining(sub) {
  return Math.max(0, (Number(sub.sessions_total) || 0) - (Number(sub.sessions_used) || 0));
}

/**
 * Whether a subscription can still take a session.
 * Expiry is checked as well as the balance — an unused package that has run out
 * of validity is not redeemable.
 */
function canLogSession(sub, now = new Date()) {
  if (!sub) return { ok: false, reason: 'No package found.' };
  if (sub.status === 'cancelled') return { ok: false, reason: 'This package was cancelled.' };
  if (sessionsRemaining(sub) <= 0) return { ok: false, reason: 'No sessions remaining on this package.' };
  if (sub.expires_at && new Date(sub.expires_at) < now) {
    return { ok: false, reason: 'This package has expired.' };
  }
  return { ok: true };
}

/** Status a subscription should hold after a change to its balance or date. */
function deriveSubscriptionStatus(sub, now = new Date()) {
  if (sub.status === 'cancelled') return 'cancelled';
  if (sessionsRemaining(sub) === 0) return 'completed';
  if (sub.expires_at && new Date(sub.expires_at) < now) return 'expired';
  return 'active';
}

module.exports = {
  commissionOnSale,
  commissionOnSession,
  projectedTotal,
  sessionsRemaining,
  canLogSession,
  deriveSubscriptionStatus,
};
