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
