/**
 * Batgos — Backend API Server
 * Node.js + Express + Supabase
 */

require('dotenv').config();
require('express-async-errors');

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

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
const plansRoutes = require('./routes/plans.routes');
const trainersRoutes = require('./routes/trainers.routes');
const importRoutes = require('./routes/import.routes');
const messagingRoutes = require('./routes/messaging.routes');
const classesRoutes = require('./routes/classes.routes');
const leadsRoutes = require('./routes/leads.routes');
const posRoutes = require('./routes/pos.routes');
const measurementsRoutes = require('./routes/measurements.routes');
const analyticsRoutes = require('./routes/analytics.routes');
const draftsRoutes = require('./routes/drafts.routes');

// Middleware
const { errorHandler } = require('./middleware/errorHandler');

const app = express();
const PORT = process.env.PORT || 4000;

// ── Security & Parsing ──────────────
app.use(helmet());
// Dev allows LAN origins so you can test on a phone; it no longer reflects
// *any* origin back, which combined with credentials:true let any website
// script call this API with a logged-in browser's credentials.
const LAN_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3})(:\d+)?$/;
const allowedOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true); // curl, server-to-server, health checks
    if (allowedOrigins.includes(origin)) return callback(null, true);
    if (process.env.NODE_ENV !== 'production' && LAN_ORIGIN.test(origin)) return callback(null, true);
    return callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
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

// ── Rate Limiting ───────────────────
// Was disabled entirely ("removed for local development"), leaving /api/auth
// open to unlimited credential stuffing and OTP brute force.
const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
const limiterOpts = { windowMs, standardHeaders: true, legacyHeaders: false };

if (process.env.NODE_ENV !== 'test') {
  // Tight bucket on credential endpoints, generous bucket everywhere else.
  app.use('/api/auth/login', rateLimit({ ...limiterOpts, max: 10 }));
  app.use('/api/auth/forgot-password', rateLimit({ ...limiterOpts, max: 5 }));
  app.use('/api/auth/reset-password', rateLimit({ ...limiterOpts, max: 10 }));
  app.use('/api/auth/register', rateLimit({ ...limiterOpts, max: 5 }));
  app.use('/api', rateLimit({ ...limiterOpts, max: Number(process.env.RATE_LIMIT_MAX) || 1000 }));
}

// ── Health Check ─────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0', env: process.env.NODE_ENV });
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
app.use('/api/trainers', trainersRoutes);
app.use('/api/import', importRoutes);
app.use('/api/messaging', messagingRoutes);
app.use('/api/classes', classesRoutes);
app.use('/api/leads', leadsRoutes);
app.use('/api/pos', posRoutes);
app.use('/api/measurements', measurementsRoutes);
app.use('/api/admin/plans', plansRoutes);
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
    console.log(`║  🏋️  Batgos API Server                ║`);
    console.log(`║  🚀  Running at http://localhost:${PORT} ║`);
    console.log(`║  🌍  ENV: ${process.env.NODE_ENV?.padEnd(26)}║`);
    console.log('╚══════════════════════════════════════╝\n');
  });
}

module.exports = app;
