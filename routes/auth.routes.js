const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const { supabase } = require('../db/supabase');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// Password-reset OTPs live in the `password_resets` table (migration 001).
// They used to live in a process-local `new Map()`, which meant every cold
// start wiped them and no two instances agreed — password reset could never
// work on a serverless/multi-instance deploy.
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT || 'support';
const SUSPENDED_MESSAGE = `Your gym access is suspended. Please contact the administrator at ${SUPPORT_CONTACT} for renewal.`;

/** Emails always treated as super admin, regardless of the stored role. */
const superAdminEmails = () =>
  (process.env.SUPER_ADMIN_EMAIL || '')
    .toLowerCase()
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);

const signToken = (payload) =>
  jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });

// ── GET /api/auth/verify ────────────────────
// Used by frontend to proactively check session/suspension
router.get('/verify', authenticate, (req, res) => {
  res.json({ success: true, user: req.user });
});

// NOTE: an unauthenticated GET /reset-super-admin used to live here. It
// upserted coregym@gmail.com with the hardcoded password 'admin123.' and
// plan_type 'pro', so any visitor to that URL received full super admin
// access. Removed. Create admins with scripts/seed-admin.js instead, which
// runs server-side with the service role key and generates a random password.

// ── GET /api/auth/health-check ──────────────
router.get('/health-check', (req, res) => {
  res.json({ success: true, timestamp: new Date().toISOString() });
});

// ── POST /api/auth/login ──────────────────
router.post('/login', async (req, res) => {
  const schema = z.object({ email: z.string().min(1), password: z.string().min(1) });
  const { email, password } = schema.parse(req.body);

  const { data: gym, error } = await supabase
    .from('gyms')
    .select('*, auth_password_hash')
    .eq('email', email.trim().toLowerCase())
    .single();

  if (error || !gym) {
    return res.status(401).json({ success: false, message: 'Invalid email or password' });
  }

  const storedValue = gym.auth_password_hash || '';
  const [actualHash] = storedValue.split('::');
  const valid = await bcrypt.compare(password, actualHash);

  if (!valid) return res.status(401).json({ success: false, message: 'Invalid email or password' });



  const emailClean = email.trim().toLowerCase();

  // Role comes from the gyms.role column — NOT from plan_type. It previously
  // read `gym.plan_type === 'pro' ? 'admin' : 'gym_owner'`, which handed every
  // paying 'pro' customer full super-admin access to every other tenant on the
  // platform. Billing tier and platform role are unrelated concerns.
  const isEnvSuperAdmin = superAdminEmails().includes(emailClean);
  const role = gym.role === 'admin' || isEnvSuperAdmin ? 'admin' : 'gym_owner';

  // Self-heal: an address listed in SUPER_ADMIN_EMAIL gets its row promoted, so
  // the column becomes the single source of truth after the first sign-in.
  if (isEnvSuperAdmin && gym.role !== 'admin') {
    await supabase.from('gyms').update({ role: 'admin' }).eq('id', gym.id);
    gym.role = 'admin';
  }

  if (role === 'gym_owner' && !gym.is_active) {
    return res.status(403).json({ success: false, message: SUSPENDED_MESSAGE });
  }

  const token = signToken({ gym_id: gym.id, email: gym.email, role });

  // Update last_login_at
  await supabase.from('gyms').update({ last_login_at: new Date().toISOString() }).eq('id', gym.id);

  const { auth_password_hash: _pw, ...safeGym } = gym;
  res.json({ success: true, token, role, gym: safeGym });
});

// ── POST /api/auth/register ───────────────
router.post('/register', async (req, res) => {
  const schema = z.object({
    gym_name: z.string().min(2).max(100),
    owner_name: z.string().min(2).max(100),
    phone: z.string().min(10).max(20).optional().or(z.literal('')),
    email: z.string().email().optional().or(z.literal('')),
    password: z.string().min(4).max(100),
    city: z.string().optional().or(z.literal('')),
    address: z.string().optional().or(z.literal('')),
    default_monthly_fee: z.number().min(0).default(3000),
  });
  const body = schema.parse({ ...req.body, default_monthly_fee: Number(req.body.default_monthly_fee) || 3000 });

  // Check duplicate
  if (body.email) {
    const { data: existing } = await supabase.from('gyms').select('id').eq('email', body.email).maybeSingle();
    if (existing) return res.status(409).json({ success: false, message: 'Email already registered' });
  }

  const hash = await bcrypt.hash(body.password, 12);
  // Store only bcrypt hash; do NOT persist plaintext password
  const storedHash = hash;

  const { data: gym, error } = await supabase.from('gyms').insert({
    gym_name: body.gym_name,
    owner_name: body.owner_name,
    phone: body.phone,
    email: body.email?.toLowerCase(),
    city: body.city,
    address: body.address,
    default_monthly_fee: body.default_monthly_fee,
    auth_password_hash: storedHash,
    plan_type: 'free',
    role: 'gym_owner', // self-serve signup never provisions a platform admin
    is_active: true,
    trial_ends_at: new Date(Date.now() + 14 * 86400000).toISOString(),
  }).select().single();

  if (error) throw error;

  const token = signToken({ gym_id: gym.id, email: gym.email, role: 'gym_owner' });
  const { auth_password_hash: _pw, ...safeGym } = gym;
  res.status(201).json({ success: true, token, role: 'gym_owner', gym: safeGym });
});

