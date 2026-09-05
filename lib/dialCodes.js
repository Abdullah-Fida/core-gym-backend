/**
 * Timezone → international dial code.
 *
 * Migration 005 backfilled this for gyms that already existed, but the create
 * endpoint never set it, so every newly created gym fell back to the column
 * default of '92'. A gym in New York got its members' numbers rewritten to
 * +92… and messages went to strangers in Pakistan.
 *
 * Kept as a lookup rather than a library: the full IANA-to-country mapping is
 * large, and only the zones the product actually offers need covering.
 */

const BY_ZONE = {
  'Asia/Karachi': '92',
  'Asia/Kolkata': '91',
  'Asia/Dhaka': '880',
  'Asia/Dubai': '971',
  'Asia/Riyadh': '966',
  'Asia/Kuala_Lumpur': '60',
  'Asia/Singapore': '65',
  'Asia/Jakarta': '62',
  'Asia/Manila': '63',
  'Asia/Tokyo': '81',
  'Europe/London': '44',
  'Europe/Dublin': '353',
  'Europe/Berlin': '49',
  'Europe/Paris': '33',
  'Europe/Madrid': '34',
  'Europe/Rome': '39',
  'Europe/Istanbul': '90',
  'Europe/Moscow': '7',
  'America/New_York': '1',
  'America/Chicago': '1',
  'America/Denver': '1',
  'America/Los_Angeles': '1',
  'America/Toronto': '1',
  'America/Vancouver': '1',
  'America/Mexico_City': '52',
  'America/Sao_Paulo': '55',
  'Africa/Lagos': '234',
  'Africa/Cairo': '20',
  'Africa/Nairobi': '254',
  'Africa/Johannesburg': '27',
  'Australia/Sydney': '61',
  'Australia/Melbourne': '61',
  'Australia/Perth': '61',
  'Pacific/Auckland': '64',
};

/** Broad fallback when the exact zone is not listed. */
const BY_REGION = {
  America: '1',
  Australia: '61',
  Europe: '44',
};

/**
 * Dial code for an IANA timezone.
 *
 * Returns null rather than guessing '92' when nothing matches, so the caller
 * decides the fallback explicitly instead of silently inheriting Pakistan.
 */
function dialCodeForTimezone(timezone) {
  if (!timezone) return null;
  if (BY_ZONE[timezone]) return BY_ZONE[timezone];

  const region = String(timezone).split('/')[0];
  return BY_REGION[region] ?? null;
}

module.exports = { dialCodeForTimezone, DIAL_CODES_BY_ZONE: BY_ZONE };
