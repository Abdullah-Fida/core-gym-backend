/**
 * Core Gym SaaS — Backend API Server
 * Node.js + Express + Supabase
 */

require('dotenv').config();
require('express-async-errors');

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
// express-rate-limit removed for local development

// Routes
const authRoutes = require('./routes/auth.routes');
const gymRoutes = require('./routes/gym.routes');
const membersRoutes = require('./routes/members.routes');
const paymentsRoutes = require('./routes/payments.routes');
const expensesRoutes = require('./routes/expenses.routes');
const staffRoutes = require('./routes/staff.routes');
const attendanceRoutes = require('./routes/attendance.routes');
const notificationsRoutes = require('./routes/notifications.routes');
const adminRoutes = require('./routes/admin.routes');
const analyticsRoutes = require('./routes/analytics.routes');
const draftsRoutes = require('./routes/drafts.routes');

// Middleware
const { errorHandler } = require('./middleware/errorHandler');

const app = express();
const PORT = process.env.PORT || 4000;

// ── Security & Parsing ──────────────
app.use(helmet());
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? [process.env.FRONTEND_URL].filter(Boolean)
    : true,  // Allow ALL origins in development (any device on local network)
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Sanitize Empty Strings to Undefined ────
app.use((req, res, next) => {
  // SKIP sanitization for drafts (we want exact form state)
  if (req.originalUrl.includes('/api/drafts')) return next();

  if (req.body && typeof req.body === 'object') {
    const sanitize = (obj) => {
      for (const key in obj) {
        if (obj[key] === '') obj[key] = undefined;
        else if (obj[key] && typeof obj[key] === 'object') sanitize(obj[key]);
      }
    };
    sanitize(req.body);
  }
  next();
});

// ── Logging ─────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

// Rate limiting removed for local development to avoid 429 responses.

// ── Health Check ─────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0', env: process.env.NODE_ENV });
});

// ── TEMPORARY DIAGNOSTIC — delete once the Supabase connection is confirmed ──
// Reports which Supabase project the running function actually sees. Exposes
// only hostnames, booleans and the JWT's public `ref` claim — never a key.
app.get('/env-check', (req, res) => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // A Supabase key's middle segment is unsigned public JSON: {ref, role, exp}
  let keyRef = null, keyRole = null;
  try {
    const claims = JSON.parse(Buffer.from(key.split('.')[1], 'base64').toString());
    keyRef = claims.ref;
    keyRole = claims.role;
  } catch { /* key absent or malformed */ }

  res.json({
    supabase_url_present: Boolean(url),
    supabase_url_host: url ? new URL(url).host : '(missing — client falls back to http://localhost)',
    supabase_url_has_whitespace: url ? url !== url.trim() : null,
    service_key_present: Boolean(key),
    service_key_project_ref: keyRef,
    service_key_role: keyRole,
    url_and_key_agree: Boolean(url && keyRef && url.includes(keyRef)),
    // If a stale .env shipped in the bundle, dotenv loaded it at boot
    bundled_env_file: require('fs').existsSync(require('path').join(__dirname, '.env')),
    node_env: process.env.NODE_ENV || null,
    deployed_commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null,
    deployed_branch: process.env.VERCEL_GIT_COMMIT_REF || null,
  });
});

// ── API Routes ────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/gym', gymRoutes);
app.use('/api/members', membersRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/expenses', expensesRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/drafts', draftsRoutes);

// ── 404 Handler ───────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found` });
});

// ── Global Error Handler ──────────────
app.use(errorHandler);

// ── Start Server ──────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log('\n╔══════════════════════════════════════╗');
    console.log(`║  🏋️  Core Gym API Server              ║`);
    console.log(`║  🚀  Running at http://localhost:${PORT} ║`);
    console.log(`║  🌍  ENV: ${process.env.NODE_ENV?.padEnd(26)}║`);
    console.log('╚══════════════════════════════════════╝\n');
  });
}

module.exports = app;
