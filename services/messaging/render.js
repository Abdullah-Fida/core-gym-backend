/**
 * Phone normalisation and template rendering.
 *
 * Shared by the API and the WhatsApp worker so a message rendered for the
 * preview is byte-identical to the one actually sent.
 */

/**
 * Normalise a local number to international format (digits only, no +).
 *
 * The previous client-side helper hardcoded Pakistan: any 10-digit number was
 * prefixed with 92, so after the product went international a US number like
 * 5551234567 became 925551234567 and the message went to a stranger. The dial
 * code now comes from the gym.
 */
function normalisePhone(raw, dialCode = '92') {
  let digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return null;

  const cc = String(dialCode).replace(/\D/g, '') || '92';

  // Already international.
  if (digits.startsWith(cc) && digits.length > cc.length + 6) return digits;

  // Trunk prefix: most countries write local numbers with a leading 0.
  if (digits.startsWith('0')) digits = digits.slice(1);

  // A number that already carries some other country's code is left alone —
  // rewriting it would silently redirect the message.
  if (digits.length >= 11 && !digits.startsWith(cc)) return digits;

  return cc + digits;
}

/** True when a normalised number is long enough to plausibly be real. */
function isSendable(phone) {
  return Boolean(phone) && phone.length >= 8 && phone.length <= 15;
}

/**
 * Fill the placeholder tokens.
 *
 * Keeps the existing `[Name]` / `[GymName]` / `[Days]` / `[Amount]` / `[Phone]`
 * vocabulary the gym-facing templates already use, so nobody's saved messages
 * break, and adds `[ExpiryDate]` for the reminder automations.
 */
function renderTemplate(template, { member = {}, gym = {}, days, amount, expiryDate } = {}) {
  if (!template) return '';

  const money = (value) => {
    const n = Number(value ?? 0);
    try {
      return new Intl.NumberFormat(gym.locale || 'en-US', {
        style: 'currency',
        currency: gym.currency || 'PKR',
        minimumFractionDigits: 0,
        maximumFractionDigits: n % 1 === 0 ? 0 : 2,
      }).format(n);
    } catch {
      return `${gym.currency || 'PKR'} ${n.toLocaleString()}`;
    }
  };

  const dayValue = days !== undefined && days !== null ? String(Math.abs(days)) : '0';

  const formattedExpiry = expiryDate
    ? new Date(expiryDate).toLocaleDateString(gym.locale || 'en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
    })
    : '';

  return String(template)
    .replace(/\[Name\]/gi, member.name || '')
    .replace(/\[GymName\]/gi, gym.gym_name || '')
    .replace(/\[Days\]/gi, dayValue)
    .replace(/\[Amount\]/gi, money(amount ?? gym.default_monthly_fee))
    .replace(/\[Phone\]/gi, gym.phone || '')
    .replace(/\[ExpiryDate\]/gi, formattedExpiry)
    .trim();
}

/** Click-to-send link, the no-risk fallback for every provider. */
function buildWaLink(phone, message, dialCode) {
  const normalised = normalisePhone(phone, dialCode);
  if (!normalised) return null;
  return `https://wa.me/${normalised}?text=${encodeURIComponent(message)}`;
}

module.exports = { normalisePhone, isSendable, renderTemplate, buildWaLink };
