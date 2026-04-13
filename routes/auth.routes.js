const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const { supabase } = require('../db/supabase');

const router = express.Router();
const ADMIN_EMAILS = (process.env.SUPER_ADMIN_EMAIL || 'wahabwaqas345@gmail.com').toLowerCase().split(',').map(e => e.trim());

// Simple in-memory OTP store for password resets (expires in 10 minutes).
// Note: ephemeral and not suitable for multi-instance production.
const otps = new Map();

const signToken = (payload) =>
  jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });

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
    .eq('email', email.toLowerCase())
    .single();

  if (error || !gym) {
    return res.status(401).json({ success: false, message: 'Invalid email or password' });
  }

  const storedValue = gym.auth_password_hash || '';
  const [actualHash] = storedValue.split('::');
  const valid = await bcrypt.compare(password, actualHash);
  
  if (!valid) return res.status(401).json({ success: false, message: 'Invalid email or password' });
  
  // Proactive Suspension Check
  const now = new Date();
  const isExpired = gym.subscription_ends_at && new Date(gym.subscription_ends_at) < now;
  if (isExpired && gym.is_active) {
    await supabase.from('gyms').update({ is_active: false }).eq('id', gym.id);
    gym.is_active = false;
  }

  const role = ADMIN_EMAILS.includes(email.toLowerCase()) ? 'admin' : 'gym_owner';
  
  if (role === 'gym_owner' && !gym.is_active) {
    return res.status(403).json({ 
      success: false, 
      message: 'Your gym access is suspended. Please contact the administrator for renewal.' 
    });
  }

  const token = signToken({ gym_id: gym.id, email: gym.email, role });

  // Update last_login_at
  await supabase.from('gyms').update({ last_login_at: new Date().toISOString() }).eq('id', gym.id);

  const { auth_password_hash, ...safeGym } = gym;
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
    is_active: true,
    trial_ends_at: new Date(Date.now() + 14 * 86400000).toISOString(),
  }).select().single();

  if (error) throw error;

  const token = signToken({ gym_id: gym.id, email: gym.email, role: 'gym_owner' });
  const { auth_password_hash, ...safeGym } = gym;
  res.status(201).json({ success: true, token, role: 'gym_owner', gym: safeGym });
});

// ── POST /api/auth/change-password ────────
router.post('/change-password', async (req, res) => {
  const { gym_id, current_password, new_password } = req.body;
  const { data: gym } = await supabase.from('gyms').select('auth_password_hash').eq('id', gym_id).single();
  if (!gym) return res.status(404).json({ success: false, message: 'Gym not found' });

  const storedValue = gym.auth_password_hash || '';
  const [actualHash] = storedValue.split('::');
  
  const valid = await bcrypt.compare(current_password, actualHash);
  if (!valid) return res.status(401).json({ success: false, message: 'Current password is incorrect' });

  const hash = await bcrypt.hash(new_password, 12);
  const storedHash = hash;
  await supabase.from('gyms').update({ auth_password_hash: storedHash }).eq('id', gym_id);
  res.json({ success: true, message: 'Password changed successfully' });
});

// ── POST /api/auth/forgot-password ────────
router.post('/forgot-password', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ success: false, message: 'Phone number is required' });

  const { data: gym } = await supabase.from('gyms').select('id').eq('phone', phone).maybeSingle();
  if (!gym) return res.status(404).json({ success: false, message: 'Phone number not registered' });

  // Generate a 6-digit OTP and store it in-memory for a short time.
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  otps.set(phone, { otp, expiresAt: Date.now() + 10 * 60 * 1000 });
  // Log OTP to server logs for development/testing. Do NOT return OTP in API response.
  if (process.env.NODE_ENV !== 'production') console.log(`[Auth] OTP for ${phone}: ${otp}`);

  res.json({ success: true, message: 'OTP sent to your phone' });
});

// ── POST /api/auth/reset-password ─────────
router.post('/reset-password', async (req, res) => {
  const { phone, otp, new_password } = req.body;
  if (!phone || !otp || !new_password) return res.status(400).json({ success: false, message: 'Missing fields' });

  // Validate OTP from in-memory store
  const rec = otps.get(phone);
  if (!rec || rec.otp !== String(otp) || rec.expiresAt < Date.now()) {
    return res.status(400).json({ success: false, message: 'Invalid or expired OTP code' });
  }
  // Consume OTP
  otps.delete(phone);

  const { data: gym } = await supabase.from('gyms').select('id').eq('phone', phone).single();
  if (!gym) return res.status(404).json({ success: false, message: 'Gym not found' });

  const hash = await bcrypt.hash(new_password, 12);
  const storedHash = hash;
  await supabase.from('gyms').update({ auth_password_hash: storedHash }).eq('id', gym.id);
  res.json({ success: true, message: 'Password reset successful' });
});

module.exports = router;
