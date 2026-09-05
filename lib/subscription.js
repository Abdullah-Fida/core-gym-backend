/**
 * Subscription period arithmetic.
 *
 * Extracted so it can be unit-tested. The same "add months or days to a start
 * basis" logic was previously written out four separate times — in POST
 * /admin/gyms, PATCH /admin/gyms/:id, POST /admin/gyms/:id/renew, and again in
 * the frontend's edit modal — and they did not agree: two extended from today,
 * two from the current end date.
 */

const TRIAL_PRESETS = [7, 14, 30];

/**
 * Where a new period should start.
 *
 * Extending a still-valid subscription must add to the existing end date, or a
 * customer renewing early silently loses the days they already paid for. An
 * expired one restarts from now.
 */
function periodStart(currentEnd, now = new Date()) {
  if (!currentEnd) return new Date(now);
  const end = new Date(currentEnd);
  if (Number.isNaN(end.getTime())) return new Date(now);
  return end > now ? end : new Date(now);
}

/**
 * Add a duration to a date.
 *
 * `unit` is 'month' or 'day'. Month arithmetic clamps to the end of shorter
 * months: adding 1 month to Jan 31 gives Feb 28/29, not Mar 3, which is what
 * bare setMonth() produces.
 */
function addPeriod(from, amount, unit = 'month') {
  const result = new Date(from);
  const n = Number(amount);
  if (!Number.isFinite(n) || n === 0) return result;

  if (unit === 'day') {
    result.setDate(result.getDate() + n);
    return result;
  }

  const targetDay = result.getDate();
  result.setDate(1);
  result.setMonth(result.getMonth() + n);
  const lastDayOfTargetMonth = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(targetDay, lastDayOfTargetMonth));
  return result;
}

/**
 * Resolve a duration selection into an end date.
 *
 * Accepts either { months } or { days }; `days` wins if both are supplied.
 * Returns null when neither is a usable number, so callers can reject rather
 * than persisting an Invalid Date (the renew endpoint used to send NaN when the
 * "custom days" option was picked with no value).
 */
function resolveEndDate({ startFrom, months, days }, now = new Date()) {
  const start = periodStart(startFrom, now);

  const dayCount = Number(days);
  if (Number.isFinite(dayCount) && dayCount > 0) {
    return addPeriod(start, dayCount, 'day');
  }

  const monthCount = Number(months);
  if (Number.isFinite(monthCount) && monthCount > 0) {
    return addPeriod(start, monthCount, 'month');
  }

  return null;
}

/**
 * The gym's billing state, derived from its dates.
 *
 * Single source of truth — the alerts endpoint, the metrics endpoint and the
 * login guard each had their own slightly different expiry comparison.
 */
function deriveBillingStatus(gym, now = new Date()) {
  if (gym.is_active === false) return 'suspended';

  const trialEnd = gym.trial_ends_at ? new Date(gym.trial_ends_at) : null;
  if (trialEnd && trialEnd > now) return 'trialing';

  const subEnd = gym.subscription_ends_at ? new Date(gym.subscription_ends_at) : null;
  if (subEnd && subEnd < now) return 'past_due';

  return 'active';
}

/** Whole days until a date; negative once past. */
function daysUntil(date, now = new Date()) {
  if (!date) return null;
  const target = new Date(date);
  if (Number.isNaN(target.getTime())) return null;
  return Math.ceil((target - now) / 86400000);
}

module.exports = {
  TRIAL_PRESETS,
  periodStart,
  addPeriod,
  resolveEndDate,
  deriveBillingStatus,
  daysUntil,
};