// ── POST /api/auth/change-password ────────
// `authenticate` is required: this route used to take gym_id straight from the
// request body with no guard, so anyone who learned a gym's id and current
// password could rotate it from an unauthenticated request.
router.post('/change-password', authenticate, async (req, res) => {
  const schema = z.object({
    current_password: z.string().min(1),
    new_password: z.string().min(4).max(100),
  });
  const { current_password, new_password } = schema.parse(req.body);
  const gymId = req.user.gym_id; // from the JWT, never the body

  const { data: gym } = await supabase.from('gyms').select('auth_password_hash').eq('id', gymId).single();
  if (!gym) return res.status(404).json({ success: false, message: 'Gym not found' });

  const storedValue = gym.auth_password_hash || '';
  const [actualHash] = storedValue.split('::');

  const valid = await bcrypt.compare(current_password, actualHash);
  if (!valid) return res.status(401).json({ success: false, message: 'Current password is incorrect' });

  const hash = await bcrypt.hash(new_password, 12);
  await supabase.from('gyms').update({ auth_password_hash: hash }).eq('id', gymId);
  res.json({ success: true, message: 'Password changed successfully' });
});

// ── POST /api/auth/forgot-password ────────
router.post('/forgot-password', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ success: false, message: 'Phone number is required' });

  const { data: gym } = await supabase.from('gyms').select('id').eq('phone', phone).maybeSingle();

  // Always answer the same way. Returning 404 for an unknown number turned this
  // endpoint into a free "is this gym registered?" oracle.
  const genericResponse = {
    success: true,
    message: 'If that number is registered, an OTP has been sent to it.',
  };
  if (!gym) return res.json(genericResponse);

  // Invalidate any outstanding codes for this number, then issue one.
  await supabase
    .from('password_resets')
    .update({ consumed_at: new Date().toISOString() })
    .eq('phone', phone)
    .is('consumed_at', null);

  const otp = String(crypto.randomInt(100000, 1000000));
  const otpHash = await bcrypt.hash(otp, 10);

  const { error } = await supabase.from('password_resets').insert({
    gym_id: gym.id,
    phone,
    otp_hash: otpHash,
    expires_at: new Date(Date.now() + OTP_TTL_MS).toISOString(),
  });
  if (error) throw error;

  // TODO(phase-6): hand this to the messaging layer instead of the console.
  if (process.env.NODE_ENV !== 'production') console.log(`[Auth] OTP for ${phone}: ${otp}`);

  res.json(genericResponse);
});

// ── POST /api/auth/reset-password ─────────
router.post('/reset-password', async (req, res) => {
  const schema = z.object({
    phone: z.string().min(1),
    otp: z.union([z.string(), z.number()]),
    new_password: z.string().min(4).max(100),
  });
  const { phone, otp, new_password } = schema.parse(req.body);

  const { data: reset } = await supabase
    .from('password_resets')
    .select('*')
    .eq('phone', phone)
    .is('consumed_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const invalid = { success: false, message: 'Invalid or expired OTP code' };
  if (!reset) return res.status(400).json(invalid);

  if (reset.attempts >= OTP_MAX_ATTEMPTS) {
    await supabase
      .from('password_resets')
      .update({ consumed_at: new Date().toISOString() })
      .eq('id', reset.id);
    return res.status(429).json({ success: false, message: 'Too many attempts. Request a new code.' });
  }

  const matches = await bcrypt.compare(String(otp), reset.otp_hash);
  if (!matches) {
    await supabase
      .from('password_resets')
      .update({ attempts: reset.attempts + 1 })
      .eq('id', reset.id);
    return res.status(400).json(invalid);
  }

  const hash = await bcrypt.hash(new_password, 12);
  await supabase.from('gyms').update({ auth_password_hash: hash }).eq('id', reset.gym_id);
  await supabase
    .from('password_resets')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', reset.id);

  res.json({ success: true, message: 'Password reset successful' });
});

module.exports = router;
