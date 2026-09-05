const { supabase } = require('../../db/supabase');
const { normalisePhone, isSendable, renderTemplate, buildWaLink } = require('./render');

/**
 * Messaging provider abstraction.
 *
 *   walink  — builds a wa.me link the owner taps. No automation, no ban risk.
 *             This is the default and the fallback for everything else.
 *   baileys — hands the message to the wa-worker process, which holds the
 *             WhatsApp Web socket. Falls back to walink when no session is live.
 *   noop    — messaging switched off.
 *
 * Every provider writes to `message_log`, so the owner can see what was sent
 * regardless of how it went out.
 */

const WORKER_URL = process.env.WA_WORKER_URL;
const WORKER_TOKEN = process.env.WA_WORKER_TOKEN;

async function logMessage(row) {
  const { data, error } = await supabase.from('message_log').insert(row).select().single();
  if (error) {
    // A duplicate is the daily-dedupe index doing its job, not a failure.
    if (error.code === '23505') return { duplicate: true };
    console.error('[messaging] could not write message_log:', error.message);
    return { error };
  }
  return { data };
}

/** How many automated messages this gym has already sent today. */
async function sentToday(gymId) {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const { count } = await supabase
    .from('message_log')
    .select('id', { count: 'exact', head: true })
    .eq('gym_id', gymId)
    .in('status', ['sent', 'delivered'])
    .gte('queued_at', since.toISOString());
  return count || 0;
}

const providers = {
  noop: {
    async send({ gym, log }) {
      await logMessage({ ...log, provider: 'noop', status: 'skipped_cap', error: 'Messaging is disabled.' });
      return { ok: false, reason: 'Messaging is disabled for this gym.' };
    },
  },

  walink: {
    async send({ gym, phone, body, log }) {
      const link = buildWaLink(phone, body, gym.country_code);
      if (!link) {
        await logMessage({ ...log, provider: 'walink', status: 'failed', error: 'Unusable phone number.' });
        return { ok: false, reason: 'That phone number could not be read.' };
      }
      // Nothing is sent server-side; the owner opens the link. Recorded as
      // fallback_link so the log does not overstate what happened.
      await logMessage({ ...log, provider: 'walink', status: 'fallback_link' });
      return { ok: true, link, mode: 'link' };
    },
  },

  baileys: {
    async send({ gym, phone, body, log }) {
      if (!WORKER_URL) return providers.walink.send({ gym, phone, body, log });

      // Respect the daily cap before touching the socket. WhatsApp bans numbers
      // that send in bulk, and the cap is the main defence.
      const used = await sentToday(gym.id);
      if (used >= (gym.wa_daily_cap ?? 200)) {
        await logMessage({
          ...log, provider: 'baileys', status: 'skipped_cap',
          error: `Daily cap of ${gym.wa_daily_cap} reached.`,
        });
        return { ok: false, reason: `Daily send cap reached (${gym.wa_daily_cap}).` };
      }

      const to = normalisePhone(phone, gym.country_code);
      if (!isSendable(to)) {
        await logMessage({ ...log, provider: 'baileys', status: 'failed', error: 'Unusable phone number.' });
        return { ok: false, reason: 'That phone number could not be read.' };
      }

      try {
        const res = await fetch(`${WORKER_URL}/send`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${WORKER_TOKEN}`,
          },
          body: JSON.stringify({ gym_id: gym.id, to, text: body }),
          signal: AbortSignal.timeout(15000),
        });

        const payload = await res.json().catch(() => ({}));

        if (!res.ok || !payload.success) {
          // A dead or unpaired session must not silently drop the message —
          // fall back to a link so the owner can still reach the member.
          return providers.walink.send({ gym, phone, body, log });
        }

        await logMessage({ ...log, provider: 'baileys', status: 'sent', sent_at: new Date().toISOString() });
        return { ok: true, mode: 'automated' };
      } catch (err) {
        console.error('[messaging] worker unreachable:', err.message);
        return providers.walink.send({ gym, phone, body, log });
      }
    },
  },
};

/**
 * Send one message through whichever provider the gym has configured.
 *
 * `event` and `memberId` are what the daily-dedupe index keys on, so an
 * automation that runs twice in a day only reaches the member once.
 */
async function sendMessage({ gym, member, phone, body, event = null, templateId = null }) {
  const provider = providers[gym.messaging_provider] || providers.walink;

  const log = {
    gym_id: gym.id,
    member_id: member?.id ?? null,
    template_id: templateId,
    event,
    to_phone: String(phone ?? ''),
    body,
  };

  return provider.send({ gym, member, phone, body, log });
}

module.exports = {
  sendMessage,
  sentToday,
  normalisePhone,
  isSendable,
  renderTemplate,
  buildWaLink,
  PROVIDERS: Object.keys(providers),
};
